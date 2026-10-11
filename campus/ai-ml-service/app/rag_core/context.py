"""Bounded, source-aware context assembly + conflict detection."""
from __future__ import annotations

from .security import sanitize_untrusted
from .models import AUTHORITY_RANK, Candidate


def est_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def source_header(c: Candidate) -> str:
    md = c.doc.metadata
    bits = [f"title={c.doc.title or 'untitled'}"]
    for label, key in (("issuer", "organization"), ("authority", "authority"), ("published", "published_at"),
                       ("last_verified", "last_verified_at"), ("status", "status"), ("drive_status", "drive_status"), ("advt", "advt_no"), ("cycle", "cycle"), ("freshness", "freshness"), ("origin", "content_origin"), ("url", "url")):
        if md.get(key):
            bits.append(f"{label}={md[key]}")
    return "; ".join(bits)


def assemble(cands: list[Candidate], token_budget: int, max_sources: int) -> tuple[str, list[Candidate], list[str]]:
    """Number candidates 1..n (authoritative, relevant first), sanitise each body, stop at the token budget."""
    ordered = sorted(cands, key=lambda c: (-AUTHORITY_RANK.get(c.doc.metadata.get("authority"), 0) * 0.0, -c.fused))
    parts, kept, flags, used = [], [], [], 0
    for c in ordered:
        if len(kept) >= max_sources:
            break
        body, f = sanitize_untrusted(c.doc.text)
        for x in f:
            c.flags.append(x)
            if x not in flags:
                flags.append(x)
        block_tokens = est_tokens(body) + 30
        if kept and used + block_tokens > token_budget:
            break
        if not kept and block_tokens > token_budget:              # a single oversized chunk is truncated, not dropped
            body = body[: token_budget * 4]
        c.n = len(kept) + 1
        parts.append(f"[{c.n}] ({source_header(c)})\n{body}")
        kept.append(c)
        used += block_tokens
    return "\n\n".join(parts), kept, flags


def detect_conflicts(cands: list[Candidate]) -> list[dict]:
    """Two sources describing the same record (`record_key`) with different values for the same structured fact
    (metadata['facts']) are a material contradiction and are reported, never silently resolved."""
    by_key: dict[str, list[Candidate]] = {}
    for c in cands:
        k = c.doc.metadata.get("record_key")
        if k:
            by_key.setdefault(str(k), []).append(c)
    out = []
    for k, group in by_key.items():
        fields: dict[str, dict[str, list[int]]] = {}
        for c in group:
            for fk, fv in (c.doc.metadata.get("facts") or {}).items():
                fields.setdefault(fk, {}).setdefault(str(fv), []).append(c.n)
        for fk, vals in fields.items():
            if len(vals) > 1:
                out.append({"record": k, "field": fk, "values": {v: sorted(ns) for v, ns in vals.items()}})
    return out
