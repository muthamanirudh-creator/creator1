"""
Embedding engine — the single place where text becomes vectors.

Why this module exists
----------------------
matcher.py used to import sentence-transformers inside a bare ``try/except`` and, on ANY failure (package not
installed, model not downloaded, out of memory), silently switched to a hashed bag-of-words "embedding". The
Career Fit tab then reported a "semantic" match that was really literal token overlap. This module replaces that:

  * The real model (a transformer loaded through ``sentence-transformers`` / ``transformers`` + ``torch``) is the
    only engine by default. It is loaded once, lazily or in the background at start-up, and shared by every
    request (thread-safe).
  * If it cannot be loaded the engine is in the ``error`` state and every semantic call raises
    ``EmbeddingUnavailable`` with an actionable message - the API turns that into HTTP 503
    ``EMBEDDING_MODEL_UNAVAILABLE``. Nothing pretends to be semantic.
  * ``ALLOW_LEXICAL_FALLBACK=true`` is an explicit, opt-in escape hatch for hosts that cannot run torch. Every
    status/response then carries ``fallback_mode: true`` and ``engine: "lexical-hash"``.
  * After loading, a tiny self-test checks the model really ranks a paraphrase above an unrelated phrase, so a
    corrupt/mismatched model directory is reported instead of producing plausible-looking nonsense.
  * Batch encoding with an LRU vector cache: a live "as you type" panel re-embeds only what changed.

Vectors are always float32, L2-normalised, so cosine similarity is a plain dot product.
"""
from __future__ import annotations

import hashlib
import logging
import math
import re
import threading
import time
from collections import OrderedDict
from typing import Callable, Iterable, Optional, Sequence

import numpy as np

from app.config import get_settings

logger = logging.getLogger("ai_ml_service.embeddings")

CODE_UNAVAILABLE = "EMBEDDING_MODEL_UNAVAILABLE"


class EmbeddingUnavailable(RuntimeError):
    """The transformer embedding model is not usable right now. ``code`` is stable for API consumers."""

    code = CODE_UNAVAILABLE

    def __init__(self, message: str, *, state: str = "error", retryable: bool = True):
        super().__init__(message)
        self.state = state
        self.retryable = retryable


# Self-test triplet: (anchor, paraphrase, unrelated). A working semantic model ranks the paraphrase higher.
_SELF_TEST = ("react frontend developer", "building user interfaces with javascript components", "baking sourdough bread")

_TOKEN_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9+.#]{1,}")


