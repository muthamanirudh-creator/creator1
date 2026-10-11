"""
Resume-tab AI/ML orchestration.

The Resume tab used to reach the FastAPI service in exactly one place (the vector match) and did everything else
through browser-side LLM keys, so when those keys were missing the tab showed "add an API key" instead of using the
AI/ML service that the Admin already configured. This module gives the tab three server-side capabilities that share
ONE deterministic, grounded evidence core:

  analyze()        resume vs JD/role  -> explainable skill match + ATS score + fit summary, gaps, bullets, tips
  ats_optimize()   resume vs JD       -> {atsScore, verdict, bulletRewrites, keywordsToAdd} (shape the UI already uses)
  enhance()        resume sections    -> rewritten summary / experience / projects

Design rules (same as roadmap.py / career_path.py):
  * Numbers (ATS score, coverage, similarity) are ALWAYS computed deterministically. The LLM only writes prose, so a
    model can never invent a score.
  * Every LLM call is optional. With no key / a provider failure we return a complete deterministic result plus a
    stable `llm_unavailable: true` flag, never a 500 and never provider/exception text.
  * LLM prose that states facts about the student is checked with ai_reliability against the evidence; an unsupported
    summary is replaced by the deterministic one.
  * The LLM is told not to invent employers, dates or numbers; use [X%]-style placeholders instead.
"""
import asyncio
import logging
import re
from typing import Optional

from app.services import matcher, parser
from app.services.ai_reliability import check_reliability
from app.services.llm_providers import call_llm, parse_json_loose

logger = logging.getLogger("ai_ml_service.resume")

MAX_TEXT = 12000          # characters of resume / JD text that ever reach the LLM
_MAX_ITEMS = 12


# ----------------------------------------------------------------------------------------------- helpers
def _clip(text: Optional[str], limit: int = MAX_TEXT) -> str:
    return (text or "").strip()[:limit]


def _str_list(value, limit: int = _MAX_ITEMS, max_len: int = 400) -> list[str]:
    """Normalise an LLM 'array of strings' field: accept a string, a list of strings/dicts, drop junk."""
    if isinstance(value, str):
        value = [p.strip(" -•\t") for p in re.split(r"\n+", value) if p.strip()]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, dict):
            item = item.get("text") or item.get("bullet") or item.get("point") or item.get("description") or ""
        if isinstance(item, (str, int, float)):
            s = str(item).strip()
            if s:
                out.append(s[:max_len])
        if len(out) >= limit:
            break
    return out


def _text_field(value, limit: int = 4000) -> str:
    """A section the LLM may return as a string OR a list of bullet strings -> one newline-joined string."""
    if isinstance(value, list):
        value = "\n".join(_str_list(value, limit=30, max_len=600))
    if isinstance(value, (int, float)):
        value = str(value)
    return value.strip()[:limit] if isinstance(value, str) else ""


def _skill_names(items: list) -> list[str]:
    return [str(i.get("skill")) for i in items if isinstance(i, dict) and i.get("skill")]


def build_evidence(resume_text: str, jd_text: str) -> dict:
    """Deterministic, explainable core shared by every endpoint. Never raises for ordinary text."""
    resume_text, jd_text = _clip(resume_text), _clip(jd_text)
    resume_skills = parser.extract_skills(resume_text) if resume_text else []
    jd_skills = parser.extract_skills(jd_text) if jd_text else []

    explained = matcher.explain_resume_jd_match(resume_skills, jd_skills, resume_text, jd_text) \
        if (resume_text and jd_text) else {
            "matched_skills": [], "partially_matched_skills": [], "missing_skills": [],
            "skill_coverage_score": 0.0, "semantic_similarity": 0.0, "backend": None, "embedding_engine": None,
        }

    similarity = float(explained.get("semantic_similarity") or 0.0)
    coverage = float(explained.get("skill_coverage_score") or 0.0)
    # With a recognisable skill list in the JD, coverage is the stronger, more explainable signal; the vector
    # similarity is blended in so paraphrased evidence still counts. Without JD skills, fall back to similarity.
    ats = 0.6 * coverage + 0.4 * similarity if jd_skills else similarity
    ats = round(max(0.0, min(100.0, ats)), 1)

    return {
        "resume_skills": resume_skills,
        "jd_skills": jd_skills,
        "matched": _skill_names(explained.get("matched_skills", [])),
        "partial": _skill_names(explained.get("partially_matched_skills", [])),
        "missing": _skill_names(explained.get("missing_skills", [])),
        "explained": explained,
        "semantic_similarity": round(similarity, 1),
        "skill_coverage_score": round(coverage, 1),
        "ats_score": ats,
        "backend": explained.get("backend"),
        "embedding_engine": explained.get("embedding_engine"),
    }


