"""Recruitment records: honest drive status, freshness, duplicate/superseded handling and index synchronisation.

Status vocabulary (never "live" unless verified):
  active        verified recently by an official/verified source AND inside [opens_at, deadline]
  upcoming      verified, opens_at in the future
  closed        deadline passed (by the record's own dates; flagged if the verification is old - may have been extended)
  unverified    not verified recently, not from an official/verified source, or no deadline known
  inaccessible  the source could not be reached on the last check (last successful verification time is preserved)

Nothing here fetches anything: records are pushed in by the existing GovCareer crawler / an admin. This module only
labels what it has been told and never upgrades certainty.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

from .filters import parse_date
from .models import AUTHORITY_RANK, RagDocument, content_hash, norm_text
from .security import sanitize_untrusted
from .store import HybridIndex

DEFAULT_MAX_VERIFICATION_AGE_DAYS = 7
MAX_TEXT_CHARS = 200_000
CHUNK_CHARS = 900
SECTION_WORDS = ("eligibility", "important dates", "how to apply", "selection process", "pay", "salary", "vacancy",
                 "vacancies", "age limit", "qualification", "fee", "application fee", "documents required")


def _slug(v: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(v or "").lower()).strip()


def parse_ts(v: Any) -> Optional[datetime]:
    if not v:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def canonical_url(url: str) -> str:
    try:
        p = urlsplit(url or "")
    except ValueError:
        return ""
    host = (p.hostname or "").lower().removeprefix("www.")
    return f"{host}{p.path.rstrip('/')}".lower()


@dataclass
class RecruitmentRecord:
    record_id: str
    organization: str
    role: str
    title: str = ""
    advt_no: str = ""                    # recruitment-drive identifier (e.g. "Advt. No. 03/2025")
    cycle: str = ""                      # year / batch label
    url: str = ""
    text: str = ""
    published_at: Optional[str] = None
    opens_at: Optional[str] = None
    deadline: Optional[str] = None
    location: str = ""
    authority: str = "third_party"       # official | verified | internal | third_party
    last_verified_at: Optional[str] = None
    source_status: str = "never_checked"  # reachable | unreachable | never_checked
    source_error: str = ""
    extraction_status: str = "auto_extracted"   # auto_extracted | reviewed
    salary: str = ""                     # stored only as written in the source; never estimated
    criteria: list[dict] = field(default_factory=list)
    domain: str = "government"
    flags: list[str] = field(default_factory=list)

    def drive_key(self) -> str:
        """Identity of ONE recruitment drive. Different advertisement numbers are different drives, never merged."""
        return "|".join((_slug(self.organization), _slug(self.role), _slug(self.advt_no) or _slug(self.cycle)))

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}  # type: ignore[attr-defined]


def classify_status(rec: RecruitmentRecord, *, today: Optional[date] = None, now: Optional[datetime] = None,
                    max_age_days: int = DEFAULT_MAX_VERIFICATION_AGE_DAYS) -> dict:
    today = today or date.today()
    now = now or datetime.now(timezone.utc)
    reasons: list[str] = []
    deadline, opens = parse_date(rec.deadline), parse_date(rec.opens_at)
    verified = parse_ts(rec.last_verified_at)
    age_days = (now - verified).total_seconds() / 86400 if verified else None
    stale_verification = age_days is None or age_days > max_age_days
    trusted = AUTHORITY_RANK.get(rec.authority, 0) >= 2

    if deadline and today > deadline:
        if stale_verification:
            reasons.append("deadline_passed_but_not_recently_verified: the deadline may have been extended")
        return {"status": "closed", "reasons": reasons or ["deadline_passed"], "verified_age_days": _r(age_days)}
    if rec.source_status == "unreachable":
        reasons.append(f"source_unreachable_on_last_check{': ' + rec.source_error if rec.source_error else ''}")
        return {"status": "inaccessible", "reasons": reasons, "verified_age_days": _r(age_days)}
    if not trusted:
        reasons.append(f"source_authority_is_{rec.authority}: not an official/verified source")
    if verified is None:
        reasons.append("never_verified")
    elif stale_verification:
        reasons.append(f"last_verification_older_than_{max_age_days}_days")
    if not deadline:
        reasons.append("no_application_deadline_recorded")
    if reasons:
        return {"status": "unverified", "reasons": reasons, "verified_age_days": _r(age_days)}
    if opens and today < opens:
        return {"status": "upcoming", "reasons": [], "verified_age_days": _r(age_days)}
    return {"status": "active", "reasons": [], "verified_age_days": _r(age_days)}


def _r(v: Optional[float]) -> Optional[float]:
    return None if v is None else round(v, 2)


# ------------------------------------------------------------------------------------------------- chunking
def _section_of(line: str) -> Optional[str]:
    s = _slug(line)
    if 0 < len(s) <= 40:
        for w in SECTION_WORDS:
            if s == w or s.startswith(w + " "):
                return line.strip(" :-#*")[:60]
    return None


def chunk_notice(text: str, max_chars: int = CHUNK_CHARS) -> list[tuple[str, str]]:
    """[(section_label, chunk_text)]. Keeps paragraphs whole; one section's facts stay together where possible."""
    out: list[tuple[str, str]] = []
    section, buf = "", ""

    def flush():
        nonlocal buf
        if buf.strip():
            out.append((section, buf.strip()))
        buf = ""

    for para in re.split(r"\n\s*\n|\r\n\s*\r\n", text or ""):
        para = para.strip()
        if not para:
            continue
        first = para.splitlines()[0]
        sec = _section_of(first)
        if sec:
            flush()
            section = sec
        if len(buf) + len(para) + 2 > max_chars:
            flush()
        if len(para) > max_chars:                    # a single oversized paragraph is split on sentence ends
            for sent in re.split(r"(?<=[.;])\s+", para):
                if len(buf) + len(sent) + 1 > max_chars:
                    flush()
                buf += (" " if buf else "") + sent
        else:
            buf += ("\n\n" if buf else "") + para
    flush()
    return out