def _pick_device(preference: str) -> str:
    if preference and preference != "auto":
        return preference
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            return "cuda"
        mps = getattr(getattr(torch, "backends", None), "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
    except Exception:  # noqa: BLE001 - torch missing is reported by the loader, not here
        pass
    return "cpu"


class _LexicalEncoder:
    """Emergency, opt-in only (ALLOW_LEXICAL_FALLBACK=true). Signed-hash TF vectors over unigrams + bigrams.
    It measures shared WORDS, not meaning; callers must surface ``fallback_mode``."""

    name = "lexical-hash"

    def __init__(self, dim: int):
        self.dim = dim

    def encode(self, texts: Sequence[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for row, text in enumerate(texts):
            toks = [t for t in _TOKEN_RE.findall((text or "").lower()) if len(t) > 1]
            toks += [f"{a}::{b}" for a, b in zip(toks, toks[1:])]
            counts: dict[str, int] = {}
            for t in toks:
                counts[t] = counts.get(t, 0) + 1
            for tok, count in counts.items():
                h = int(hashlib.sha256(tok.encode()).hexdigest(), 16)
                out[row, h % self.dim] += (-1.0 if (h >> 13) & 1 else 1.0) * (1.0 + math.log(float(count)))
        return _normalize(out)


def _normalize(m: np.ndarray) -> np.ndarray:
    m = np.asarray(m, dtype=np.float32)
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return m / norms


class EmbeddingEngine:
    """Thread-safe, lazily/background-loaded sentence-embedding engine with an LRU vector cache."""

    def __init__(self):
        self._lock = threading.RLock()
        self._ready_event = threading.Event()
        self._cache: "OrderedDict[str, np.ndarray]" = OrderedDict()
        self._cache_hits = 0
        self._cache_misses = 0
        self._reset_state()

    # ------------------------------------------------------------------ state
    def _reset_state(self):
        self.state = "idle"            # idle | loading | ready | error
        self.error: Optional[str] = None
        self.error_code: Optional[str] = None
        self.model_name = ""
        self.device = ""
        self.dim = 0
        self.engine_kind = ""          # sentence-transformers | lexical-hash | injected
        self.fallback_mode = False
        self.loaded_at: Optional[float] = None
        self.load_seconds: Optional[float] = None
        self.self_test: Optional[dict] = None
        self._encoder = None           # object with .encode(list[str]) -> np.ndarray
        self._loader_thread: Optional[threading.Thread] = None
        self._load_started_at = 0.0
        self._ready_event.clear()
        self._cache.clear()

    @property
    def is_ready(self) -> bool:
        return self.state == "ready" and self._encoder is not None

    # ---------------------------------------------------------------- loading
    def start_background_load(self) -> None:
        """Begin loading without blocking (used from the FastAPI lifespan). Idempotent."""
        with self._lock:
            if self.state in ("loading", "ready") or (self._loader_thread and self._loader_thread.is_alive()):
                return
            self.state = "loading"
            self._loader_thread = threading.Thread(target=self._load, name="embedding-loader", daemon=True)
            self._loader_thread.start()

    def ensure_ready(self, timeout: Optional[float] = None) -> "EmbeddingEngine":
        """Block until the model is loaded (starting the load if needed). Raises EmbeddingUnavailable."""
        if self.is_ready:
            return self
        s = get_settings()
        wait = float(timeout if timeout is not None else s.EMBEDDING_LOAD_TIMEOUT_S)
        with self._lock:
            # A failed load (transient download/memory hiccup on a small host) must not poison the process until the next
            # restart: after a short cool-down the next request retries the load once more.
            if self.state == "error" and time.time() - self._load_started_at > 30 and not (self._loader_thread and self._loader_thread.is_alive()):
                self.state, self.error, self.error_code = "idle", None, None
                self._ready_event.clear()
            if self.state == "error":
                raise EmbeddingUnavailable(self.error or "Embedding model failed to load.", state="error")
            if self.state == "idle":
                self.state = "loading"
                self._loader_thread = threading.Thread(target=self._load, name="embedding-loader", daemon=True)
                self._loader_thread.start()
        if not self._ready_event.wait(wait):
            raise EmbeddingUnavailable(
                f"The embedding model '{self.model_name or s.EMBEDDING_MODEL}' is still loading "
                f"(waited {int(wait)}s). First start downloads ~90 MB; try again shortly.",
                state="loading",
            )
        if not self.is_ready:
            raise EmbeddingUnavailable(self.error or "Embedding model failed to load.", state="error")
        return self

    def _load(self) -> None:
        s = get_settings()
        started = time.time()
        self._load_started_at = started
        self.model_name = s.EMBEDDING_MODEL_PATH or s.EMBEDDING_MODEL
        try:
            encoder, dim, device = self._load_sentence_transformer(s)
            self._finish_load(encoder, dim, device, "sentence-transformers", False, started)
        except Exception as exc:  # noqa: BLE001 - every failure mode must end in a visible state
            reason = _describe_load_error(exc, self.model_name)
            logger.error("Embedding model load failed: %s", reason)
            if s.ALLOW_LEXICAL_FALLBACK:
                logger.warning("ALLOW_LEXICAL_FALLBACK=true -> using the lexical hash encoder. Scores are NOT semantic.")
                enc = _LexicalEncoder(s.EMBEDDING_DIM)
                self._finish_load(enc, enc.dim, "cpu", "lexical-hash", True, started, note=reason)
                return
            with self._lock:
                self.state = "error"
                self.error = reason
                self.error_code = CODE_UNAVAILABLE
                self._ready_event.set()

    def _load_sentence_transformer(self, s):
        try:
            import torch  # type: ignore
            from sentence_transformers import SentenceTransformer  # type: ignore
        except ImportError as exc:
            raise ImportError(
                f"{exc.name or 'sentence-transformers'} is not installed in this Python environment"
            ) from exc
        if s.EMBEDDING_THREADS > 0:
            torch.set_num_threads(s.EMBEDDING_THREADS)
        device = _pick_device(s.EMBEDDING_DEVICE)
        logger.info("Loading embedding model %s on %s ...", self.model_name, device)
        model = SentenceTransformer(self.model_name, device=device)
        dim = int(model.get_sentence_embedding_dimension())
        batch = max(1, s.EMBEDDING_BATCH_SIZE)

        class _Wrapper:
            name = "sentence-transformers"

            def encode(self, texts: Sequence[str]) -> np.ndarray:
                return model.encode(list(texts), batch_size=batch, convert_to_numpy=True,
                                    normalize_embeddings=True, show_progress_bar=False)

        return _Wrapper(), dim, device

    def _finish_load(self, encoder, dim: int, device: str, kind: str, fallback: bool, started: float, note: str = ""):
        test = None
        if kind != "lexical-hash":
            test = self._run_self_test(encoder)
            if not test["passed"]:
                with self._lock:
                    self.state = "error"
                    self.error = ("The embedding model loaded but failed its sanity check "
                                  f"(paraphrase {test['paraphrase']} vs unrelated {test['unrelated']}). "
                                  "The model files may be corrupt or the wrong model - delete the model cache "
                                  "and restart.")
                    self.error_code = CODE_UNAVAILABLE
                    self.self_test = test
                    self._ready_event.set()
                return
        with self._lock:
            self._encoder = encoder
            self.dim = dim
            self.device = device
            self.engine_kind = kind
            self.fallback_mode = fallback
            self.loaded_at = time.time()
            self.load_seconds = round(time.time() - started, 2)
            self.self_test = test
            self.error = note or None
            self.state = "ready"
            self._ready_event.set()
        logger.info("Embedding engine ready: %s (%s, dim=%s, %ss)%s", self.model_name, kind, dim,
                    self.load_seconds, " [LEXICAL FALLBACK]" if fallback else "")

    @staticmethod
    def _run_self_test(encoder) -> dict:
        try:
            v = _normalize(encoder.encode(list(_SELF_TEST)))
            para = float(v[0] @ v[1])
            unrel = float(v[0] @ v[2])
            return {"passed": bool(para > unrel + 0.05), "paraphrase": round(para, 3), "unrelated": round(unrel, 3)}
        except Exception as exc:  # noqa: BLE001
            return {"passed": False, "paraphrase": None, "unrelated": None, "error": str(exc)[:200]}

    # --------------------------------------------------- test / embedding hook
    def inject_encoder(self, encode_fn: Callable[[Sequence[str]], np.ndarray], dim: int, name: str = "injected") -> None:
        """Install a deterministic encoder. ONLY for unit tests of the matching logic - the status is reported as
        engine ``injected`` so it can never be mistaken for the transformer model."""
        class _E:
            pass
        e = _E()
        e.encode = encode_fn  # type: ignore[attr-defined]
        with self._lock:
            self._reset_state()
            self.model_name = name
            self._finish_load(e, dim, "cpu", "injected", False, time.time())

    def reset(self) -> None:
        with self._lock:
            self._reset_state()

    # --------------------------------------------------------------- encoding
    def encode(self, texts: Iterable[str]) -> np.ndarray:
        """(n, dim) float32 L2-normalised matrix. Raises EmbeddingUnavailable when the model is not usable."""
        items = [(t if isinstance(t, str) else str(t or "")).strip()[:20000] for t in texts]
        self.ensure_ready()
        if not items:
            return np.zeros((0, self.dim), dtype=np.float32)
        s = get_settings()
        keys = [self._key(t) for t in items]
        out: list[Optional[np.ndarray]] = [None] * len(items)
        todo: dict[str, int] = {}      # unique uncached text -> first index
        with self._lock:
            for i, k in enumerate(keys):
                hit = self._cache.get(k)
                if hit is not None:
                    self._cache.move_to_end(k)
                    out[i] = hit
                    self._cache_hits += 1
                elif k not in todo:
                    todo[k] = i
                    self._cache_misses += 1
        if todo:
            idxs = list(todo.values())
            vecs = _normalize(self._encoder.encode([items[i] for i in idxs]))
            with self._lock:
                for k, v in zip(todo.keys(), vecs):
                    self._cache[k] = v
                    self._cache.move_to_end(k)
                while len(self._cache) > max(64, s.EMBEDDING_CACHE_SIZE):
                    self._cache.popitem(last=False)
            fresh = dict(zip(todo.keys(), vecs))
            for i, k in enumerate(keys):
                if out[i] is None:
                    out[i] = fresh.get(k)
                    if out[i] is None:      # evicted between passes (tiny cache) - recompute
                        out[i] = _normalize(self._encoder.encode([items[i]]))[0]
        return np.vstack(out).astype(np.float32)

    def encode_one(self, text: str) -> np.ndarray:
        return self.encode([text])[0]

    @staticmethod
    def _key(text: str) -> str:
        return hashlib.blake2b(text.encode("utf-8", "ignore"), digest_size=16).hexdigest()

    def similarity(self, a: Sequence[str], b: Sequence[str]) -> np.ndarray:
        """Cosine similarity matrix of shape (len(a), len(b))."""
        if not a or not b:
            return np.zeros((len(a), len(b)), dtype=np.float32)
        both = self.encode(list(a) + list(b))
        return both[: len(a)] @ both[len(a):].T

    # ----------------------------------------------------------------- status
    def status(self) -> dict:
        s = get_settings()
        with self._lock:
            return {
                "state": self.state,
                "ready": self.is_ready,
                "engine": self.engine_kind or ("sentence-transformers" if self.state != "error" else None),
                "model": self.model_name or (s.EMBEDDING_MODEL_PATH or s.EMBEDDING_MODEL),
                "device": self.device or None,
                "dimension": self.dim or None,
                "fallback_mode": self.fallback_mode,
                "semantic": bool(self.is_ready and not self.fallback_mode),
                "strict": not s.ALLOW_LEXICAL_FALLBACK,
                "load_seconds": self.load_seconds,
                "self_test": self.self_test,
                "cache": {"size": len(self._cache), "hits": self._cache_hits, "misses": self._cache_misses},
                "error": self.error if self.state == "error" or self.fallback_mode else None,
                "error_code": self.error_code,
            }


def _describe_load_error(exc: Exception, model: str) -> str:
    text = f"{type(exc).__name__}: {exc}"
    low = text.lower()
    if isinstance(exc, ImportError):
        return (f"{exc}. Install the ML packages: pip install -r requirements-ml.txt "
                "(sentence-transformers, transformers, torch).")
    if any(k in low for k in ("connection", "resolve", "offline", "max retries", "timed out", "timeout",
                              "couldn't connect", "cannot connect", "403", "name or service")):
        return (f"The embedding model '{model}' is not on disk and could not be downloaded ({type(exc).__name__}). "
                "Allow huggingface.co once, or pre-download it with `python scripts/download_models.py`, "
                "or point EMBEDDING_MODEL_PATH at a local copy.")
    if "memoryerror" in low or "out of memory" in low or "killed" in low:
        return (f"Not enough memory to load '{model}'. The transformer model needs roughly 1 GB of free RAM; "
                "use a larger instance, or set ALLOW_LEXICAL_FALLBACK=true to accept non-semantic matching.")
    return f"The embedding model '{model}' could not be loaded: {text[:300]}"


_engine: Optional[EmbeddingEngine] = None
_engine_lock = threading.Lock()


def get_engine() -> EmbeddingEngine:
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = EmbeddingEngine()
    return _engine
