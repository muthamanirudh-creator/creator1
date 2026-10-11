from __future__ import annotations

import math
import re

_TOKEN = re.compile(r"[a-z0-9][a-z0-9+.#/\-]*")
_STOP = frozenset("""a an and are as at be but by for from has have i in is it its of on or that the this to was were will with
you your my me we our their they he she not no do does did can could should would about into over than then so if what which
who how why when where""".split())


def tokenize(text: str) -> list[str]:
    out = []
    for t in _TOKEN.findall((text or "").lower()):
        t = t.strip(".-/")
        if len(t) > 1 and t not in _STOP:
            out.append(t)
    return out


class BM25Index:
    """Okapi BM25 over pre-tokenised documents; supports a candidate mask so metadata filters apply BEFORE ranking."""

    def __init__(self, k1: float = 1.4, b: float = 0.75):
        self.k1, self.b = k1, b
        self.docs: list[list[str]] = []
        self.df: dict[str, int] = {}
        self.avgdl = 1.0

    def build(self, token_docs: list[list[str]]) -> None:
        self.docs = token_docs
        self.df = {}
        for d in token_docs:
            for t in set(d):
                self.df[t] = self.df.get(t, 0) + 1
        self.avgdl = max(1.0, sum(len(d) for d in token_docs) / max(1, len(token_docs)))

    def scores(self, query_tokens: list[str], mask: list[bool] | None = None) -> list[float]:
        n = len(self.docs)
        out = [0.0] * n
        if not n:
            return out
        for t in set(query_tokens):
            df = self.df.get(t)
            if not df:
                continue
            idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
            for i, d in enumerate(self.docs):
                if mask is not None and not mask[i]:
                    continue
                f = d.count(t)
                if f:
                    out[i] += idf * (f * (self.k1 + 1)) / (f + self.k1 * (1 - self.b + self.b * len(d) / self.avgdl))
        return out
