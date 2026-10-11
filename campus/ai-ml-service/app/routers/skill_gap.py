from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import skill_gap

router = APIRouter(prefix="/skill-gap", tags=["skill-gap"])


class SkillGapRequest(BaseModel):
    target_role: str = Field(..., min_length=1, max_length=180)
    current_skills: list[str] = Field(default_factory=list, max_length=80)
    resume_text: Optional[str] = Field(None, max_length=8000)


@router.post("/analyze")
async def analyze_skill_gap(req: SkillGapRequest):
    return await skill_gap.analyze(
        target_role=req.target_role,
        current_skills=req.current_skills,
        resume_text=req.resume_text,
    )