# ------------------------------------------------------------------------------------------------- documents
def to_documents(rec: RecruitmentRecord, st: dict) -> list[RagDocument]:
    """Index chunks for one record. Index `status` becomes `expired` only for closed drives (excluded by default);
    the finer `drive_status` travels in metadata and is shown in every source header."""
    facts = {k: v for k, v in (("deadline", rec.deadline), ("advt_no", rec.advt_no), ("opens_at", rec.opens_at)) if v}
    base = {"domain": rec.domain, "organization": rec.organization, "role": rec.role, "location": rec.location,
            "cycle": rec.cycle, "doc_type": "recruitment_notice", "url": rec.url, "published_at": rec.published_at,
            "last_verified_at": rec.last_verified_at, "authority": rec.authority, "scope": "public",
            "status": "expired" if st["status"] == "closed" else "active", "drive_status": st["status"],
            "source_status": rec.source_status, "record_key": rec.drive_key(), "facts": facts,
            "advt_no": rec.advt_no, "record_id": rec.record_id, "expires_at": rec.deadline}
    docs = []
    chunks = chunk_notice(rec.text) or [("", norm_text(rec.title or f"{rec.organization} {rec.role}"))]
    # Contextual header: every chunk names its own drive, so a section such as "Important Dates" can be matched to the right
    # advertisement (and never confused with another drive's identical-looking section). Built only from record fields.
    header = "[" + " | ".join(x for x in (rec.organization, rec.role, f"Advt. No. {rec.advt_no}" if rec.advt_no else "", rec.cycle) if x) + "]"
    for i, (section, body) in enumerate(chunks):
        md = {**base, "section": section}
        docs.append(RagDocument(text=f"{header}\n{body}", source_id=f"rec:{rec.record_id}", title=rec.title or f"{rec.organization} - {rec.role}",
                                ordinal=i, metadata=md))
    return docs


# ------------------------------------------------------------------------------------------------- validation
class RecordError(ValueError):
    pass


def _official_domain(url: str, extra: tuple[str, ...]) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    suffixes = (".gov.in", ".nic.in") + tuple(e.lower().lstrip("*") for e in extra if e)
    return host.endswith(suffixes) or host in {s.lstrip(".") for s in suffixes}


