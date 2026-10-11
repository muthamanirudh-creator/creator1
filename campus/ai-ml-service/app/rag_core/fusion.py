from __future__ import annotations


def rrf(rankings: list[list[int]], weights: list[float] | None = None, k: int = 60) -> dict[int, float]:
    """Weighted Reciprocal Rank Fusion. `rankings` are best-first lists of item indices."""
    weights = weights or [1.0] * len(rankings)
    fused: dict[int, float] = {}
    for ranking, w in zip(rankings, weights):
        for rank, item in enumerate(ranking, start=1):
            fused[item] = fused.get(item, 0.0) + w / (k + rank)
    return fused
