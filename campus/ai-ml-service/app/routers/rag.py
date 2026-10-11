"""Career Fit RAG endpoints (additive - nothing existing is changed).

  POST /rag/query    question -> grounded answer with numbered, scored source passages
  POST /rag/retrieve retrieval only (no LLM): the passages and scores, for debugging / UI previews
  GET  /rag/status   knowledge-base size, embedding state and retrieval settings

Reached through the authenticated Express gateway as /api/ai-ml/rag/*. Resume / JD text is request-scoped and is never
stored. When the embedding model is unavailable these routes answer 503 EMBEDDING_MODEL_UNAVAILABLE (main.py handler).
"""
import asyncio
from typing import Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import rag

router = APIRouter(prefix="/rag", tags=["career-fit-rag"])


class Turn(BaseModel):
    role: Literal["user", "assistant", "student"] = "user"
    content: str = Field("", max_length=2000)


class RagRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=1000)
    resume_text: str = Field("", max_length=100000)
    jd_text: str = Field("", max_length=100000)
    target_role: str = Field("", max_length=200)
    scope: Literal["all", "resume", "knowledge"] = "all"
    top_k: Optional[int] = Field(None, ge=1, le=12)
    history: list[Turn] = Field(default_factory=list, max_length=8)
    provider: Optional[Literal["groq", "gemini"]] = None


@router.post("/query")
async def rag_query(req: RagRequest):
    return await rag.answer_question(
        req.question.strip(), resume_text=req.resume_text, jd_text=req.jd_text, target_role=req.target_role.strip(),
        scope=req.scope, top_k=req.top_k, history=[t.model_dump() for t in req.history], provider=req.provider)


@router.post("/retrieve")
async def rag_retrieve(req: RagRequest):
    prev = next((t.content for t in reversed(req.history) if t.role in ("user", "student")), "")
    return await asyncio.to_thread(
        rag.retrieve, req.question.strip(), resume_text=req.resume_text, jd_text=req.jd_text,
        target_role=req.target_role.strip(), scope=req.scope, top_k=req.top_k, previous_question=prev)


@router.get("/status")
async def rag_status():
    return await asyncio.to_thread(rag.status)