def record_from_payload(p: dict, *, official_domains: tuple[str, ...] = ()) -> RecruitmentRecord:
    """Validate an ingest payload. Raises RecordError with a user-safe message."""
    if not isinstance(p, dict):
        raise RecordError("record must be an object")
    for req in ("record_id", "organization", "role"):
        if not norm_text(str(p.get(req) or "")):
            raise RecordError(f"{req} is required")
    rid = str(p["record_id"])
    if not re.fullmatch(r"[A-Za-z0-9_.:\-]{1,80}", rid):
        raise RecordError("record_id must be 1-80 chars of letters, digits, _ . : -")
    text = str(p.get("text") or "")
    if len(text) > MAX_TEXT_CHARS:
        raise RecordError(f"text exceeds {MAX_TEXT_CHARS} characters")
    url = str(p.get("url") or "").strip()
    if url:
        sp = urlsplit(url)
        if sp.scheme != "https" or not sp.hostname:
            raise RecordError("url must be an https URL")
    for dk in ("published_at", "opens_at", "deadline"):
        if p.get(dk) and parse_date(p[dk]) is None:
            raise RecordError(f"{dk} must be an ISO date (YYYY-MM-DD)")
    if p.get("last_verified_at") and parse_ts(p["last_verified_at"]) is None:
        raise RecordError("last_verified_at must be an ISO timestamp")
    opens, deadline = parse_date(p.get("opens_at")), parse_date(p.get("deadline"))
    if opens and deadline and deadline < opens:
        raise RecordError("deadline is before opens_at")
    authority = str(p.get("authority") or "third_party")
    if authority not in AUTHORITY_RANK:
        raise RecordError("authority must be one of " + ", ".join(sorted(AUTHORITY_RANK)))
    flags: list[str] = []
    if authority == "official" and not (url and _official_domain(url, official_domains)):
        authority = "verified"                      # an official-looking claim is not proof; the domain policy decides
        flags.append("official_claim_downgraded_to_verified: url is not on the official-domain allow-list")
    ex = str(p.get("extraction_status") or "auto_extracted")
    if ex not in ("auto_extracted", "reviewed"):
        raise RecordError("extraction_status must be auto_extracted or reviewed")
    clean, inj = sanitize_untrusted(text)
    if inj:
        flags.append("untrusted_content_sanitised: " + ",".join(inj))
    return RecruitmentRecord(
        record_id=rid, organization=norm_text(p["organization"])[:160], role=norm_text(p["role"])[:160],
        title=norm_text(str(p.get("title") or ""))[:200], advt_no=norm_text(str(p.get("advt_no") or ""))[:80],
        cycle=norm_text(str(p.get("cycle") or ""))[:40], url=url, text=clean, published_at=p.get("published_at"),
        opens_at=p.get("opens_at"), deadline=p.get("deadline"), location=norm_text(str(p.get("location") or ""))[:120],
        authority=authority, last_verified_at=p.get("last_verified_at"),
        source_status=str(p.get("source_status") or "never_checked") if str(p.get("source_status") or "never_checked")
        in ("reachable", "unreachable", "never_checked") else "never_checked",
        source_error=norm_text(str(p.get("source_error") or ""))[:200], extraction_status=ex,
        salary=norm_text(str(p.get("salary") or ""))[:200], criteria=list(p.get("criteria") or [])[:40],
        domain=str(p.get("domain") or "government") if str(p.get("domain") or "government") in
        ("government", "private", "exam", "learning", "career") else "government", flags=flags)


