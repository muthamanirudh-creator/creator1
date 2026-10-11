"""HybridIndex: lexical (BM25) + dense (cosine) retrieval over RagDocuments with hard metadata filters, weighted RRF,
near-duplicate removal and an embedding cache keyed by content hash (unchanged text is never re-embedded)."""
from __future__ import annotations

import threading
import time
from collections import defaultdict
from datetime import date
from typing import Callable, Optional

import numpy as np

from .filters import FILTER_KEYS, _as_set, extract_query_filters, passes
from .fusion import rrf
from .lexical import BM25Index, tokenize
from .models import AUTHORITY_RANK, Candidate, RagDocument

Embedder = Callable[[list[str]], np.ndarray]


def _jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


class HybridIndex:
    def __init__(self, embed: Embedder, *, embed_version: str = "v1", rrf_k: int = 60,
                 dense_weight: float = 1.0, lexical_weight: float = 0.6, min_similarity: float = 0.22):
        self._embed, self.embed_version = embed, embed_version
        self.rrf_k, self.dense_weight, self.lexical_weight, self.min_similarity = rrf_k, dense_weight, lexical_weight, min_similarity
        self._lock = threading.RLock()
        self.docs: list[RagDocument] = []
        self._vecs: Optional[np.ndarray] = None
        self._tokens: list[list[str]] = []
        self._bm25: Optional[BM25Index] = None
        self._vec_cache: dict[tuple[str, str], np.ndarray] = {}     # (embed_version, hash) -> vector
        self.version = 0                                             # bumps on any change; keys the response cache
        self.embed_calls = 0                                         # chunks actually sent to the embedder
        self.updated_at: Optional[float] = None
        self.vectors_path: str = ''                                  # optional .npz embedding cache (see save_vectors / load_vectors)
        self.vectors_error: Optional[str] = None

    # ----------------------------------------------------------------------------------------------- mutation
    def _vectors_for(self, docs: list[RagDocument]) -> np.ndarray:
        missing = [d for d in docs if (self.embed_version, d.hash) not in self._vec_cache]
        if missing:
            uniq: dict[str, RagDocument] = {d.hash: d for d in missing}
            vecs = self._embed([d.search_text for d in uniq.values()])
            self.embed_calls += len(uniq)
            for (h, _), v in zip(uniq.items(), vecs):
                self._vec_cache[(self.embed_version, h)] = np.asarray(v, dtype=np.float32)
        return np.vstack([self._vec_cache[(self.embed_version, d.hash)] for d in docs]) if docs else np.zeros((0, 1), np.float32)

    def upsert_source(self, source_id: str, docs: list[RagDocument]) -> dict:
        """Replace every chunk of `source_id`. Returns counts of added / unchanged / removed chunks."""
        with self._lock:
            old = {d.hash: d for d in self.docs if d.source_id == source_id}
            new_hashes = {d.hash for d in docs}
            added = sum(1 for d in docs if d.hash not in old)
            unchanged = len(docs) - added
            removed = sum(1 for h in old if h not in new_hashes)
            for d in docs:
                d.source_id = source_id
            self.docs = [d for d in self.docs if d.source_id != source_id] + list(docs)
            self._dirty()
            return {"added": added, "unchanged": unchanged, "removed": removed}

    def remove_source(self, source_id: str) -> int:
        with self._lock:
            n = len(self.docs)
            self.docs = [d for d in self.docs if d.source_id != source_id]
            self._dirty()
            return n - len(self.docs)

    def set_status(self, source_id: str, status: str, superseded_by: str | None = None) -> int:
        with self._lock:
            n = 0
            for d in self.docs:
                if d.source_id == source_id:
                    d.metadata["status"] = status
                    if superseded_by:
                        d.metadata["superseded_by"] = superseded_by
                    n += 1
            if n:
                self.version += 1
            return n

    def _dirty(self) -> None:
        self._vecs, self._bm25, self._tokens = None, None, []
        self.version += 1
        self.updated_at = time.time()

    def _ensure(self) -> None:
        with self._lock:
            if self._bm25 is not None:
                return
            self._tokens = [tokenize(d.search_text) for d in self.docs]
            self._bm25 = BM25Index()
            self._bm25.build(self._tokens)
            before = self.embed_calls
            self._vecs = self._vectors_for(self.docs) if self.docs else np.zeros((0, 1), np.float32)
            if self.embed_calls != before and self.vectors_path:
                self.save_vectors()                                   # only when something new was embedded

    # ----------------------------------------------------------------------------------------------- vector cache persistence
    def save_vectors(self, path: str = "") -> bool:
        """Persist the content-hash -> vector cache for the CURRENT shared chunks (public text only). Atomic; a failure is
        recorded in `vectors_error`, never raised."""
        path = path or self.vectors_path
        if not path:
            return False
        try:
            import os
            import tempfile
            live = {d.hash for d in self.docs}
            items = [(h, v) for (ver, h), v in self._vec_cache.items() if ver == self.embed_version and h in live]
            if not items:
                return False
            d = os.path.dirname(os.path.abspath(path)) or "."
            os.makedirs(d, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
            with os.fdopen(fd, "wb") as fh:
                np.savez(fh, hashes=np.array([h for h, _ in items]), vecs=np.vstack([v for _, v in items]),
                         embed_version=np.array(self.embed_version))
            os.replace(tmp, path)
            self.vectors_error = None
            return True
        except Exception as exc:                                      # noqa: BLE001 - disk full / read-only: stay in memory
            self.vectors_error = type(exc).__name__
            return False

    def load_vectors(self, path: str = "") -> int:
        """Load a cache written by save_vectors. Returns 0 (and loads nothing) if missing, corrupt, or produced by a
        different embedding model/version: vectors from another model must never be mixed in."""
        path = path or self.vectors_path
        try:
            import os
            if not path or not os.path.exists(path):
                return 0
            with np.load(path, allow_pickle=False) as z:
                if str(z["embed_version"]) != self.embed_version:
                    return 0
                hashes, vecs = z["hashes"], z["vecs"]
                if len(hashes) != len(vecs):
                    return 0
                with self._lock:
                    for h, v in zip(hashes, vecs):
                        self._vec_cache[(self.embed_version, str(h))] = np.asarray(v, dtype=np.float32)
            return int(len(hashes))
        except Exception as exc:                                      # noqa: BLE001
            self.vectors_error = type(exc).__name__
            return 0

    # ----------------------------------------------------------------------------------------------- introspection
    def known_values(self) -> dict[str, set[str]]:
        out: dict[str, set[str]] = defaultdict(set)
        for d in self.docs:
            for k in FILTER_KEYS:
                out[k] |= _as_set(d.metadata.get(k))
        return out

    def stats(self) -> dict:
        by_domain: dict[str, int] = defaultdict(int)
        by_status: dict[str, int] = defaultdict(int)
        for d in self.docs:
            by_domain[str(d.metadata.get("domain"))] += 1
            by_status[str(d.metadata.get("status"))] += 1
        return {"chunks": len(self.docs), "sources": len({d.source_id for d in self.docs}), "by_domain": dict(by_domain),
                "by_status": dict(by_status), "version": self.version, "embed_version": self.embed_version,
                "embed_calls": self.embed_calls, "cached_vectors": len(self._vec_cache), "updated_at": self.updated_at}

    # ----------------------------------------------------------------------------------------------- search
    def search(self, query: str, *, filters: Optional[dict] = None, requester: Optional[dict] = None,
               extra_docs: Optional[list[RagDocument]] = None, limit: int = 20, include_stale: bool = False,
               today: Optional[date] = None, auto_filters: bool = True) -> tuple[list[Candidate], dict]:
        """Hybrid search. Returns (candidates best-first, info). Hard filters + access control are applied before
        ranking. Auto-derived filters (organisation/location/year found in the query) are relaxed if they leave
        nothing, and info['filter_relaxed'] says so; explicit filters and access control are never relaxed."""
        self._ensure()
        explicit = {k: v for k, v in (filters or {}).items() if v not in (None, "", [])}
        auto = extract_query_filters(query, self.known_values()) if auto_filters else {}
        auto = {k: v for k, v in auto.items() if k not in explicit}
        extras = list(extra_docs or [])
        if extras:
            for d in extras:                                    # request-scoped docs are visible only to this call
                d.metadata["scope"] = "public"
        docs = self.docs + extras
        tokens = self._tokens + [tokenize(d.search_text) for d in extras]
        vecs = self._vecs if not extras else np.vstack([self._vecs, self._vectors_for(extras)]) if len(self.docs) else self._vectors_for(extras)
        bm25 = self._bm25
        if extras:
            bm25 = BM25Index()
            bm25.build(tokens)
        if not docs:
            return [], {"filter_relaxed": False, "auto_filters": auto, "stale_excluded": 0, "pool": 0}

        def run(flt: dict):
            mask, stale_flags, stale_excl = [], [], 0
            for d in docs:
                ok, st = passes(d, flt, requester, include_stale=include_stale, today=today)
                mask.append(ok)
                stale_flags.append(st)
                if not ok and st:
                    stale_excl += 1
            return mask, stale_flags, stale_excl

        used = {**explicit, **auto}
        mask, stale_flags, stale_excl = run(used)
        relaxed = False
        if auto and not any(mask):
            mask, stale_flags, stale_excl = run(explicit)
            used, relaxed = dict(explicit), True
        if not any(mask):
            return [], {"filter_relaxed": relaxed, "auto_filters": auto, "applied_filters": used, "stale_excluded": stale_excl, "pool": 0}

        qv = np.asarray(self._embed([query])[0], dtype=np.float32)
        dense = vecs @ qv
        qtok = tokenize(query)
        lex = np.asarray(bm25.scores(qtok, mask), dtype=np.float32)
        idx = [i for i, ok in enumerate(mask) if ok]
        d_rank = sorted(idx, key=lambda i: -dense[i])
        l_rank = sorted((i for i in idx if lex[i] > 0), key=lambda i: -lex[i])
        fused = rrf([d_rank, l_rank], [self.dense_weight, self.lexical_weight], self.rrf_k)
        lmax = float(lex[idx].max()) if idx else 0.0
        idents = [t for t in qtok if any(c.isdigit() for c in t) and len(t) >= 3]   # e.g. "03/2025", "ssc-cgl-2025"

        cands: list[Candidate] = []
        for i in idx:
            ln = float(lex[i] / lmax) if lmax > 0 else 0.0
            exact_id = bool(idents) and any(t in tokens[i] for t in idents)
            keep = (dense[i] >= self.min_similarity) or (ln >= 0.55 and dense[i] >= self.min_similarity * 0.6) or exact_id
            if not keep:
                continue
            c = Candidate(docs[i], dense=float(dense[i]), lexical=ln, fused=fused.get(i, 0.0))
            if exact_id:
                c.fused *= 1.5
                c.flags.append("exact_identifier_match")
            if stale_flags[i]:
                c.flags.append(stale_flags[i])
            cands.append(c)
        cands.sort(key=lambda c: -c.fused)
        cands = self._dedupe(cands)[:limit]
        return cands, {"filter_relaxed": relaxed, "auto_filters": auto, "applied_filters": used,
                       "stale_excluded": stale_excl, "pool": len(idx), "above_bar": len(cands)}

    @staticmethod
    def _dedupe(cands: list[Candidate]) -> list[Candidate]:
        """Exact (hash) and near-duplicate (Jaccard >= 0.9) removal; the more authoritative / newer copy wins."""
        def better(a: Candidate, b: Candidate) -> bool:
            ra, rb = AUTHORITY_RANK.get(a.doc.metadata.get("authority"), 0), AUTHORITY_RANK.get(b.doc.metadata.get("authority"), 0)
            if ra != rb:
                return ra > rb
            return str(a.doc.metadata.get("published_at", "")) > str(b.doc.metadata.get("published_at", ""))
        kept: list[Candidate] = []
        sets: list[set] = []
        for c in cands:
            s = set(tokenize(c.doc.text))
            dup = next((j for j, k in enumerate(kept) if k.doc.hash == c.doc.hash or _jaccard(s, sets[j]) >= 0.9), None)
            if dup is None:
                kept.append(c)
                sets.append(s)
            elif better(c, kept[dup]):
                c.flags.append("duplicate_replaced")
                kept[dup], sets[dup] = c, s
        return kept