def _verdict(ats: float, matched: list[str], missing: list[str]) -> str:
    band = "strong" if ats >= 70 else "moderate" if ats >= 45 else "low"
    tail = f" Close the gap in {', '.join(missing[:3])} first." if missing else ""
    return f"{band.capitalize()} ATS fit ({round(ats)}/100); {len(matched)} required skill(s) already evidenced.{tail}"


def _fallback_bullets(ev: dict, role: str) -> list[str]:
    """Advisory templates (with visible placeholders) — honest when we cannot see the student's real facts."""
    have = (ev["matched"] or ev["resume_skills"] or ["your strongest skill"])[:3]
    need = (ev["missing"] or ev["partial"])[:3]
    bullets = [
        f"Built <project/feature> using {', '.join(have[:2])}, delivering <measurable result, e.g. [X%] faster or [N] users>.",
        f"Tested and deployed <project> with {have[-1]}; mention the tooling and one metric you can defend in an interview.",
    ]
    if need:
        bullets.append(f"If you have genuinely worked with {need[0]}, add a bullet naming where and how; otherwise build a small project that uses it.")
    else:
        bullets.append(f"Lead the resume with the skills most relevant to {role or 'the target role'} and quantify the impact of each project.")
    return bullets[:3]


def _fallback_tips(ev: dict) -> list[str]:
    tips = ["Put the most role-relevant skills in the first third of the resume.",
            "Start every bullet with an action verb and end it with a measurable outcome."]
    if ev["missing"]:
        tips.append(f"Missing keywords from the JD: {', '.join(ev['missing'][:6])} — add only those you can back with real work.")
    return tips


def _fallback_summary(ev: dict, role: str) -> str:
    target = role or "the target role"
    return (f"Your resume covers {len(ev['matched'])} of {len(ev['jd_skills'])} skills detected for {target} "
            f"(ATS score {round(ev['ats_score'])}/100)."
            + (f" Priority gaps: {', '.join(ev['missing'][:4])}." if ev["missing"] else " No required skill is missing."))


def _known_facts(ev: dict, role: str) -> list[str]:
    facts = [f"Target role: {role or 'the job description'}."]
    facts += [f"{s} is a skill the student already has." for s in ev["matched"] + ev["resume_skills"]]
    facts += [f"{s} is partially evidenced in the resume." for s in ev["partial"]]
    facts += [f"{s} is a missing skill, a gap for the role." for s in ev["missing"]]
    facts.append(f"The resume scores {round(ev['ats_score'])} out of 100 for ATS fit.")
    return facts


def _public_evidence(ev: dict) -> dict:
    ex = ev["explained"]
    return {
        "matched_skills": ex.get("matched_skills", []),
        "partially_matched_skills": ex.get("partially_matched_skills", []),
        "missing_skills": ex.get("missing_skills", []),
        "resume_skills": ev["resume_skills"],
        "jd_skills": ev["jd_skills"],
        "skill_coverage_score": ev["skill_coverage_score"],
        "semantic_similarity": ev["semantic_similarity"],
        "backend": ev["backend"],
        "embedding_engine": ev["embedding_engine"],
        "engine": ev["explained"].get("engine"),
        "jd_requirement_coverage": ev["explained"].get("jd_requirement_coverage"),
        "fallback_mode": bool(ev["explained"].get("fallback_mode")),
    }


