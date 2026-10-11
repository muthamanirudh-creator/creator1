"""AI-powered skill-gap analysis used by the Resume/Career Fit flow.

Two cooperating layers, each doing what it is good at:

  1. LIVE LLM (Groq/Gemini) proposes the skills the target role needs - it can handle any role, however niche.
     If no provider answers, the curated role catalogue (app/services/role_catalog.py) supplies the requirements.
  2. SEMANTIC MATCHER (transformer sentence embeddings, app/services/matcher.py) then judges every requirement
     against the student's skills AND resume sentences by meaning. The LLM no longer decides who "has" a skill, so
     a model can neither flatter nor misjudge the student, and every verdict carries a similarity score and the
     resume line that supports it.

If the embedding model is unavailable the call raises EmbeddingUnavailable (HTTP 503) instead of quietly
returning a lexical guess; the portal shows that state explicitly.
"""
import asyncio
import json
import logging
import re
from typing import Optional

from app.services import matcher, role_catalog
from app.services.llm_providers import call_llm, parse_json_loose
from app.services.ai_reliability import check_reliability

logger = logging.getLogger("ai_ml_service.skill_gap")

ROLE_SKILLS = {
    "full stack developer": ["HTML", "CSS", "JavaScript", "React", "Node.js", "Express", "SQL", "Git", "REST APIs", "MongoDB"],
    "data analyst": ["Excel", "SQL", "Python", "Power BI", "Tableau", "Statistics", "Pandas", "Data Visualization", "A/B Testing"],
    "data scientist": ["Python", "Statistics", "Machine Learning", "Pandas", "NumPy", "scikit-learn", "SQL", "Deep Learning", "Data Visualization"],
    "devops engineer": ["Linux", "Docker", "Kubernetes", "CI/CD", "AWS", "Git", "Terraform", "Bash", "Monitoring"],
    "android developer": ["Java", "Kotlin", "Android Studio", "XML", "REST APIs", "SQLite", "Git", "Material Design", "Firebase"],
    "cybersecurity analyst": ["Networking", "Linux", "SIEM", "Python", "OWASP Top 10", "Risk Assessment", "Penetration Testing", "Firewalls", "Incident Response"],
    "cloud engineer": ["AWS", "Azure", "GCP", "Terraform", "Docker", "Kubernetes", "Linux", "Networking", "CI/CD"],
    "ui/ux designer": ["Figma", "Wireframing", "User Research", "Prototyping", "Design Systems", "Usability Testing", "Accessibility"],
}

ALIASES = {
    "frontend developer": "Full Stack Developer",
    "backend developer": "Full Stack Developer",
    "software engineer": "Full Stack Developer",
    "data analyst": "Data Analyst",
    "data scientist": "Data Scientist",
    "devops": "DevOps Engineer",
    "cloud engineer": "Cloud Engineer",
    "cyber security analyst": "Cybersecurity Analyst",
    "cybersecurity analyst": "Cybersecurity Analyst",
    "ui ux designer": "UI/UX Designer",
}


def _norm(v: str) -> str:
    return re.sub(r"[^a-z0-9+#]+", "", str(v or "").lower())


def _clean_list(value, limit=12):
    if not isinstance(value, list):
        return []
    out = []
    seen = set()
    for item in value:
        text = re.sub(r"\s+", " ", str(item or "")).strip()
        if not text:
            continue
        key = _norm(text)
        if key and key not in seen:
            seen.add(key)
            out.append(text[:100])
        if len(out) >= limit:
            break
    return out


def _fallback(role: str, current: list[str]):
    canonical = ALIASES.get(role.lower(), role)
    expected = ROLE_SKILLS.get(role.lower()) or ROLE_SKILLS.get(canonical.lower())
    if not expected:
        # Unknown roles still get a useful, role-specific baseline rather than a 400/404.
        expected = ["Core domain fundamentals", "Communication", "Problem solving", "Data literacy", "Project delivery", "Version control", "Testing", "Documentation"]
    have = {_norm(s) for s in current if _norm(s)}
    matched = [s for s in expected if _norm(s) in have]
    missing = [s for s in expected if _norm(s) not in have]
    return {
        "target_role": role,
        "need": expected[:12],
        "matched": matched[:12],
        "missing": missing[:12],
        "pct": round(100 * len(matched) / max(1, len(expected))),
        "notes": f"Prioritize {missing[0]} next for {role}." if missing else f"Keep strengthening your existing skills for {role}.",
        "generated_by": "curated-fallback",
        "ai_enriched": False,
    }


_GENERIC_BASELINE = ["Core domain fundamentals", "Communication", "Problem solving", "Data literacy",
                     "Project delivery", "Version control", "Testing", "Documentation"]


