from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import resume_ai

router = APIRouter(prefix="/resume", tags=["resume-tab"])


class ResumeAnalyzeRequest(BaseModel):
    resume_text: str = Field("", max_length=100000)
    jd_text: str = Field("", max_length=100000)
    target_role: str = Field("", max_length=200)


@router.post("/analyze")
async def analyze_endpoint(req: ResumeAnalyzeRequest):
    """Explainable skill match + ATS score + AI fit summary / gaps / tailored bullets / tips for the Resume tab."""
    return await resume_ai.analyze(req.resume_text, req.jd_text, req.target_role)


class AtsOptimizeRequest(BaseModel):
    resume_text: str = Field("", max_length=100000)
    jd_text: str = Field("", max_length=100000)


@router.post("/ats-optimize")
async def ats_optimize_endpoint(req: AtsOptimizeRequest):
    """{atsScore, verdict, bulletRewrites, keywordsToAdd} — the exact shape the ATS Optimizer panel renders."""
    return await resume_ai.ats_optimize(req.resume_text, req.jd_text)


class EnhanceRequest(BaseModel):
    summary: str = Field("", max_length=20000)
    experience: str = Field("", max_length=40000)
    projects: str = Field("", max_length=40000)
    skills: str = Field("", max_length=10000)
    target_role: str = Field("", max_length=200)


@router.post("/enhance")
async def enhance_endpoint(req: EnhanceRequest):
    """Rewrite summary / experience / projects for the Resume Builder's "Enhance with AI" button."""
    return await resume_ai.enhance(req.summary, req.experience, req.projects, req.skills, req.target_role)