async def _ask_llm(system: str, user: str, max_tokens: int) -> tuple[Optional[dict], Optional[str]]:
    """(parsed_json, provider) or (None, None). Provider/exception text is logged, never returned."""
    try:
        res = await call_llm(system, user, {"jsonMode": True, "maxTokens": max_tokens, "temperature": 0.4})
        return parse_json_loose(res["text"]), res.get("provider")
    except Exception as exc:  # noqa: BLE001 - LLMError, ValueError (bad JSON), network errors
        logger.warning("Resume LLM path failed, serving deterministic result: %s: %s", type(exc).__name__, exc)
        return None, None


_NO_INVENTION = (
    "Never invent employers, dates, degrees, tools or numbers that are not in the resume. "
    "Where a metric is unknown, write a placeholder such as [X%] or [N users] for the student to fill in."
)


# -------------------------------------------------------------------------------------------- endpoints
async def analyze(resume_text: str, jd_text: str, target_role: str = "") -> dict:
    # Embedding work is CPU-bound: keep it off the event loop so other requests (and the live status poll) stay responsive.
    ev = await asyncio.to_thread(build_evidence, resume_text, jd_text)
    role = (target_role or "").strip()[:120]

    result = {
        "target_role": role or None,
        "ats_score": ev["ats_score"],
        "semantic_similarity": ev["semantic_similarity"],
        "skill_coverage_score": ev["skill_coverage_score"],
        "matched": ev["matched"],
        "partial": ev["partial"],
        "missing": ev["missing"],
        "evidence": _public_evidence(ev),
        "fit_summary": _fallback_summary(ev, role),
        "strengths": [f"Evidence found for {s}." for s in ev["matched"][:5]],
        "gaps": [f"{s}: no evidence in the resume." for s in ev["missing"][:6]],
        "tailored_bullets": _fallback_bullets(ev, role),
        "formatting_tips": _fallback_tips(ev),
        "matching_engine": ev["explained"].get("engine"),
        "generated_by": "deterministic-evidence",
        "llm_unavailable": False,
    }
    if not (resume_text or "").strip():
        return result

    system = (
        "You are an expert campus-placement resume reviewer. Output ONLY strict JSON with keys: "
        '{"fit_summary": string (1-2 sentences), "strengths": [string] (max 5), "gaps": [string] (max 6), '
        '"tailored_bullets": [string] (exactly 3 improved resume bullets based ONLY on the resume content), '
        '"formatting_tips": [string] (max 4)}. '
        "Use the EVIDENCE block as ground truth about which skills are present or missing. " + _NO_INVENTION
    )
    user = (
        f"TARGET ROLE: {role or 'see job description'}\n"
        f"EVIDENCE: matched skills = {ev['matched']}; partially evidenced = {ev['partial']}; "
        f"missing = {ev['missing']}; ATS score = {ev['ats_score']}/100\n\n"
        f"RESUME:\n{_clip(resume_text, 6000)}\n\nJOB DESCRIPTION / ROLE:\n{_clip(jd_text, 4000)}"
    )
    data, provider = await _ask_llm(system, user, 1100)
    if data is None:
        result["llm_unavailable"] = True
        return result

    summary = _text_field(data.get("fit_summary"), 600)
    if summary:
        reliability = check_reliability(summary, _known_facts(ev, role))
        result["fit_summary_reliability"] = reliability
        if reliability.get("confidence_label") == "low":
            result["fit_summary_replaced"] = True      # keep the grounded deterministic sentence
        else:
            result["fit_summary"] = summary
    for key, limit in (("strengths", 5), ("gaps", 6), ("tailored_bullets", 3), ("formatting_tips", 4)):
        items = _str_list(data.get(key), limit=limit)
        if items:
            result[key] = items
    result["generated_by"] = f"llm:{provider}"
    return result