def _score(results: list[dict]) -> tuple[list[str], list[str], list[str], int]:
    matched = [r["skill"] for r in results if r["status"] == "matched"]
    partial = [r["skill"] for r in results if r["status"] == "partial"]
    missing = [r["skill"] for r in results if r["status"] == "missing"]
    total = max(1, len(results))
    credit = len(matched) + sum(r["confidence"] for r in results if r["status"] == "partial")
    return matched, partial, missing, round(100 * credit / total)


def _note(role: str, gaps: list[str]) -> str:
    return f"Prioritize {gaps[0]} next for {role}." if gaps else f"Keep strengthening your existing skills for {role}."


async def analyze(target_role: str, current_skills: list[str], resume_text: Optional[str] = None) -> dict:
    role = re.sub(r"\s+", " ", str(target_role or "").strip())[:180]
    current = _clean_list(current_skills, 40)
    if not role:
        return _fallback(role, current)

    # 1) Which known role is this? (alias first, then nearest by meaning). Raises EmbeddingUnavailable if needed.
    resolution = await asyncio.to_thread(role_catalog.resolve, role)
    catalog_reqs = [r["skill"] for r in role_catalog.requirements(resolution["role"], 12)]

    # 2) Requirements: live LLM first, catalogue otherwise.
    need: list[str] = []
    notes = ""
    provider = None
    llm_ok = False
    system = (
        "You are an expert campus-placement career coach. Name the skills a student needs for ANY target role. "
        "Return ONLY strict JSON with exactly these keys: need (array of up to 12 concise, distinct skills or tools "
        "that real job postings for this role ask for), notes (one actionable sentence about the student's "
        "most valuable next step, based only on the evidence given). Do not invent qualifications or requirements "
        "that are clearly unrelated to the role."
    )
    user = json.dumps({
        "target_role": role,
        "closest_known_role": resolution["role"],
        "typical_requirements_for_that_role": catalog_reqs,
        "student_current_skills": current,
        "resume_excerpt": (resume_text or "")[:3000],
    }, ensure_ascii=False)
    try:
        res = await call_llm(system, user, {"jsonMode": True, "maxTokens": 650, "temperature": 0.25})
        parsed = parse_json_loose(res.get("text", ""))
        need = _clean_list(parsed.get("need"), 12)
        if not need:
            raise ValueError("LLM returned no skill requirements")
        notes = re.sub(r"\s+", " ", str(parsed.get("notes") or "")).strip()[:500]
        provider = res.get("provider", "provider")
        llm_ok = True
    except Exception as exc:  # noqa: BLE001 - the semantic result below is complete without the LLM
        logger.warning("Skill-gap LLM unavailable; using catalogue requirements: %s: %s", type(exc).__name__, exc)

    if not need:
        need = catalog_reqs or list(_GENERIC_BASELINE)
        source = "catalog" if catalog_reqs else "generic-baseline"
    else:
        source = "llm+catalog" if catalog_reqs else "llm"

    # 3) Judge every requirement by meaning (batch encode, runs in a worker thread: it is CPU-bound).
    outcome = await asyncio.to_thread(matcher.match_requirements, need, current, resume_text or "")
    results = outcome["results"]
    matched, partial, missing, pct = _score(results)
    gaps = missing + partial          # partial skills still need work; the roadmap targets both

    if llm_ok:
        known = [f"Target role: {role}."] + [f"Student has {s}." for s in current] + [f"Student is missing {s}." for s in gaps]
        reliability = check_reliability(notes, known) if notes else None
        if not notes or (reliability and reliability.get("confidence_label") == "low"):
            notes = _note(role, gaps)
    else:
        reliability = None
        notes = _note(role, gaps)

    out = {
        "target_role": role,
        "resolved_role": resolution["role"],
        "role_resolution": {k: resolution[k] for k in ("method", "similarity", "matched_name")},
        "need": need,
        "matched": matched,
        "partial": partial,
        "missing": gaps,
        "pct": pct,
        "notes": notes,
        "skills": [{k: r.get(k) for k in ("skill", "status", "match_type", "similarity", "matched_with", "passage", "evidence")}
                   for r in results],
        "matching_engine": {**(outcome["engine"] or matcher.engine_info()), "mode": "semantic-embeddings",
                            "thresholds": outcome["thresholds"], "resume_passages": outcome["passages"]},
        "requirements_source": source,
        "generated_by": f"llm:{provider}+semantic" if llm_ok else "semantic-catalog",
        "ai_enriched": llm_ok,
    }
    if reliability is not None:
        out["reliability"] = reliability
    if not llm_ok:
        out["llm_unavailable"] = True
    return out
