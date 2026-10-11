"""Pass B: knowledge store endpoints (private-sector / exam / learning / career documents). Additive; separate file so the
ten Pass 1-4 routes in hybrid_rag.py are unchanged.

  GET    /rag/hybrid/knowledge                     public listing with freshness / origin labels (never answer keys)
  POST   /rag/hybrid/knowledge                     ADMIN: ingest/update an item (validated, sanitised, key separated, labelled)
  DELETE /rag/hybrid/knowledge/{item_id}           ADMIN: remove an item, its chunks and its answer key
  POST   /rag/hybrid/knowledge/{item_id}/check     signed-in user: is my answer correct? (does not reveal the key)
  GET    /rag/hybrid/knowledge/{item_id}/answer    signed-in user: reveal the stored key / worked solution

Caller identity comes from the gateway headers `x-user-id` / `x-user-role` (verified JWT); the body is never trusted for it.
"""
import asyncio
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.rag_core.knowledge import KnowledgeError
from app.services import hybrid_rag

router = APIRouter(prefix="/rag/hybrid/knowledge", tags=["hybrid-rag-knowledge"])


def _admin(x_user_role: Optional[str]) -> None:
    if (x_user_role or "").lower() != "admin":
        raise HTTPException(status_code=403, detail={"code": "ADMIN_REQUIRED", "message": "Admin access required."})


def _user(x_user_id: Optional[str]) -> dict:
    if not x_user_id:
        raise HTTPException(status_code=401, detail={"code": "SIGN_IN_REQUIRED", "message": "Sign in to use answer checking."})
    return {"user_id": x_user_id}


class KnowledgePayload(BaseModel):
    item_id: str = Field(..., max_length=80)
    kind: str = Field(..., max_length=30)
    title: str = Field("", max_length=200)
    text: str = Field("", max_length=200_000)
    domain: Optional[str] = Field(None, max_length=20)
    organization: str = Field("", max_length=160)
    role: str = Field("", max_length=160)
    location: str = Field("", max_length=120)
    cycle: str = Field("", max_length=40)
    batch: str = Field("", max_length=40)
    language: str = Field("en", max_length=10)
    url: str = Field("", max_length=1000)
    authority: str = Field("third_party", max_length=20)
    content_origin: str = Field("", max_length=20)
    ai_generated: bool = False
    scope: str = Field("public", max_length=70)
    published_at: Optional[str] = Field(None, max_length=10)
    last_verified_at: Optional[str] = Field(None, max_length=10)
    expires_at: Optional[str] = Field(None, max_length=10)
    for_item_id: Optional[str] = Field(None, max_length=80)          # only for kind=answer_key
    keep_existing_key: bool = False
    answer: Optional[str] = Field(None, max_length=4000)
    answer_key: Optional[str] = Field(None, max_length=8000)
    correct_option: Optional[str] = Field(None, max_length=200)
    solution: Optional[str] = Field(None, max_length=8000)
    explanation: Optional[str] = Field(None, max_length=8000)


class CheckBody(BaseModel):
    answer: str = Field(..., min_length=1, max_length=200)


@router.get("")
async def knowledge_list(domain: str = ""):
    ks = await asyncio.to_thread(hybrid_rag.get_knowledge)
    return {"items": ks.listing(domain=domain), "summary": ks.summary()}


@router.post("")
async def knowledge_ingest(req: KnowledgePayload, x_user_role: Optional[str] = Header(None)):
    _admin(x_user_role)
    try:
        return await asyncio.to_thread(lambda: hybrid_rag.get_knowledge().ingest(req.model_dump(exclude_none=True)))
    except KnowledgeError as e:
        raise HTTPException(status_code=422, detail={"code": "INVALID_KNOWLEDGE_ITEM", "message": str(e)})


@router.delete("/{item_id}")
async def knowledge_remove(item_id: str, x_user_role: Optional[str] = Header(None)):
    _admin(x_user_role)
    if not await asyncio.to_thread(lambda: hybrid_rag.get_knowledge().remove(item_id)):
        raise HTTPException(status_code=404, detail={"code": "ITEM_NOT_FOUND", "message": "No such knowledge item."})
    return {"removed": True}


@router.post("/{item_id}/check")
async def knowledge_check(item_id: str, body: CheckBody, x_user_id: Optional[str] = Header(None)):
    who = _user(x_user_id)
    ok = await asyncio.to_thread(lambda: hybrid_rag.get_knowledge().vault.check(item_id, body.answer, who))
    return {"item_id": item_id, "correct": ok, "comparable": ok is not None}


@router.get("/{item_id}/answer")
async def knowledge_answer(item_id: str, x_user_id: Optional[str] = Header(None)):
    who = _user(x_user_id)
    e = await asyncio.to_thread(lambda: hybrid_rag.get_knowledge().vault.reveal(item_id, who))
    if not e:
        raise HTTPException(status_code=404, detail={"code": "NO_ANSWER_KEY", "message": "No answer key is stored for this item."})
    return {"item_id": item_id, "key": e, "label": "Answer keys are kept outside the AI search index and are shown only on request."}
