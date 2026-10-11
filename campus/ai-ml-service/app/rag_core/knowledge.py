"""Pass B - knowledge store for private-sector hiring, exam, learning and career documents.

What this module guarantees (each one is covered by tests/test_rag_passb.py):

* Old or undated hiring information is labelled, never presented as a confirmed current requirement.
    freshness = current | historical | unverified | evergreen
  `historical`  - verified/published longer ago than the window for that kind, OR it describes a recruitment cycle that
                  ended more than a year ago, OR the record is explicitly expired.
  `unverified`  - no usable date, a date in the future, or the source is not official/verified (third-party report,
                  internal note, a claim of authority with no source URL).
  `evergreen`   - timeless material (concept explanations, career guides, question text) that does not age.
  The label is recomputed from the stored dates at READ time (`effective_labels`), so a record that was `current` when it
  was ingested becomes `historical` on its own as time passes - no sweep has to run for the label to be honest.
* AI-generated practice content is labelled as such (`content_origin=ai_generated`), carries a visible disclaimer inside the
  chunk text itself, can never hold `official`/`verified` authority, and an item that claims to be an official question bank
  without a source URL is downgraded instead of trusted.
* Answer keys NEVER enter the shared index. Fields such as `answer` / `solution` / `answer_key` / `explanation` and lines such as
  "Answer: B" are moved to a separate `AnswerKeyVault` that is not searchable and is only reachable through an
  authenticated, per-item call. `scan_index_for_answer_keys` re-checks the whole index as defence in depth.
* Public/org scoped only. A user's own documents stay request-scoped (`extra_docs`) and are never written here.
* Retrieved text stays untrusted DATA: instruction-like lines are stripped at ingest (the pipeline strips them again at use).

This module performs no outbound fetching (push-based, like ingest.py), so it adds no SSRF surface. It never invents source
content: an item with no text is rejected, and nothing is seeded.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Optional

from .filters import parse_date
from .models import AUTHORITY_RANK, RagDocument, content_hash, norm_text
from .security import sanitize_untrusted
from .store import HybridIndex

KNOWLEDGE_DOMAINS = ("private", "exam", "learning", "career")      # "government" belongs to the recruitment registry (Pass 2)

# kind -> (default domain, ages?)   `ages` kinds are the ones where an old copy can mislead about what is required today.
KINDS: dict[str, tuple[str, bool]] = {
    "company_hiring": ("private", True),
    "job_description": ("private", True),
    "hiring_process": ("private", True),
    "interview_experience": ("private", True),
    "exam_pattern": ("exam", True),
    "exam_syllabus": ("exam", True),
    "cutoff": ("exam", True),
    "study_material": ("learning", False),
    "question_bank": ("learning", False),
    "practice_question": ("learning", False),
    "mock_test": ("learning", False),
    "career_guide": ("career", False),
    "answer_key": ("learning", False),                              # accepted only to be routed to the vault, never indexed
}
PRACTICE_KINDS = {"practice_question", "mock_test"}
ORIGINS = ("official", "curated", "third_party", "ai_generated", "user")
AUTHORITIES = ("official", "verified", "internal", "third_party")

WINDOW_DAYS = {"private": 365, "exam": 730}                          # how long a verified date keeps hiring/exam info "current"
CYCLE_GRACE_YEARS = 1                                                # a cycle whose year is older than (this year - grace) is historical

AI_PRACTICE_LABEL = "AI-generated practice content - not official exam material and not from a past paper."
LABEL_TEXT = {
    "historical": "Historical information - may not match the current requirements. Verify on the official source.",
    "unverified": "Unverified information - undated or not from an official source. Do not treat it as confirmed.",
    "current": "Verified recently.",
    "evergreen": "General material that does not depend on a recruitment cycle.",
}

_ID = re.compile(r"^[A-Za-z0-9:_.\-]{1,80}$")
_ANSWER_FIELDS = ("answer", "answers", "answer_key", "correct_option", "correct_answer", "solution", "worked_solution", "explanation")
# A line that gives the answer away. Anchored to the line start so prose such as "the answer depends on ..." is left alone.
_ANSWER_LINE = re.compile(r"^\s*(?:[-*>#\d.)\s]*)(?:answer(?:\s*key)?|ans|correct\s+(?:option|answer)|solution|worked\s+solution|key)\s*[:=\-\u2013]\s*\S", re.I)
_ANSWER_INLINE = re.compile(r"(?:(?<=[.!?:;])|(?<=\s))\s*\b(?:answer(?:\s*key)?|correct\s+(?:option|answer)|worked\s+solution|solution)\s*[:=]\s*\S.*$", re.I)
_ANSWER_KEY_TABLE = re.compile(r"^\s*(?:q(?:uestion)?\s*)?\d{1,3}\s*[.):\-\u2013]\s*\(?[a-eA-E]\)?\s*$")
_URL = re.compile(r"^https?://[^\s]+$", re.I)
_YEAR = re.compile(r"\b(20\d{2}|19\d{2})\b")


class KnowledgeError(ValueError):
    """Payload rejected. The message is safe to show to an admin."""


# ----------------------------------------------------------------------------------------------------- labels
def _cycle_year(cycle: Any) -> Optional[int]:
    years = [int(y) for y in _YEAR.findall(str(cycle or ""))]
    return max(years) if years else None


def effective_labels(md: dict, today: Optional[date] = None) -> dict:
    """Freshness + origin labels computed from the stored dates NOW. Pure function of metadata."""
    today = today or date.today()
    kind = str(md.get("doc_type") or "")
    domain = str(md.get("domain") or "career")
    ages = bool(md.get("ages")) if "ages" in md else KINDS.get(kind, ("", False))[1]
    origin = str(md.get("content_origin") or ("third_party" if md.get("authority") == "third_party" else "curated"))
    out: dict[str, Any] = {"content_origin": origin, "practice_label": AI_PRACTICE_LABEL if origin == "ai_generated" else None}
    reasons: list[str] = []

    if not ages:
        out.update(freshness="evergreen", freshness_reasons=[], label=LABEL_TEXT["evergreen"])
        return out

    authority = str(md.get("authority") or "internal")
    pub, ver = parse_date(md.get("published_at")), parse_date(md.get("last_verified_at"))
    exp = parse_date(md.get("expires_at"))
    ref = max([d for d in (pub, ver) if d], default=None)
    future = [d for d in (pub, ver) if d and d > today]
    window = int(md.get("window_days") or WINDOW_DAYS.get(domain, 365))
    cyc = _cycle_year(md.get("cycle"))

    historical = False
    if str(md.get("status")) in ("expired", "superseded", "withdrawn") or (exp and exp < today):
        historical = True
        reasons.append("record_expired_or_superseded")
    if cyc is not None and cyc < today.year - CYCLE_GRACE_YEARS:
        historical = True
        reasons.append(f"cycle_{cyc}_is_over_a_year_old")
    if ref and not future and (today - ref).days > window:
        historical = True
        reasons.append(f"not_verified_for_{(today - ref).days}_days")

    unverified = False
    if future:
        unverified = True
        reasons.append("date_in_the_future")
    if ref is None:
        unverified = True
        reasons.append("no_date")
    if AUTHORITY_RANK.get(authority, 0) < AUTHORITY_RANK["verified"]:
        unverified = True
        reasons.append("not_an_official_or_verified_source")

    # historical wins over unverified: it is the stronger, date-based statement; both reasons are still reported.
    label = "historical" if historical else "unverified" if unverified else "current"
    out.update(freshness=label, freshness_reasons=reasons, label=LABEL_TEXT[label])
    return out


def annotate(cands, today: Optional[date] = None) -> dict:
    """Write the effective labels into each candidate's chunk metadata (idempotent) and return a summary the pipeline
    turns into warnings and prompt notes. Candidates from other domains (government records) are left alone."""
    summary = {"historical": [], "unverified": [], "ai_generated": []}
    for c in cands:
        md = c.doc.metadata
        if not md.get("knowledge_item"):
            continue
        lab = effective_labels(md, today)
        for k, v in lab.items():
            md[k] = v
        if lab["freshness"] in ("historical", "unverified"):
            c.flags.append(lab["freshness"] + "_information")
            summary[lab["freshness"]].append(c)
        if lab["content_origin"] == "ai_generated":
            c.flags.append("ai_generated_practice")
            summary["ai_generated"].append(c)
    return summary


# ----------------------------------------------------------------------------------------------------- answer keys
def split_answer_lines(text: str) -> tuple[str, list[str]]:
    """Remove answer-revealing text from `text`: whole lines ("Answer: B", "7. C" key rows) and the tail of a line that
    continues with "... Answer: B". Returns (clean text, removed fragments)."""
    keep, removed = [], []
    for ln in (text or "").splitlines():
        if _ANSWER_LINE.match(ln) or _ANSWER_KEY_TABLE.match(ln):
            removed.append(ln.strip())
            continue
        m = _ANSWER_INLINE.search(ln)
        if m and m.start() > 0:
            removed.append(ln[m.start():].strip())
            ln = ln[:m.start()].rstrip()
        keep.append(ln)
    return "\n".join(keep), removed


def looks_like_answer_key(text: str) -> bool:
    """True when the text contains an answer-revealing line/fragment, or a run of 5+ `1. B`-style key rows."""
    lines = (text or "").splitlines() or [text or ""]
    if any(_ANSWER_LINE.match(ln) or _ANSWER_INLINE.search(ln) for ln in lines):
        return True
    return sum(1 for ln in lines if _ANSWER_KEY_TABLE.match(ln)) >= 5


def scan_index_for_answer_keys(index: HybridIndex) -> list[str]:
    """Ids of knowledge chunks in the shared index that still look like they contain an answer key. Must be empty."""
    return [d.id for d in index.docs if d.metadata.get("knowledge_item")
            and (looks_like_answer_key(d.text) or d.metadata.get("doc_type") == "answer_key")]


def _norm_answer(v: Any) -> str:
    return re.sub(r"[\s.,;:()\[\]]+", "", str(v or "")).lower()


class AnswerKeyVault:
    """Answer keys and worked solutions, stored apart from the retrieval index. Not searchable, not embedded, never sent to
    an LLM by this module. Reaching an entry needs an authenticated user id (the gateway sets it) and the exact item id."""

    def __init__(self, path: str = ""):
        self._lock = threading.RLock()
        self._items: dict[str, dict] = {}
        self.path, self.error = path, None

    def put(self, item_id: str, entry: dict) -> None:
        with self._lock:
            self._items[item_id] = entry
            self._save()

    def drop(self, item_id: str) -> bool:
        with self._lock:
            had = self._items.pop(item_id, None) is not None
            if had:
                self._save()
            return had

    def has(self, item_id: str) -> bool:
        return item_id in self._items

    def __len__(self) -> int:
        return len(self._items)

    def get_raw(self, item_id: str) -> dict:
        """Internal merge helper (server code only; never exposed through a route)."""
        return dict(self._items.get(item_id) or {})

    def reveal(self, item_id: str, requester: Optional[dict]) -> Optional[dict]:
        """The stored key, or None when the caller is anonymous or the item has no key."""
        if not (requester or {}).get("user_id"):
            return None
        e = self._items.get(item_id)
        return dict(e) if e else None

    def check(self, item_id: str, submitted: Any, requester: Optional[dict]) -> Optional[bool]:
        """True/False for an exact (whitespace/punctuation/case-insensitive) match against the stored answer; None when the
        caller is anonymous, there is no key, or the stored answer is free-form text that cannot be compared exactly.
        The correct answer is not returned."""
        e = self.reveal(item_id, requester)
        if not e:
            return None
        want = e.get("answer") or e.get("correct_option") or e.get("correct_answer")
        if want is None or len(str(want)) > 40:
            return None
        return _norm_answer(submitted) == _norm_answer(want)

    # persistence ---------------------------------------------------------------------------------------------
    def _save(self) -> None:
        if not self.path:
            return
        try:
            _atomic_json(self.path, self._items, mode=0o600)
            self.error = None
        except Exception as exc:                                      # noqa: BLE001 - disk full / read-only: stay in memory
            self.error = type(exc).__name__

    def load(self) -> int:
        try:
            if self.path and os.path.exists(self.path):
                with open(self.path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if isinstance(data, dict):
                    self._items = {str(k): v for k, v in data.items() if isinstance(v, dict)}
        except Exception as exc:                                      # noqa: BLE001
            self.error = type(exc).__name__
        return len(self._items)


def _atomic_json(path: str, data: Any, mode: Optional[int] = None) -> None:
    d = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, sort_keys=True)
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ----------------------------------------------------------------------------------------------------- chunking
def chunk_text(text: str, max_chars: int = 900) -> list[tuple[str, str]]:
    """Split on markdown headings / blank lines into (section, chunk) pairs. A heading is kept as `section` and a chunk never
    crosses one, so a retrieved passage still says which part of the document it came from."""
    section, buf, out = "", [], []

    def flush():
        body = norm_text(" ".join(buf))
        if body:
            out.append((section, body))
        buf.clear()

    for block in re.split(r"\n\s*\n", text or ""):
        block = block.strip()
        if not block:
            continue
        m = re.match(r"^(#{1,6})\s+(.+?)\s*$", block.splitlines()[0])
        if m:
            flush()
            section = m.group(2).strip()[:120]
            block = "\n".join(block.splitlines()[1:]).strip()
            if not block:
                continue
        if buf and len(norm_text(" ".join(buf))) + len(block) > max_chars:
            flush()
        if len(block) > max_chars:                                   # oversized paragraph: split on sentence ends
            flush()
            cur = ""
            for s in re.split(r"(?<=[.!?])\s+", block):
                if cur and len(cur) + len(s) > max_chars:
                    out.append((section, norm_text(cur)))
                    cur = ""
                cur += (" " if cur else "") + s
            if cur.strip():
                out.append((section, norm_text(cur)))
        else:
            buf.append(block)
    flush()
    return out


# ----------------------------------------------------------------------------------------------------- the store
@dataclass
class KnowledgeStore:
    index: HybridIndex
    vault: AnswerKeyVault = field(default_factory=AnswerKeyVault)
    snapshot_path: str = ""
    items: dict[str, dict] = field(default_factory=dict)             # item_id -> public item record (no answer keys)
    _lock: threading.RLock = field(default_factory=threading.RLock)
    error: Optional[str] = None

    # -- validation ----------------------------------------------------------------------------------------
    @staticmethod
    def _clean_payload(p: dict) -> dict:
        iid = str(p.get("item_id") or "").strip()
        if not _ID.match(iid):
            raise KnowledgeError("item_id must be 1-80 characters of letters, digits and : _ . -")
        kind = str(p.get("kind") or "").strip().lower()
        if kind not in KINDS:
            raise KnowledgeError(f"kind must be one of: {', '.join(sorted(KINDS))}")
        domain = str(p.get("domain") or KINDS[kind][0]).strip().lower()
        if domain not in KNOWLEDGE_DOMAINS:
            raise KnowledgeError("domain must be one of private, exam, learning, career (government notices use /records)")
        title = norm_text(p.get("title"))[:200]
        text = str(p.get("text") or "")
        if len(norm_text(text)) < 40 and kind != "answer_key":
            raise KnowledgeError("text is too short to be a source document (min 40 characters); nothing is invented to fill it")
        if len(text) > 200_000:
            raise KnowledgeError("text is too long (max 200000 characters)")
        scope = str(p.get("scope") or "public").strip()
        if scope != "public" and not re.match(r"^org:[A-Za-z0-9_.\-]{1,60}$", scope):
            raise KnowledgeError("scope must be 'public' or 'org:<id>'; personal documents are request-scoped and never stored here")
        url = str(p.get("url") or "").strip()
        if url and not _URL.match(url):
            raise KnowledgeError("url must be an absolute http(s) URL")
        dates = {}
        for k in ("published_at", "last_verified_at", "expires_at"):
            v = p.get(k)
            if v in (None, ""):
                dates[k] = None
                continue
            if parse_date(v) is None:
                raise KnowledgeError(f"{k} must be an ISO date (YYYY-MM-DD)")
            dates[k] = str(v)[:10]
        authority = str(p.get("authority") or "third_party").strip().lower()
        if authority not in AUTHORITIES:
            raise KnowledgeError(f"authority must be one of: {', '.join(AUTHORITIES)}")
        origin = str(p.get("content_origin") or "").strip().lower()
        if origin and origin not in ORIGINS:
            raise KnowledgeError(f"content_origin must be one of: {', '.join(ORIGINS)}")
        return {"item_id": iid, "kind": kind, "domain": domain, "title": title, "text": text, "scope": scope, "url": url,
                "authority": authority, "origin": origin, "ai_generated": bool(p.get("ai_generated")), **dates,
                "organization": norm_text(p.get("organization"))[:160], "role": norm_text(p.get("role"))[:160],
                "location": norm_text(p.get("location"))[:120], "cycle": norm_text(p.get("cycle"))[:40],
                "batch": norm_text(p.get("batch"))[:40], "language": norm_text(p.get("language") or "en")[:10].lower(),
                "answer_fields": {k: p[k] for k in _ANSWER_FIELDS if p.get(k) not in (None, "")}}

    # -- ingest --------------------------------------------------------------------------------------------
    def ingest(self, payload: dict, *, today: Optional[date] = None) -> dict:
        c = self._clean_payload(payload)
        iid, kind = c["item_id"], c["kind"]
        downgrades: list[str] = []

        # 1) answer keys leave the text BEFORE anything else touches it
        clean_text, removed_lines = split_answer_lines(c["text"])
        key_entry = dict(c["answer_fields"])
        if removed_lines:
            key_entry["lines"] = removed_lines
        if kind == "answer_key":                                      # a whole key document: vault only, nothing indexed
            body = {"lines": [ln for ln in c["text"].splitlines() if ln.strip()]} if c["text"].strip() else {}
            body.update(key_entry)
            if not body:
                raise KnowledgeError("answer_key items must contain the key text")
            target = str(payload.get("for_item_id") or "").strip()
            if not _ID.match(target):
                raise KnowledgeError("answer_key items need for_item_id (the question item they belong to)")
            self.vault.put(target, {**self.vault.get_raw(target), **body})
            return {"item_id": target, "indexed": False, "answer_key_stored": True, "chunks": 0,
                    "note": "Stored in the answer-key vault only; it is not searchable and not in the shared index."}

        # 2) authority / origin rules (no label can be bought with a claim)
        authority, origin = c["authority"], c["origin"]
        ai = c["ai_generated"] or origin == "ai_generated"
        if kind in PRACTICE_KINDS and origin not in ("official", "curated", "user", "third_party"):
            ai = True                                                  # practice content with no declared origin is treated as AI-generated
        if ai:
            origin = "ai_generated"
            if AUTHORITY_RANK.get(authority, 0) > AUTHORITY_RANK["internal"]:
                downgrades.append(f"authority {authority}->internal (AI-generated content cannot be official or verified)")
                authority = "internal"
        elif not origin:
            origin = "official" if authority in ("official", "verified") and c["url"] else "third_party" if authority == "third_party" else "curated"
        if AUTHORITY_RANK.get(authority, 0) >= AUTHORITY_RANK["verified"] and not c["url"]:
            downgrades.append(f"authority {authority}->internal (an official/verified claim needs a source url)")
            authority = "internal"
            if origin == "official":
                origin = "curated"
        if origin == "official" and not c["url"]:
            downgrades.append("content_origin official->curated (no source url)")
            origin = "curated"

        # 3) sanitise (untrusted data) and chunk
        safe, inj_flags = sanitize_untrusted(clean_text)
        chunks = chunk_text(safe)
        if not chunks:
            raise KnowledgeError("nothing indexable remained after removing answer keys and instruction-like lines")

        # 4) duplicate content under another id is reported, not indexed twice
        h = content_hash(" ".join(t for _, t in chunks))
        with self._lock:
            dup = next((o for o, rec in self.items.items() if o != iid and rec.get("content_hash") == h and rec.get("scope") == c["scope"]), None)
            if dup:
                return {"item_id": iid, "indexed": False, "duplicate_of": dup, "chunks": 0,
                        "note": "Identical content is already indexed under another item; nothing was added."}

            domain = c["domain"]
            base = {"domain": domain, "authority": authority, "scope": c["scope"], "status": "active", "doc_type": kind,
                    "knowledge_item": True, "ages": KINDS[kind][1], "content_origin": origin, "ai_generated": ai,
                    "organization": c["organization"] or None, "role": c["role"] or None, "location": c["location"] or None,
                    "cycle": c["cycle"] or None, "batch": c["batch"] or None, "language": c["language"], "url": c["url"] or None,
                    "published_at": c["published_at"], "last_verified_at": c["last_verified_at"], "expires_at": c["expires_at"],
                    "item_id": iid, "has_answer_key": bool(key_entry), "injection_flagged": bool(inj_flags)}
            base = {k: v for k, v in base.items() if v not in (None, "")}
            prefix = f"[{AI_PRACTICE_LABEL}] " if ai else ""
            docs = []
            for i, (section, body) in enumerate(chunks):
                md = dict(base)
                if section:
                    md["section"] = section
                docs.append(RagDocument(text=prefix + body, source_id=f"kn:{iid}", title=c["title"] or iid, ordinal=i, metadata=md))
            if any(looks_like_answer_key(d.text) for d in docs):         # defence in depth: stripping above should make this impossible
                raise KnowledgeError("the text still contains an answer key after separation; move it into the `answer` field")
            counts = self.index.upsert_source(f"kn:{iid}", docs)

            if key_entry:
                self.vault.put(iid, key_entry)
            elif self.vault.has(iid) and not payload.get("keep_existing_key"):
                self.vault.drop(iid)                                   # re-ingest without a key replaces the old key
            rec = {k: v for k, v in c.items() if k not in ("text", "answer_fields", "origin", "ai_generated")}
            rec.update(authority=authority, content_origin=origin, ai_generated=ai, content_hash=h, chunks=len(docs),
                       injection_flagged=bool(inj_flags), has_answer_key=bool(key_entry), downgrades=downgrades)
            self.items[iid] = rec
            self._save()

        lab = effective_labels({**docs[0].metadata}, today)
        return {"item_id": iid, "indexed": True, "chunks": len(docs), **counts, "freshness": lab["freshness"],
                "freshness_reasons": lab["freshness_reasons"], "content_origin": origin, "ai_generated": ai,
                "answer_key_separated": bool(key_entry), "answer_lines_removed": len(removed_lines),
                "injection_lines_removed": bool(inj_flags), "downgrades": downgrades}

    def remove(self, item_id: str) -> bool:
        with self._lock:
            n = self.index.remove_source(f"kn:{item_id}")
            had_key = self.vault.drop(item_id)
            rec = self.items.pop(item_id, None)
            if rec is not None or n or had_key:
                self._save()
            return bool(rec) or n > 0 or had_key

    # -- reads (never include answer keys) -------------------------------------------------------------------
    def listing(self, today: Optional[date] = None, *, domain: str = "") -> list[dict]:
        out = []
        for iid, rec in sorted(self.items.items()):
            if domain and rec.get("domain") != domain:
                continue
            md = {"doc_type": rec["kind"], "domain": rec["domain"], "authority": rec["authority"], "ages": KINDS[rec["kind"]][1],
                  "content_origin": rec["content_origin"], "published_at": rec.get("published_at"),
                  "last_verified_at": rec.get("last_verified_at"), "expires_at": rec.get("expires_at"), "cycle": rec.get("cycle")}
            lab = effective_labels(md, today)
            out.append({"item_id": iid, "title": rec["title"], "kind": rec["kind"], "domain": rec["domain"], "organization": rec.get("organization"),
                        "role": rec.get("role"), "cycle": rec.get("cycle"), "batch": rec.get("batch"), "url": rec.get("url"), "authority": rec["authority"],
                        "published_at": rec.get("published_at"), "last_verified_at": rec.get("last_verified_at"), "chunks": rec["chunks"],
                        "has_answer_key": rec["has_answer_key"], "downgrades": rec.get("downgrades", []), **lab})
        return out

    def summary(self, today: Optional[date] = None) -> dict:
        rows = self.listing(today)
        by_fresh: dict[str, int] = {}
        for r in rows:
            by_fresh[r["freshness"]] = by_fresh.get(r["freshness"], 0) + 1
        return {"items": len(rows), "by_freshness": by_fresh, "ai_generated": sum(1 for r in rows if r["content_origin"] == "ai_generated"),
                "answer_keys_in_vault": len(self.vault), "answer_key_leaks_in_index": scan_index_for_answer_keys(self.index),
                "persistence": {"path": self.snapshot_path or None, "error": self.error, "vault_error": self.vault.error}}

    # -- persistence -----------------------------------------------------------------------------------------
    def _save(self) -> None:
        """Snapshot = item records + the CLEAN chunk text needed to rebuild the index. Answer keys live only in the vault file."""
        if not self.snapshot_path:
            return
        try:
            chunks: dict[str, list[dict]] = {}
            for d in self.index.docs:
                if d.metadata.get("knowledge_item"):
                    chunks.setdefault(str(d.metadata["item_id"]), []).append({"ordinal": d.ordinal, "text": d.text, "section": d.metadata.get("section")})
            _atomic_json(self.snapshot_path, {"version": 1, "items": self.items, "chunks": chunks})
            self.error = None
        except Exception as exc:                                      # noqa: BLE001
            self.error = type(exc).__name__

    def load(self) -> int:
        """Rebuild the index from the snapshot (no re-ingest, so no re-sanitising drift and no embedding of unchanged text twice)."""
        try:
            if not (self.snapshot_path and os.path.exists(self.snapshot_path)):
                return 0
            with open(self.snapshot_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            items, chunks = data.get("items") or {}, data.get("chunks") or {}
            n = 0
            for iid, rec in items.items():
                if iid not in chunks or rec.get("kind") not in KINDS:
                    continue
                domain = rec["domain"]
                base = {"domain": domain, "authority": rec["authority"], "scope": rec.get("scope", "public"), "status": "active",
                        "doc_type": rec["kind"], "knowledge_item": True, "ages": KINDS[rec["kind"]][1], "content_origin": rec["content_origin"],
                        "ai_generated": rec.get("ai_generated", False), "organization": rec.get("organization"), "role": rec.get("role"),
                        "location": rec.get("location"), "cycle": rec.get("cycle"), "batch": rec.get("batch"), "language": rec.get("language", "en"),
                        "url": rec.get("url"), "published_at": rec.get("published_at"), "last_verified_at": rec.get("last_verified_at"),
                        "expires_at": rec.get("expires_at"), "item_id": iid, "has_answer_key": rec.get("has_answer_key", False)}
                base = {k: v for k, v in base.items() if v not in (None, "")}
                docs = []
                for ch in sorted(chunks[iid], key=lambda x: x["ordinal"]):
                    md = dict(base)
                    if ch.get("section"):
                        md["section"] = ch["section"]
                    docs.append(RagDocument(text=ch["text"], source_id=f"kn:{iid}", title=rec.get("title") or iid, ordinal=ch["ordinal"], metadata=md))
                if docs:
                    self.index.upsert_source(f"kn:{iid}", docs)
                    self.items[iid] = rec
                    n += 1
            return n
        except Exception as exc:                                      # noqa: BLE001 - a corrupt snapshot must not stop the service
            self.error = type(exc).__name__
            return 0

    def load_directory(self, path: str) -> dict:
        """Optional bulk load of `*.json` item payloads (one object or a list per file) from an admin-managed folder."""
        res = {"loaded": 0, "failed": []}
        if not (path and os.path.isdir(path)):
            return res
        for name in sorted(os.listdir(path)):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(path, name), "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                for p in (data if isinstance(data, list) else [data]):
                    self.ingest(p)
                    res["loaded"] += 1
            except (KnowledgeError, ValueError, OSError) as exc:
                res["failed"].append({"file": name, "error": str(exc)[:160]})
        return res
