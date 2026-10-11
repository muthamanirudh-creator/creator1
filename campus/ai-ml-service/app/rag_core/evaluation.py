"""Retrieval quality metrics for the shared index (Recall@K, MRR, nDCG@K) over a labelled question set:
[{"q": str, "relevant": [source_id, ...], "requester": {...}?, "filters": {...}?}]."""
from __future__ import annotations

import math
from typing import Callable

from .store import HybridIndex


def evaluate_retrieval(search: Callable[[dict], list[str]], cases: list[dict], k: int = 5) -> dict:
    """`search(case) -> ranked list of source_ids`. Returns macro-averaged metrics."""
    rec = mrr = ndcg = 0.0
    for case in cases:
        ranked, seen = [], set()
        for sid in search(case):
            if sid not in seen:
                seen.add(sid)
                ranked.append(sid)
        ranked = ranked[:k]
        rel = set(case["relevant"])
        hits = [1 if s in rel else 0 for s in ranked]
        rec += len(rel & set(ranked)) / len(rel) if rel else 0.0
        mrr += next((1 / (i + 1) for i, h in enumerate(hits) if h), 0.0)
        dcg = sum(h / math.log2(i + 2) for i, h in enumerate(hits))
        idcg = sum(1 / math.log2(i + 2) for i in range(min(len(rel), k)))
        ndcg += dcg / idcg if idcg else 0.0
    n = max(1, len(cases))
    return {f"recall@{k}": round(rec / n, 3), "mrr": round(mrr / n, 3), f"ndcg@{k}": round(ndcg / n, 3), "cases": len(cases)}


def index_search_fn(index: HybridIndex, **kw) -> Callable[[dict], list[str]]:
    def run(case: dict) -> list[str]:
        cands, _ = index.search(case["q"], filters=case.get("filters"), requester=case.get("requester"), **kw)
        return [c.doc.source_id for c in cands]
    return run