# ------------------------------------------------------------------------------------------------- registry
class RecordRegistry:
    """Authoritative store of recruitment records, kept in sync with the shared HybridIndex."""

    def __init__(self, index: HybridIndex, *, max_age_days: int = DEFAULT_MAX_VERIFICATION_AGE_DAYS,
                 snapshot_path: str = ""):
        self.index, self.max_age_days, self.snapshot_path = index, max_age_days, snapshot_path
        self._lock = threading.RLock()
        self.records: dict[str, RecruitmentRecord] = {}
        self._hashes: dict[str, str] = {}
        self._extra: dict[str, list[str]] = {}               # record_id -> registry-level flags (duplicates/ambiguity)
        self.persistence: dict = {"path": snapshot_path or None, "loaded": 0, "last_saved_at": None, "last_error": None}

    # -- core operations
    def upsert(self, rec: RecruitmentRecord, *, today: Optional[date] = None, now: Optional[datetime] = None) -> dict:
        with self._lock:
            chash = content_hash(rec.text)
            changed = self._hashes.get(rec.record_id) != chash
            self.records[rec.record_id] = rec
            self._hashes[rec.record_id] = chash
            self._resync(today=today, now=now)
            self._save()
            return self.describe(rec.record_id, today=today, now=now) | {"content_changed": changed}

    def mark_unreachable(self, record_id: str, error: str = "", *, today: Optional[date] = None, now: Optional[datetime] = None) -> dict:
        """Source could not be reached: keep the last successful verification time, never fabricate freshness."""
        with self._lock:
            rec = self._get(record_id)
            rec.source_status, rec.source_error = "unreachable", norm_text(error)[:200]
            self._resync(today=today, now=now)
            self._save()
            return self.describe(record_id, today=today, now=now)

    def mark_verified(self, record_id: str, *, at: Optional[str] = None, today: Optional[date] = None, now: Optional[datetime] = None) -> dict:
        with self._lock:
            rec = self._get(record_id)
            rec.source_status, rec.source_error = "reachable", ""
            rec.last_verified_at = at or (now or datetime.now(timezone.utc)).isoformat()
            self._resync(today=today, now=now)
            self._save()
            return self.describe(record_id, today=today, now=now)

    def remove(self, record_id: str) -> bool:
        with self._lock:
            if record_id not in self.records:
                return False
            del self.records[record_id], self._hashes[record_id]
            self.index.remove_source(f"rec:{record_id}")
            self._resync()
            self._save()
            return True

    def sweep(self, *, today: Optional[date] = None, now: Optional[datetime] = None) -> dict:
        """Re-classify every record (expiry and verification-age drift) so cached labels never outlive their facts."""
        with self._lock:
            before = {rid: self.status_of(rid, today=today, now=now) for rid in self.records}
            self._resync(today=today, now=now)
            changed = {rid: s for rid, s in before.items() if s != self.status_of(rid, today=today, now=now)}
            return {"records": len(self.records), "reclassified": len(changed)}

    # -- queries
    def _get(self, record_id: str) -> RecruitmentRecord:
        if record_id not in self.records:
            raise KeyError(record_id)
        return self.records[record_id]

    def status_of(self, record_id: str, *, today: Optional[date] = None, now: Optional[datetime] = None) -> str:
        return classify_status(self._get(record_id), today=today, now=now, max_age_days=self.max_age_days)["status"]

    def describe(self, record_id: str, *, today: Optional[date] = None, now: Optional[datetime] = None) -> dict:
        rec = self._get(record_id)
        st = classify_status(rec, today=today, now=now, max_age_days=self.max_age_days)
        return {"record_id": rec.record_id, "organization": rec.organization, "role": rec.role, "advt_no": rec.advt_no,
                "cycle": rec.cycle, "url": rec.url, "published_at": rec.published_at, "deadline": rec.deadline,
                "last_verified_at": rec.last_verified_at, "source_status": rec.source_status,
                "authority": rec.authority, "extraction_status": rec.extraction_status, "drive_status": st["status"],
                "status_reasons": st["reasons"], "verified_age_days": st["verified_age_days"],
                "flags": rec.flags + self._extra.get(rec.record_id, []),
                "salary_as_published": rec.salary or None}

    def find(self, *, record_id: str = "", organization: str = "", role: str = "", cycle: str = "",
             include_closed: bool = False, today: Optional[date] = None, now: Optional[datetime] = None) -> list[RecruitmentRecord]:
        out = []
        for rec in self.records.values():
            if record_id and rec.record_id != record_id:
                continue
            if organization and _slug(organization) not in _slug(rec.organization):
                continue
            if role and _slug(role) not in _slug(rec.role):
                continue
            if cycle and _slug(cycle) != _slug(rec.cycle):
                continue
            if not include_closed and not record_id and self.status_of(rec.record_id, today=today, now=now) == "closed":
                continue
            out.append(rec)
        return out

    def list(self, *, today: Optional[date] = None, now: Optional[datetime] = None) -> list[dict]:
        return [self.describe(rid, today=today, now=now) for rid in sorted(self.records)]

    # -- sync / dedupe
    def _resync(self, *, today: Optional[date] = None, now: Optional[datetime] = None) -> None:
        """Recompute statuses, supersede duplicates, and rewrite index chunks. Different drives are never merged."""
        self._extra = {}
        groups: dict[str, list[RecruitmentRecord]] = {}
        for r in self.records.values():
            groups.setdefault(r.drive_key(), []).append(r)
        # same drive from different URLs/versions: keep the strongest, supersede the rest (kept for audit, hidden by default)
        superseded: dict[str, str] = {}
        for key, grp in groups.items():
            if len(grp) < 2:
                continue
            grp.sort(key=lambda r: (-AUTHORITY_RANK.get(r.authority, 0), -(parse_ts(r.last_verified_at) or datetime.min.replace(tzinfo=timezone.utc)).timestamp(),
                                    -(parse_date(r.published_at) or date.min).toordinal(), r.record_id))
            for loser in grp[1:]:
                superseded[loser.record_id] = grp[0].record_id
                self._extra.setdefault(loser.record_id, []).append(f"duplicate_of:{grp[0].record_id}")
            self._extra.setdefault(grp[0].record_id, []).append("has_duplicates:" + ",".join(r.record_id for r in grp[1:]))
            for fld in ("deadline", "opens_at", "location"):
                vals = {getattr(r, fld) for r in grp if getattr(r, fld)}
                if len(vals) > 1:
                    self._extra[grp[0].record_id].append(
                        f"conflict:{fld} differs between copies of this drive ({', '.join(sorted(map(str, vals)))}); prefer the official notice and re-verify")
        # same organisation+role+cycle but DIFFERENT advertisement numbers -> separate drives; warn, never merge
        by_role: dict[str, set[str]] = {}
        for r in self.records.values():
            by_role.setdefault("|".join((_slug(r.organization), _slug(r.role), _slug(r.cycle))), set()).add(_slug(r.advt_no))
        for r in self.records.values():
            advts = by_role["|".join((_slug(r.organization), _slug(r.role), _slug(r.cycle)))]
            if len({a for a in advts if a}) > 1 and _slug(r.advt_no):
                self._extra.setdefault(r.record_id, []).append("multiple_drives_for_role: criteria differ per advertisement; do not combine")
        for rec in self.records.values():
            st = classify_status(rec, today=today, now=now, max_age_days=self.max_age_days)
            docs = to_documents(rec, st)
            if rec.record_id in superseded:
                for d in docs:
                    d.metadata["status"] = "superseded"
                    d.metadata["superseded_by"] = f"rec:{superseded[rec.record_id]}"
            self.index.upsert_source(f"rec:{rec.record_id}", docs)

    # -- optional persistence (public notice data only; never student data)
    def _save(self) -> None:
        if not self.snapshot_path:
            return
        tmp = None
        try:
            d = os.path.dirname(os.path.abspath(self.snapshot_path)) or "."
            os.makedirs(d, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"version": 1, "records": [r.to_dict() for r in self.records.values()]}, fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.snapshot_path)
            self.persistence.update(last_saved_at=datetime.now(timezone.utc).isoformat(), last_error=None)
        except OSError as exc:                      # best-effort: the in-memory registry stays correct, and status reports the failure
            self.persistence["last_error"] = type(exc).__name__
            if tmp and os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    def load(self) -> int:
        if not self.snapshot_path or not os.path.exists(self.snapshot_path):
            return 0
        try:
            with open(self.snapshot_path, encoding="utf-8") as fh:
                data = json.load(fh)
            with self._lock:
                for d in data.get("records", []):
                    rec = RecruitmentRecord(**{k: v for k, v in d.items() if k in RecruitmentRecord.__dataclass_fields__})
                    self.records[rec.record_id] = rec
                    self._hashes[rec.record_id] = content_hash(rec.text)
                self._resync()
            self.persistence["loaded"] = len(self.records)
            return len(self.records)
        except (OSError, ValueError, TypeError):
            self.persistence["last_error"] = "snapshot_unreadable"
            return 0
