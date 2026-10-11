"""Deterministic, three-valued eligibility engine.

Every criterion is evaluated by plain code to one of  meets | not_meets | unknown.  An LLM may help EXTRACT criteria (they
are accepted only if their quote appears verbatim in the notice text) or EXPLAIN results, but never decides them.

Overall verdicts
  eligible_confirmed     all mandatory criteria met, none unknown, criteria reviewed by a person, source official/verified,
                         drive active/upcoming
  eligible_provisional   all known criteria met but something is unconfirmed (unreviewed extraction, unofficial source,
                         drive not verified, optional criterion unknown)
  ineligible_confirmed   a mandatory criterion is not met, from a reviewed criteria set on an official/verified source
  ineligible_provisional a mandatory criterion is not met per auto-extracted / unofficial criteria - check the notice
  indeterminate          no failure, but at least one mandatory criterion cannot be determined (what is missing is listed)
  drive_closed           the drive's deadline has passed
Conversions are never guessed: CGPA<->percentage and different CGPA scales yield `unknown`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Optional

from .filters import parse_date
from .models import AUTHORITY_RANK, norm_text

MEETS, NOT_MEETS, UNKNOWN = "meets", "not_meets", "unknown"
KEYS = ("min_cgpa", "min_percentage", "degrees", "branches", "graduation_years", "max_active_backlogs",
        "max_total_backlogs", "max_age", "min_age", "required_skills", "certifications", "min_experience_years",
        "work_locations")

# canonical degree / branch aliases (lower-case, punctuation stripped)
DEGREES = {
    "btech": {"btech", "be", "b e", "b tech", "bachelor of technology", "bachelor of engineering", "b.e", "b.tech"},
    "mtech": {"mtech", "me", "m e", "m tech", "master of technology", "master of engineering", "m.e", "m.tech"},
    "bsc": {"bsc", "b sc", "bachelor of science", "b.sc"}, "msc": {"msc", "m sc", "master of science", "m.sc"},
    "bca": {"bca", "bachelor of computer applications"}, "mca": {"mca", "master of computer applications"},
    "mba": {"mba", "pgdm", "master of business administration"}, "bcom": {"bcom", "b com", "bachelor of commerce"},
    "ba": {"ba", "bachelor of arts"}, "diploma": {"diploma"},
}
BRANCHES = {
    "cse": {"cse", "computer science", "computer science and engineering", "computer science engineering", "cs"},
    "it": {"it", "information technology"}, "ece": {"ece", "electronics and communication", "electronics and communication engineering", "electronics communication"},
    "eee": {"eee", "electrical and electronics", "electrical and electronics engineering"},
    "ee": {"ee", "electrical", "electrical engineering"}, "mech": {"mech", "mechanical", "mechanical engineering"},
    "civil": {"civil", "civil engineering"}, "aiml": {"aiml", "ai ml", "ai and ml", "artificial intelligence and machine learning", "artificial intelligence"},
    "ds": {"data science", "ds", "ai and data science", "artificial intelligence and data science"},
    "chem": {"chemical", "chemical engineering"}, "instrumentation": {"instrumentation", "instrumentation engineering"},
}


def _norm(s: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", str(s or "").lower())).strip()


def _canon(value: Any, table: dict[str, set[str]]) -> Optional[str]:
    v = _norm(value)
    for canon, aliases in table.items():
        if v == canon or v in {_norm(a) for a in aliases}:
            return canon
    return None


def canon_degree(v: Any) -> Optional[str]:
    return _canon(v, DEGREES)


def canon_branch(v: Any) -> Optional[str]:
    return _canon(v, BRANCHES)


# ------------------------------------------------------------------------------------------------- data
@dataclass
class Criterion:
    key: str
    value: Any
    quote: str                           # verbatim from the notice
    mandatory: bool = True
    scale: float = 10.0                  # for min_cgpa
    as_of: Optional[str] = None          # for age limits (reference date stated in the notice)
    section: str = ""

    def to_dict(self) -> dict:
        return {"key": self.key, "value": self.value, "quote": self.quote, "mandatory": self.mandatory,
                "scale": self.scale, "as_of": self.as_of, "section": self.section}


def _text_has(source_text: str, quote: str) -> bool:
    return bool(quote) and _norm(quote) in _norm(source_text)


def validate_criteria(raw: list[dict], source_text: str) -> tuple[list[Criterion], list[dict]]:
    """Accept only well-formed criteria whose quote occurs verbatim in the notice. Returns (accepted, rejected-with-reason).
    This is the guard that stops an LLM-proposed (or caller-supplied) criterion that the source does not contain."""
    ok, bad = [], []
    for r in raw or []:
        try:
            key = r.get("key")
            if key not in KEYS:
                raise ValueError("unknown criterion key")
            if not _text_has(source_text, str(r.get("quote") or "")):
                raise ValueError("quote not found verbatim in the notice text")
            val = r.get("value")
            if key in ("min_cgpa", "min_percentage", "min_experience_years", "max_age", "min_age"):
                val = float(val)
                if val < 0 or val > 100:
                    raise ValueError("numeric value out of range")
            elif key in ("max_active_backlogs", "max_total_backlogs"):
                val = int(val)
                if val < 0 or val > 50:
                    raise ValueError("count out of range")
            elif key == "graduation_years":
                val = sorted({int(y) for y in (val if isinstance(val, (list, tuple)) else [val])})
                if not val or any(y < 1990 or y > 2100 for y in val):
                    raise ValueError("graduation year out of range")
            else:
                val = [str(x) for x in (val if isinstance(val, (list, tuple)) else [val]) if str(x).strip()]
                if not val:
                    raise ValueError("empty list")
            ok.append(Criterion(key=key, value=val, quote=norm_text(str(r["quote"]))[:400], mandatory=bool(r.get("mandatory", True)),
                                scale=float(r.get("scale") or 10.0), as_of=r.get("as_of"), section=str(r.get("section") or "")[:60]))
        except (ValueError, TypeError) as e:
            bad.append({"criterion": {k: r.get(k) for k in ("key", "value")}, "reason": str(e)})
    return ok, bad


# ------------------------------------------------------------------------------------------------- extraction
# explicit patterns (short aliases such as "be"/"me" are ordinary English words, so they are never matched bare)
_DEGREE_RX = {
    "btech": r"\bb\.?\s?tech\b|\bb\.e\b|\bbe\s*/\s*b\.?\s?tech|bachelor of (?:technology|engineering)|\bb\.?e\.?\s*\(",
    "mtech": r"\bm\.?\s?tech\b|\bm\.e\b|master of (?:technology|engineering)",
    "bsc": r"\bb\.?\s?sc\b|bachelor of science", "msc": r"\bm\.?\s?sc\b|master of science",
    "bca": r"\bbca\b|bachelor of computer applications", "mca": r"\bmca\b|master of computer applications",
    "mba": r"\bmba\b|\bpgdm\b", "bcom": r"\bb\.?\s?com\b", "ba": r"\bb\.a\b|bachelor of arts", "diploma": r"\bdiploma\b",
}

_NUM = r"(\d{1,3}(?:\.\d{1,2})?)"


def _sentences(text: str):
    for s in re.split(r"\n+|;|(?<=[A-Za-z0-9\)])\.\s+(?=[A-Z0-9])", text or ""):
        s = s.strip()
        if s:
            yield s


def extract_criteria(text: str) -> list[Criterion]:
    """Conservative regex extraction. Each result carries the sentence it came from. It finds only what it recognises;
    `coverage()` reports which criterion keys were found so a missing key is shown as 'not extracted', never assumed."""
    out: list[Criterion] = []
    seen: set[tuple] = set()

    def add(c: Criterion):
        k = (c.key, str(c.value))
        if k not in seen:
            seen.add(k)
            out.append(c)

    for s in _sentences(text):
        low = s.lower()
        q = norm_text(s)[:400]
        m = re.search(rf"{_NUM}\s*(?:/|out of)?\s*(10|4)?\s*(?:cgpa|cpi|gpa)|(?:cgpa|cpi|gpa)[^0-9]{{0,40}}{_NUM}(?:\s*(?:/|out of)\s*(10|4))?", low)
        if m:
            val = float(m.group(1) or m.group(3))
            scale = float(m.group(2) or m.group(4) or (4 if val <= 4.0 else 10))
            if 0 < val <= scale:
                add(Criterion("min_cgpa", val, q, scale=scale))
        m = re.search(rf"{_NUM}\s*%\s*(?:and above|or above|or more|aggregate|marks|throughout|in )?|(?:minimum|min\.?|at least)\s*(?:of\s*)?{_NUM}\s*(?:%|percent)", low)
        if m and re.search(r"aggregate|marks|percentage|throughout|academic|10th|12th|degree|graduation|cgpa|percent", low):
            val = float(m.group(1) or m.group(2))
            if 30 <= val <= 100 and not re.search(r"\b(10th|12th|x|xii)\b[^.]{0,30}" + re.escape(m.group(0)[:3]), low):
                add(Criterion("min_percentage", val, q))
        if re.search(r"no (?:active|current|standing|pending) (?:backlogs?|arrears?)|without (?:any )?(?:active|standing|current) (?:backlogs?|arrears?)", low):
            add(Criterion("max_active_backlogs", 0, q))
        if re.search(r"no (?:history of|previous) (?:backlogs?|arrears?)|no (?:backlogs?|arrears?) (?:history|in any semester|throughout)|should not have (?:any )?(?:backlogs?|arrears?)", low):
            add(Criterion("max_total_backlogs", 0, q))
        m = re.search(r"(?:not more than|maximum of|max\.?|at most|up to)\s*(\d{1,2})\s*(?:active |standing )?(?:backlogs?|arrears?)", low)
        if m:
            add(Criterion("max_active_backlogs" if re.search(r"active|standing", low) else "max_total_backlogs", int(m.group(1)), q))
        years = set()
        for m in re.finditer(r"((?:20\d{2}\s*(?:,|/|or|and|&)\s*)*20\d{2})\s*(?:batch|pass(?:ing)?[- ]?out|graduat\w*)|(?:batch of|pass(?:ing)?[- ]?out(?: in)?|graduat\w*(?: in)?|class of)\s*((?:20\d{2}(?:\s*(?:,|/|or|and|&)\s*)?)+)", low):
            for y in re.findall(r"20\d{2}", m.group(0)):
                years.add(int(y))
        if years:
            add(Criterion("graduation_years", sorted(years), q))
        m = re.search(r"(?:age|aged)[^0-9]{0,40}(\d{2})\s*(?:-|to|and)\s*(\d{2})\s*years", low)
        asof = re.search(r"as (?:on|of|at)\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})", low)
        asof_iso = f"{asof.group(3)}-{int(asof.group(2)):02d}-{int(asof.group(1)):02d}" if asof else None
        if m:
            add(Criterion("min_age", float(m.group(1)), q, as_of=asof_iso))
            add(Criterion("max_age", float(m.group(2)), q, as_of=asof_iso))
        else:
            m = re.search(r"(?:not (?:exceeding|more than|above)|maximum age(?: limit)?(?: of)?|upper age(?: limit)?(?: of)?|age limit(?: of)?)\s*:?\s*(\d{2})\s*years", low)
            if m:
                add(Criterion("max_age", float(m.group(1)), q, as_of=asof_iso))
        m = re.search(r"(?:minimum|at least|min\.?)\s*(\d{1,2})\+?\s*years?\s*(?:of\s*)?(?:relevant\s*)?experience|(\d{1,2})\+\s*years?\s*(?:of\s*)?experience", low)
        if m:
            add(Criterion("min_experience_years", float(m.group(1) or m.group(2)), q))
        if re.search(r"eligib|qualification|educational|degree|graduat|b\.?e\b|b\.?tech|m\.?tech|mca|b\.?sc", low):
            degs = [c for c, rx in _DEGREE_RX.items() if re.search(rx, low)]
            if degs:
                add(Criterion("degrees", sorted(set(degs)), q))
            # short aliases ("IT", "CS", "EE") are ordinary words in lower case, so they only match as upper-case tokens
            brs = [c for c, al in BRANCHES.items()
                   if any((re.search(rf"(?<![a-z]){re.escape(a)}(?![a-z])", low) if len(a) >= 3
                           else re.search(rf"(?<![A-Za-z]){re.escape(a.upper())}(?![A-Za-z])", s)) for a in al)]
            if brs and not re.search(r"any (?:branch|discipline|stream)|all (?:branches|disciplines)", low):
                add(Criterion("branches", sorted(set(brs)), q))
    return out


def coverage(criteria: list[Criterion]) -> dict:
    found = sorted({c.key for c in criteria})
    return {"extracted": found, "not_extracted": [k for k in KEYS if k not in found],
            "note": "A key listed under not_extracted was NOT found in the notice text; it is not assumed to be absent from the notice."}


# ------------------------------------------------------------------------------------------------- evaluation
@dataclass
class Result:
    key: str
    status: str
    required: Any
    student_value: Any
    reason: str
    mandatory: bool
    quote: str
    missing_profile_field: Optional[str] = None

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}  # type: ignore[attr-defined]


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _age(dob: Any, as_of: date) -> Optional[int]:
    d = parse_date(dob)
    if not d or d > as_of:
        return None
    return as_of.year - d.year - ((as_of.month, as_of.day) < (d.month, d.day))


def evaluate_criterion(c: Criterion, profile: dict, *, drive_deadline: Optional[str] = None, today: Optional[date] = None) -> Result:
    today = today or date.today()

    def res(status, sv, reason, missing=None):
        return Result(c.key, status, c.value, sv, reason, c.mandatory, c.quote, missing)

    k = c.key
    if k == "min_cgpa":
        sv, sc = _num(profile.get("cgpa")), _num(profile.get("cgpa_scale")) or 10.0
        if sv is None:
            return res(UNKNOWN, None, "Your CGPA was not provided.", "cgpa")
        if sc != c.scale:
            return res(UNKNOWN, sv, f"Your CGPA is on a {sc:g}-point scale but the notice uses {c.scale:g}; conversion is not guessed.", "cgpa_scale")
        return res(MEETS if sv >= c.value else NOT_MEETS, sv, f"{sv:g} {'>=' if sv >= c.value else '<'} required {c.value:g}.")
    if k == "min_percentage":
        sv = _num(profile.get("percentage"))
        if sv is None:
            if _num(profile.get("cgpa")) is not None:
                f = _num(profile.get("cgpa_to_percentage_factor"))
                if f:
                    sv = _num(profile.get("cgpa")) * f
                    return res(MEETS if sv >= c.value else NOT_MEETS, round(sv, 2),
                               f"Converted with your stated university factor {f:g}: {sv:.2f}% vs required {c.value:g}%.")
                return res(UNKNOWN, None, "Only CGPA was provided; CGPA-to-percentage conversion differs by university, so it is not assumed.", "percentage")
            return res(UNKNOWN, None, "Your percentage was not provided.", "percentage")
        return res(MEETS if sv >= c.value else NOT_MEETS, sv, f"{sv:g}% {'>=' if sv >= c.value else '<'} required {c.value:g}%.")
    if k == "degrees":
        sd = profile.get("degree")
        if not norm_text(str(sd or "")):
            return res(UNKNOWN, None, "Your degree was not provided.", "degree")
        cs = canon_degree(sd)
        if cs is None:
            return res(UNKNOWN, sd, "Your degree is not in the recognised list; compare manually with the notice.", "degree")
        want = {canon_degree(x) or _norm(x) for x in c.value}
        return res(MEETS if cs in want else NOT_MEETS, sd, f"{sd} {'is' if cs in want else 'is not'} among accepted degrees.")
    if k == "branches":
        sb = profile.get("branch")
        if not norm_text(str(sb or "")):
            return res(UNKNOWN, None, "Your branch was not provided.", "branch")
        cs = canon_branch(sb)
        want_raw = c.value
        want = {canon_branch(x) for x in want_raw}
        if cs in want and cs is not None:
            return res(MEETS, sb, f"{sb} is an accepted branch.")
        if cs is None or None in want:
            return res(UNKNOWN, sb, "Branch names could not be matched reliably; compare manually with the notice.", "branch")
        return res(NOT_MEETS, sb, f"{sb} is not among the accepted branches.")
    if k == "graduation_years":
        sy = _num(profile.get("graduation_year"))
        if sy is None:
            return res(UNKNOWN, None, "Your graduation year was not provided.", "graduation_year")
        ok = int(sy) in set(c.value)
        return res(MEETS if ok else NOT_MEETS, int(sy), f"Graduation year {int(sy)} {'is' if ok else 'is not'} in the eligible batch {c.value}.")
    if k in ("max_active_backlogs", "max_total_backlogs"):
        f = "active_backlogs" if k == "max_active_backlogs" else "total_backlogs"
        sv = _num(profile.get(f))
        if sv is None:
            return res(UNKNOWN, None, f"Your {f.replace('_', ' ')} count was not provided.", f)
        ok = sv <= c.value
        return res(MEETS if ok else NOT_MEETS, int(sv), f"{int(sv)} {'<=' if ok else '>'} allowed {c.value}.")
    if k in ("max_age", "min_age"):
        as_of = parse_date(c.as_of) or parse_date(drive_deadline)
        if as_of is None:
            return res(UNKNOWN, None, "The notice gives no reference date for the age limit.", "dob")
        sa = _age(profile.get("dob"), as_of)
        if sa is None:
            return res(UNKNOWN, None, "Your date of birth was not provided (or is invalid).", "dob")
        ok = sa <= c.value if k == "max_age" else sa >= c.value
        return res(MEETS if ok else NOT_MEETS, sa, f"Age {sa} on {as_of.isoformat()} {'satisfies' if ok else 'does not satisfy'} the {'maximum' if k == 'max_age' else 'minimum'} {c.value:g}. "
                   "Category-based age relaxations are not applied automatically.")
    if k in ("required_skills", "certifications"):
        f = "skills" if k == "required_skills" else "certifications"
        have = profile.get(f)
        if not isinstance(have, (list, tuple)) or not have:
            return res(UNKNOWN, None, f"Your {f} were not provided.", f)
        hv = {_norm(x) for x in have}
        missing = [x for x in c.value if _norm(x) not in hv]
        return res(NOT_MEETS if missing else MEETS, sorted(hv), ("Missing: " + ", ".join(missing)) if missing else "All listed items present.")
    if k == "min_experience_years":
        sv = _num(profile.get("experience_years"))
        if sv is None:
            return res(UNKNOWN, None, "Your years of experience were not provided.", "experience_years")
        return res(MEETS if sv >= c.value else NOT_MEETS, sv, f"{sv:g} {'>=' if sv >= c.value else '<'} required {c.value:g} years.")
    if k == "work_locations":
        pl = profile.get("preferred_locations")
        if not isinstance(pl, (list, tuple)) or not pl:
            return res(UNKNOWN, None, "Your location preference was not provided.", "preferred_locations")
        ok = bool({_norm(x) for x in pl} & {_norm(x) for x in c.value})
        return res(MEETS if ok else NOT_MEETS, list(pl), "Location " + ("matches." if ok else "does not match."))
    return res(UNKNOWN, None, "Unsupported criterion.")


def assess(record_desc: dict, criteria: list[Criterion], profile: dict, *, source_text: str = "", today: Optional[date] = None) -> dict:
    """Evaluate a student's profile against ONE drive's criteria. `record_desc` is RecordRegistry.describe()."""
    today = today or date.today()
    results = [evaluate_criterion(c, profile, drive_deadline=record_desc.get("deadline"), today=today) for c in criteria]
    failed = [r for r in results if r.status == NOT_MEETS and r.mandatory]
    unknown = [r for r in results if r.status == UNKNOWN and r.mandatory]
    optional_unknown = [r for r in results if r.status == UNKNOWN and not r.mandatory]
    drive = record_desc.get("drive_status")
    trusted = AUTHORITY_RANK.get(record_desc.get("authority"), 0) >= 2
    reviewed = record_desc.get("extraction_status") == "reviewed"
    caveats: list[str] = []
    if not criteria:
        caveats.append("No eligibility criteria could be read from this notice; nothing was assumed.")
    if not reviewed:
        caveats.append("Criteria were extracted automatically and not reviewed by a person; confirm them on the official notice.")
    if not trusted:
        caveats.append("The source is not an official/verified source.")
    if drive in ("unverified", "inaccessible"):
        caveats.append(f"The drive is '{drive}': " + "; ".join(record_desc.get("status_reasons") or []))
    if drive == "closed":
        verdict = "drive_closed"
    elif failed:
        verdict = "ineligible_confirmed" if (trusted and reviewed) else "ineligible_provisional"
    elif unknown or not criteria:
        verdict = "indeterminate"
    elif trusted and reviewed and drive in ("active", "upcoming") and not optional_unknown:
        verdict = "eligible_confirmed"
    else:
        verdict = "eligible_provisional"
    missing = sorted({r.missing_profile_field for r in unknown + optional_unknown if r.missing_profile_field})
    return {"record": {k: record_desc.get(k) for k in ("record_id", "organization", "role", "advt_no", "cycle", "url", "published_at",
                                                        "deadline", "last_verified_at", "drive_status", "authority", "extraction_status")},
            "verdict": verdict, "caveats": caveats, "missing_profile_fields": missing,
            "summary": {"meets": sum(r.status == MEETS for r in results), "not_meets": len(failed) + sum(r.status == NOT_MEETS and not r.mandatory for r in results),
                        "unknown": len(unknown) + len(optional_unknown)},
            "criteria": [r.to_dict() for r in results],
            "explanation": explain(verdict, results, missing)}


def explain(verdict: str, results: list[Result], missing: list[str]) -> str:
    """Deterministic explanation (no LLM): what passed, what failed, what is unknown."""
    lines = {"eligible_confirmed": "You meet every listed requirement.",
             "eligible_provisional": "You meet every requirement that could be checked, but the result is provisional (see caveats).",
             "ineligible_confirmed": "You do not meet at least one mandatory requirement.",
             "ineligible_provisional": "You appear not to meet at least one requirement, based on criteria that are not yet reviewed; verify on the notice.",
             "indeterminate": "Eligibility cannot be determined yet" + (": please provide " + ", ".join(missing) if missing else "."),
             "drive_closed": "This recruitment drive has closed."}
    parts = [lines[verdict]]
    for r in results:
        sym = {MEETS: "met", NOT_MEETS: "NOT met", UNKNOWN: "unknown"}[r.status]
        parts.append(f"- {r.key}: {sym} - {r.reason}")
    return "\n".join(parts)


def profile_from_input(p: dict) -> dict:
    """Validate/clean a student profile. Raises ValueError with a safe message. The profile is request-scoped only."""
    allowed = {"cgpa", "cgpa_scale", "percentage", "cgpa_to_percentage_factor", "degree", "branch", "graduation_year", "active_backlogs",
               "total_backlogs", "dob", "skills", "certifications", "experience_years", "preferred_locations"}
    out: dict[str, Any] = {}
    for k, v in (p or {}).items():
        if k not in allowed or v in (None, "", []):
            continue
        if k in ("cgpa", "cgpa_scale", "percentage", "cgpa_to_percentage_factor", "experience_years"):
            f = _num(v)
            if f is None or f < 0 or f > 100:
                raise ValueError(f"{k} must be a number between 0 and 100")
            out[k] = f
        elif k in ("graduation_year", "active_backlogs", "total_backlogs"):
            f = _num(v)
            if f is None or f != int(f) or f < 0 or f > 2100:
                raise ValueError(f"{k} must be a whole number")
            out[k] = int(f)
        elif k == "dob":
            if parse_date(v) is None:
                raise ValueError("dob must be YYYY-MM-DD")
            out[k] = str(v)[:10]
        elif k in ("skills", "certifications", "preferred_locations"):
            if not isinstance(v, (list, tuple)) or len(v) > 60:
                raise ValueError(f"{k} must be a list of up to 60 items")
            out[k] = [norm_text(str(x))[:80] for x in v if norm_text(str(x))]
        else:
            out[k] = norm_text(str(v))[:80]
    if "cgpa" in out and "cgpa_scale" in out and out["cgpa"] > out["cgpa_scale"]:
        raise ValueError("cgpa cannot exceed cgpa_scale")
    if "cgpa" in out and "cgpa_scale" not in out and out["cgpa"] > 10:
        raise ValueError("cgpa above 10 needs cgpa_scale")
    if "active_backlogs" in out and "total_backlogs" in out and out["active_backlogs"] > out["total_backlogs"]:
        raise ValueError("active_backlogs cannot exceed total_backlogs")
    return out
