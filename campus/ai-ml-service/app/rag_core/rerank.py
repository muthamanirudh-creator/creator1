"""Second-stage rerankers for the shared Hybrid RAG pipeline (pass 5: now actually wired in).

Two implementations behind one callable contract ``(query, candidates) -> list[float]`` (higher = better):

* ``LexicalReranker``  - deterministic, dependency-free. Scores how completely the passage covers the *query's* terms,
  phrases and title, blended with the first-stage fused rank so a strong first-stage hit is never thrown away. It is a
  coverage heuristic, NOT a learned cross-encoder, and is labelled as such (``name == "lexical"``).
* ``CrossEncoderReranker`` - optional learned reranker (``sentence-transformers`` CrossEncoder). Loaded lazily on first
  use; if the package or model is unavailable it fails ONCE, records why, and the pipeline degrades to the lexical
  reranker instead of erroring.

Rules that hold for both: exact-identifier matches (e.g. an advertisement number) keep their boost; authority and
access control are not touched here (filters ran before ranking); a reranker failure never fails a request.
"""
from __future__ import annotations

import logging
import math
import threading
from typing import Optional

from .lexical import tokenize
from .models import Candidate

logger = logging.getLogger("ai_ml_service.rerank")

_STOP = frozenset("a an and are as at be by for from how i in is it of on or the to what when where which who will with do does can my me".split())


def _terms(text: str) -> list[str]:
    return [t for t in tokenize(text) if t not in _STOP]


def _fused_norm(cands: list[Candidate]) -> list[float]:
    top = max((c.fused for c in cands), default=0.0)
    return [c.fused / top if top > 0 else 0.0 for c in cands]


class LexicalReranker:
    name = "lexical"

    def __init__(self, first_stage_weight: float = 0.25):
        self.w_first = max(0.0, min(0.6, first_stage_weight))

    def __call__(self, query: str, cands: list[Candidate]) -> list[float]:
        q = list(dict.fromkeys(_terms(query)))
        if not q:
            return _fused_norm(cands)
        qset, bigrams = set(q), {(a, b) for a, b in zip(_terms(query), _terms(query)[1:])}
        first = _fused_norm(cands)
        out: list[float] = []
        for c, f in zip(cands, first):
            body = _terms(c.doc.text)
            bset = set(body)
            title = set(_terms(c.doc.title or ""))
            cover = len(qset & (bset | title)) / len(qset)
            bg = {(a, b) for a, b in zip(body, body[1:])}
            phrase = len(bigrams & bg) / len(bigrams) if bigrams else 0.0
            title_hit = len(qset & title) / len(qset) if title else 0.0
            s = (1 - self.w_first) * (0.6 * cover + 0.25 * phrase + 0.15 * title_hit) + self.w_first * f
            if "exact_identifier_match" in c.flags:
                s += 0.5                                   # an advertisement/notice number match must survive reranking
            out.append(round(s, 6))
        return out


class CrossEncoderReranker:
    name = "cross-encoder"

    def __init__(self, model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2", first_stage_weight: float = 0.2, max_chars: int = 1200):
        self.model_name, self.w_first, self.max_chars = model, first_stage_weight, max_chars
        self._model = None
        self._failed: Optional[str] = None
        self._lock = threading.Lock()

    @property
    def failed(self) -> Optional[str]:
        return self._failed

    def _load(self):
        with self._lock:
            if self._model is not None or self._failed:
                return self._model
            try:
                from sentence_transformers import CrossEncoder      # type: ignore
                self._model = CrossEncoder(self.model_name)
            except Exception as exc:                                # noqa: BLE001 - missing package, no network, bad model
                self._failed = f"{type(exc).__name__}: {str(exc)[:120]}"
                logger.warning("Cross-encoder reranker unavailable (%s); using the lexical reranker.", self._failed)
            return self._model

    def __call__(self, query: str, cands: list[Candidate]) -> list[float]:
        m = self._load()
        if m is None:
            raise RuntimeError(self._failed or "cross-encoder unavailable")
        raw = m.predict([(query, (c.doc.title + ". " + c.doc.text)[: self.max_chars]) for c in cands])
        sig = [1.0 / (1.0 + math.exp(-float(x))) for x in raw]
        first = _fused_norm(cands)
        return [round((1 - self.w_first) * s + self.w_first * f + (0.5 if "exact_identifier_match" in c.flags else 0.0), 6)
                for s, f, c in zip(sig, first, cands)]


class FallbackReranker:
    """Primary reranker with a permanent, reported fallback when the primary cannot run."""

    def __init__(self, primary, fallback):
        self.primary, self.fallback = primary, fallback
        self.name = primary.name

    def __call__(self, query: str, cands: list[Candidate]) -> list[float]:
        if getattr(self.primary, "failed", None):
            self.name = self.fallback.name
            return self.fallback(query, cands)
        try:
            out = self.primary(query, cands)
            self.name = self.primary.name
            return out
        except Exception:                                           # noqa: BLE001
            self.name = self.fallback.name
            return self.fallback(query, cands)


def build_reranker(mode: str = "auto", model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"):
    """mode: off | lexical | cross-encoder | auto. 'auto' = cross-encoder when sentence-transformers is importable, else lexical.
    'cross-encoder' always degrades to lexical (reported in retrieval.reranker) rather than failing requests."""
    mode = (mode or "auto").strip().lower()
    if mode == "off":
        return None
    if mode == "lexical":
        return LexicalReranker()
    if mode == "auto":
        try:
            import importlib.util
            if importlib.util.find_spec("sentence_transformers") is None:
                return LexicalReranker()
        except Exception:                                           # noqa: BLE001
            return LexicalReranker()
    return FallbackReranker(CrossEncoderReranker(model), LexicalReranker())


def wants_rerank(requested: Optional[bool], cands: list[Candidate], *, mode_on: bool, strict_facts: bool, margin: float = 0.12) -> bool:
    """Explicit True/False wins. None = policy: rerank only 'difficult or high-value' queries - recruitment facts, or when the
    first-stage top results are nearly tied (so ordering is uncertain). Cheap and deterministic; skipped when off."""
    if not mode_on or len(cands) < 2:
        return False
    if requested is not None:
        return bool(requested)
    if strict_facts:
        return True
    top = max(c.fused for c in cands) or 1.0
    ranked = sorted((c.fused / top for c in cands), reverse=True)
    return (ranked[0] - ranked[1]) < margin
