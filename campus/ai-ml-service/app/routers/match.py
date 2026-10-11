import asyncio
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import matcher, parser, role_catalog, skill_text
from app.services.embeddings import get_engine
from app.services.explainability import resume_match_evidence

router = APIRouter(prefix="/match", tags=["semantic-match"])


class ResumeJdRequest(BaseModel):
    resume_text: str = Field(..., max_length=100000)
    jd_text: str = Field(..., max_length=100000)


@router.post("/resume-jd")
async def match_resume_jd_endpoint(req: ResumeJdRequest):
    """Kept for backward compatibility: whole-document semantic_similarity only.
    Prefer POST /match/resume-jd/explain for the skill-level breakdown."""
    # Embedding work is CPU-bound; a worker thread keeps the event loop (health checks, other tabs) responsive.
    return await asyncio.to_thread(matcher.match_resume_to_jd, req.resume_text, req.jd_text)


class ExplainableMatchRequest(BaseModel):
    resume_text: str = Field("", max_length=100000)
    jd_text: str = Field("", max_length=100000)
    # Optional pre-extracted skill lists (e.g. already returned by an earlier call to
    # POST /parse/resume or POST /parse/jd) so this endpoint doesn't re-run extraction.
    # If omitted, skills are extracted here from resume_text/jd_text.
    resume_skills: Optional[list[str]] = Field(None, max_length=500)
    jd_skills: Optional[list[str]] = Field(None, max_length=500)


@router.post("/resume-jd/explain")
async def explain_resume_jd_endpoint(req: ExplainableMatchRequest):
    """Explainable Competency Matching (spec §9): per-skill matched / partially-matched /
    missing breakdown with evidence, instead of a single opaque cosine score. Feed the
    `matched_skills` from this response into POST /api/twin/sync-resume-match (Node backend)
    to record them on the Student Digital Twin."""
    resume_skills = req.resume_skills
    if resume_skills is None:
        resume_skills = parser.extract_skills(req.resume_text) if req.resume_text else []
    jd_skills = req.jd_skills
    if jd_skills is None:
        jd_skills = parser.extract_skills(req.jd_text) if req.jd_text else []

    result = await asyncio.to_thread(matcher.explain_resume_jd_match, resume_skills, jd_skills, req.resume_text, req.jd_text)
    result["evidence"] = resume_match_evidence(result)
    return result


class IndexRequest(BaseModel):
    profile_id: str = Field(..., min_length=1, max_length=200)
    text: str = Field(..., max_length=100000)
    metadata: dict = Field(default_factory=dict)


@router.post("/index")
async def index_profile_endpoint(req: IndexRequest):
    await asyncio.to_thread(matcher.index_profile, req.profile_id, req.text, req.metadata)
    return {"status": "indexed", "profile_id": req.profile_id, "backend": matcher.settings.VECTOR_BACKEND}


class SemanticSearchRequest(BaseModel):
    query: str = Field(..., max_length=20000)
    top_k: int = Field(5, ge=1, le=50)


@router.post("/search")
async def semantic_search_endpoint(req: SemanticSearchRequest):
    results = await asyncio.to_thread(matcher.semantic_search, req.query, req.top_k)
    return {"results": results, "backend": matcher.settings.VECTOR_BACKEND}


@router.get("/engine")
async def engine_status():
    """Live state of the embedding model (loaded? which model/device? self-test result? cache hit-rate?).
    The Career Fit tab shows this so a student can see that matching is genuinely semantic and live."""
    return get_engine().status()


class RoleFitRequest(BaseModel):
    resume_text: str = Field("", max_length=100000)
    target_role: str = Field("", max_length=200)
    # Optional: a pasted job description overrides the role catalogue as the source of requirements.
    jd_text: str = Field("", max_length=100000)
    current_skills: list[str] = Field(default_factory=list, max_length=80)


def _role_fit(req: RoleFitRequest) -> dict:
    """Real-time, model-only (no LLM, so it answers in well under a second once warm): resolve the role by
    meaning, take its requirements (or the pasted JD's), and judge every one against the resume."""
    resume_text = (req.resume_text or "").strip()
    role_query = (req.target_role or "").strip()
    jd_text = (req.jd_text or "").strip()

    resolution = {"role": None, "method": "none", "similarity": 0.0, "matched_name": None}
    if role_query:
        resolution = role_catalog.resolve(role_query)

    if jd_text:
        requirements = parser.extract_skills(jd_text)
        source = "job-description"
    else:
        requirements = [r["skill"] for r in role_catalog.requirements(resolution["role"], 14)]
        source = "role-catalogue" if requirements else "unresolved"

    detected = skill_text.candidate_skills(resume_text, list(req.current_skills) + (parser.extract_skills(resume_text) if resume_text else []))
    if not requirements:
        engine = get_engine()
        return {
            "target_role": role_query, "resolved_role": resolution["role"], "role_resolution": resolution,
            "requirements_source": source, "fit_pct": None, "need": [], "matched": [], "partial": [], "missing": [],
            "skills": [], "detected_skills": detected[:40],
            "matching_engine": matcher.engine_info() if engine.is_ready else None,
            "message": ("No known role matches \u201c" + role_query + "\u201d closely enough. Pick a nearby role, "
                        "or paste a job description to match against.") if role_query else
                       "Enter a target role (or paste a job description) to see your live fit.",
        }

    outcome = matcher.match_requirements(requirements, detected, resume_text)
    results = outcome["results"]
    matched = [r["skill"] for r in results if r["status"] == "matched"]
    partial = [r["skill"] for r in results if r["status"] == "partial"]
    missing = [r["skill"] for r in results if r["status"] == "missing"]
    credit = len(matched) + sum(r["confidence"] for r in results if r["status"] == "partial")
    doc = None
    if resume_text and jd_text:
        doc = matcher.match_resume_to_jd(resume_text, jd_text)
    return {
        "target_role": role_query, "resolved_role": resolution["role"], "role_resolution": resolution,
        "requirements_source": source,
        "fit_pct": round(100 * credit / max(1, len(results)), 1),
        "need": requirements, "matched": matched, "partial": partial, "missing": missing,
        "skills": [{k: r.get(k) for k in ("skill", "status", "match_type", "similarity", "matched_with", "passage", "evidence")}
                   for r in results],
        "detected_skills": detected[:40],
        "document_similarity": doc["semantic_similarity"] if doc else None,
        "jd_requirement_coverage": doc["jd_requirement_coverage"] if doc else None,
        "matching_engine": {**(outcome["engine"] or matcher.engine_info()), "mode": "semantic-embeddings",
                            "thresholds": outcome["thresholds"], "resume_passages": outcome["passages"]},
    }


@router.post("/role-fit")
async def role_fit_endpoint(req: RoleFitRequest):
    """Live semantic fit of a resume against a target role (or pasted JD): per-skill verdict + evidence line."""
    return await asyncio.to_thread(_role_fit, req)
