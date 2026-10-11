"""Ingestion of recruitment notices into the shared index (push-based: the existing GovCareer crawler / an admin supplies
the record; this service performs no outbound fetching, so it adds no SSRF surface).

validate -> sanitise (prompt-injection lines removed) -> extract criteria (verbatim quotes only) -> merge any supplied
criteria that survive quote validation -> registry upsert (status, dedupe, supersede) -> index chunks.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from .eligibility import Criterion, coverage, extract_criteria, validate_criteria
from .recruitment import RecordRegistry, RecordError, record_from_payload  # noqa: F401  (RecordError re-exported)


def ingest_record(registry: RecordRegistry, payload: dict, *, official_domains: tuple[str, ...] = (),
                  today: Optional[date] = None, now: Optional[datetime] = None) -> dict:
    rec = record_from_payload(payload, official_domains=official_domains)
    found = extract_criteria(rec.text)
    supplied, rejected = validate_criteria(rec.criteria, rec.text)      # caller/LLM-proposed criteria must quote the notice
    merged: dict[tuple, Criterion] = {(c.key, str(c.value)): c for c in found}
    for c in supplied:
        merged.setdefault((c.key, str(c.value)), c)
    rec.criteria = [c.to_dict() for c in merged.values()]
    out = registry.upsert(rec, today=today, now=now)
    out["criteria_extracted"] = len(rec.criteria)
    out["criteria_rejected"] = rejected
    out["coverage"] = coverage(list(merged.values()))
    return out


def criteria_of(record) -> list[Criterion]:
    """Stored criteria re-validated against the stored notice text on every use."""
    ok, _bad = validate_criteria(record.criteria, record.text)
    return ok
