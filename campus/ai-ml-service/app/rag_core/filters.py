"""Metadata filtering, access control and staleness rules. Filters apply BEFORE ranking (hard constraints)."""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Iterable, Optional

from .models import AUTHORITY_RANK, RagDocument

FILTER_KEYS = ("domain", "organization", "role", "location", "cycle", "doc_type", "source", "language", "batch")


def _as_set(v: Any) -> set[str]:
    if v is None or v == "":
        return set()
    if isinstance(v, (list, tuple, set, frozenset)):
        return {str(x).strip().lower() for x in v if str(x).strip()}
    return {str(v).strip().lower()}


def parse_date(v: Any) -> Optional[date]:
    if not v:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def can_access(doc: RagDocument, requester: Optional[dict]) -> bool:
    """Isolation: `public` is visible to all; `user:<id>` only to that user; `org:<id>` only to members."""
    scope = str(doc.metadata.get("scope", "public"))
    if scope == "public":
        return True
    requester = requester or {}
    if scope.startswith("user:"):
        uid = requester.get("user_id")
        return uid is not None and scope == f"user:{uid}"
    if scope.startswith("org:"):
        return scope[4:] in {str(o) for o in (requester.get("orgs") or [])}
    return False


def staleness(doc: RagDocument, today: Optional[date] = None) -> Optional[str]:
    """Return 'superseded' | 'expired' | 'withdrawn' | None. `expires_at` in the past counts as expired even if the
    record has not been re-labelled yet."""
    today = today or date.today()
    st = str(doc.metadata.get("status", "active"))
    if st in ("superseded", "withdrawn", "expired"):
        return st
    exp = parse_date(doc.metadata.get("expires_at"))
    if exp and exp < today:
        return "expired"
    return None


def passes(doc: RagDocument, filters: dict, requester: Optional[dict], *, include_stale: bool = False,
           today: Optional[date] = None) -> tuple[bool, Optional[str]]:
    """(ok, stale_flag). Access control is never relaxed."""
    if not can_access(doc, requester):
        return False, None
    md = doc.metadata
    for key in FILTER_KEYS:
        want = _as_set(filters.get(key))
        if want and not (_as_set(md.get(key)) & want):
            return False, None
    after, before = parse_date(filters.get("published_after")), parse_date(filters.get("published_before"))
    pub = parse_date(md.get("published_at"))
    if (after or before) and pub is None:
        return False, None
    if after and pub and pub < after:
        return False, None
    if before and pub and pub > before:
        return False, None
    min_auth = filters.get("min_authority")
    if min_auth and AUTHORITY_RANK.get(str(md.get("authority")), 0) < AUTHORITY_RANK.get(str(min_auth), 0):
        return False, None
    stale = staleness(doc, today)
    if stale and not include_stale:
        return False, stale
    return True, stale


_YEAR = re.compile(r"\b(20\d{2})\b")


def extract_query_filters(query: str, known: dict[str, set[str]]) -> dict:
    """Derive soft filters from the query using values that actually exist in the index (no guessing).
    `known` maps filter key -> set of lower-cased values present in the index."""
    q = " " + re.sub(r"[^a-z0-9 ]+", " ", (query or "").lower()) + " "
    found: dict[str, Any] = {}
    for key in ("organization", "location", "role"):
        hits = [v for v in known.get(key, ()) if len(v) >= 3 and f" {re.sub(r'[^a-z0-9 ]+', ' ', v)} " in q]
        if hits:
            found[key] = sorted(hits, key=len, reverse=True)[:2]
    m = _YEAR.findall(query or "")
    if m:
        found["cycle"] = sorted(set(m))
    return found
