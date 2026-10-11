"""Citation validation and unsupported-claim enforcement."""
from __future__ import annotations

import re

from .lexical import tokenize
from .models import Candidate

CITE = re.compile(r"\[(\d{1,2})\]")
_FIGURE = re.compile(r"\b\d{1,4}(?:[/.\-]\d{1,4}){0,2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b", re.I)
_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")


def _norm_fig(s: str) -> str:
    return re.sub(r"[^0-9a-z]", "", s.lower())


def validate(answer: str, kept: list[Candidate], *, min_overlap: float = 0.2) -> dict:
    """Returns {text, used, invalid, unsupported, coverage}. Invalid [n] are stripped. A sentence is UNSUPPORTED when it
    cites a source but (a) contains a figure/date absent from every cited source, or (b) shares too little vocabulary
    with its cited sources. Sentences with no citation are kept but counted against coverage."""
    by_n = {c.n: c for c in kept}
    invalid = sorted({int(n) for n in CITE.findall(answer or "") if int(n) not in by_n})
    text = answer or ""
    for n in invalid:
        text = re.sub(rf"\s*\[{n}\]", "", text)
    out, unsupported, cited_sents, total = [], [], 0, 0
    used: set[int] = set()
    for sent in [s for s in _SPLIT.split(text) if s and s.strip()]:
        ns = [int(x) for x in CITE.findall(sent)]
        body = CITE.sub("", sent)
        if len(body.strip()) > 25:
            total += 1
        if not ns:
            out.append(sent)
            continue
        cited_sents += 1 if len(body.strip()) > 25 else 0
        src_text = " ".join(by_n[n].doc.text for n in ns if n in by_n)
        src_norm = _norm_fig(src_text)
        figs = [f for f in _FIGURE.findall(body) if len(_norm_fig(f)) >= 2]
        bad_fig = [f for f in figs if _norm_fig(f) not in src_norm]
        toks = set(tokenize(body))
        overlap = len(toks & set(tokenize(src_text))) / len(toks) if toks else 1.0
        if bad_fig or overlap < min_overlap:
            unsupported.append({"sentence": sent.strip()[:300], "reason": "figure_not_in_source" if bad_fig else "low_overlap",
                                "figures": bad_fig})
            continue
        used.update(ns)
        out.append(sent)
    return {"text": "\n".join(out).strip() if "\n" in (answer or "") else " ".join(out).strip(), "used": sorted(used),
            "invalid": invalid, "unsupported": unsupported, "coverage": round(cited_sents / total, 2) if total else 0.0}