async def ats_optimize(resume_text: str, jd_text: str) -> dict:
    ev = await asyncio.to_thread(build_evidence, resume_text, jd_text)
    out = {
        "atsScore": round(ev["ats_score"]),
        "verdict": _verdict(ev["ats_score"], ev["matched"], ev["missing"]),
        "bulletRewrites": _fallback_bullets(ev, ""),
        "keywordsToAdd": (ev["missing"] + ev["partial"])[:10],
        "matched": ev["matched"],
        "missing": ev["missing"],
        "semantic_similarity": ev["semantic_similarity"],
        "skill_coverage_score": ev["skill_coverage_score"],
        "generated_by": "deterministic-evidence",
        "llm_unavailable": False,
    }
    if not (resume_text or "").strip() or not (jd_text or "").strip():
        return out

    system = (
        "You are an ATS (Applicant Tracking System) resume optimization expert for campus placements. Output ONLY "
        'strict JSON: {"verdict": string (one sentence), "bulletRewrites": [string, string, string], '
        '"keywordsToAdd": [string]}. bulletRewrites are 3 improved, keyword-rich resume bullets based on the '
        "resume content given; keywordsToAdd must come from the JD. " + _NO_INVENTION
    )
    user = (
        f"EVIDENCE: matched = {ev['matched']}; missing = {ev['missing']}; ATS score = {ev['ats_score']}/100\n\n"
        f"RESUME:\n{_clip(resume_text, 6000)}\n\nTARGET JOB DESCRIPTION:\n{_clip(jd_text, 4000)}"
    )
    data, provider = await _ask_llm(system, user, 900)
    if data is None:
        out["llm_unavailable"] = True
        return out

    verdict = _text_field(data.get("verdict"), 400)
    if verdict and check_reliability(verdict, _known_facts(ev, "")).get("confidence_label") != "low":
        out["verdict"] = verdict
    bullets = _str_list(data.get("bulletRewrites"), limit=3)
    if bullets:
        out["bulletRewrites"] = bullets
    jd_vocab = {s.lower() for s in ev["jd_skills"]}
    keywords = [k for k in _str_list(data.get("keywordsToAdd"), limit=12, max_len=60)
                if not jd_vocab or k.lower() in jd_vocab or k.lower() in (jd_text or "").lower()]
    if keywords:
        out["keywordsToAdd"] = keywords
    out["generated_by"] = f"llm:{provider}"
    return out


async def enhance(summary: str, experience: str, projects: str, skills: str, target_role: str = "") -> dict:
    role = (target_role or "").strip()[:120]
    out = {
        "summary": summary or "", "experience": experience or "", "projects": projects or "",
        "keywords_to_add": [], "generated_by": "unchanged", "llm_unavailable": False,
    }
    if not (summary or "").strip() and not (experience or "").strip() and not (projects or "").strip():
        return out

    system = (
        f"You are an expert campus-placement resume writer. Rewrite the candidate's sections to be concise, "
        f"achievement-oriented and ATS keyword-optimised for the role of {role or 'a software role'}. Return ONLY "
        'valid JSON with exactly these string fields: {"summary": string, "experience": string, "projects": string}. '
        "Separate bullets with newlines. Keep a section empty if the input for it was empty. " + _NO_INVENTION
    )
    user = (
        f"SUMMARY:\n{_clip(summary, 1500) or '(none provided)'}\n\n"
        f"EXPERIENCE:\n{_clip(experience, 3000) or '(none provided)'}\n\n"
        f"PROJECTS:\n{_clip(projects, 3000) or '(none provided)'}\n\nSKILLS:\n{_clip(skills, 800)}"
    )
    data, provider = await _ask_llm(system, user, 1200)
    if data is None:
        out["llm_unavailable"] = True
        return out

    for key in ("summary", "experience", "projects"):
        rewritten = _text_field(data.get(key))
        if rewritten and (out[key] or "").strip():      # never invent a section the student left empty
            out[key] = rewritten
    out["generated_by"] = f"llm:{provider}"
    return out
