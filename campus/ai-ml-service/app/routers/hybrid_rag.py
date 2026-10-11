"""Shared Hybrid RAG endpoints (additive; /rag/* legacy routes are unchanged).

  POST /rag/hybrid/query     grounded, cited answer from the shared index (abstains / degrades honestly)
  POST /rag/hybrid/retrieve  retrieval only (no LLM)
  GET  /rag/hybrid/status    index statistics + privacy-safe metrics

Pass 2 (recruitment records + eligibility):
  POST /rag/hybrid/eligibility        deterministic three-valued check of a student profile against stored notices
  GET  /rag/hybrid/records            honest status of every stored drive (public notice data only)
  POST /rag/hybrid/records            ADMIN: ingest/update a notice (validated, sanitised, criteria quoted verbatim)
  POST /rag/hybrid/records/{id}/verified | /unreachable | DELETE   ADMIN: freshness bookkeeping
  POST /rag/hybrid/records/sweep      ADMIN: re-classify every drive (expiry / verification-age drift)

The caller identity comes from the authenticated Express gateway header `x-user-id`; the service itself never trusts a
user id supplied in the JSON body.
"""
import asyncio
from typing import Literal, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.rag_core.eligibility import assess, coverage, profile_from_input
from app.rag_core.ingest import criteria_of, ingest_record
from app.rag_core.metrics import METRICS
from app.rag_core.recruitment import RecordError
from app.rag_core.pipeline import source_view
from app.services import hybrid_rag

router = APIRouter(prefix="/rag/hybrid", tags=["hybrid-rag"])


class Turn(BaseModel):
    role: Literal["user", "assistant", "student"] = "user"
    content: str = Field("", max_length=2000)


class Filters(BaseModel):
    organization: Optional[str] = Field(None, max_length=120)
    role: Optional[str] = Field(None, max_length=120)
    location: Optional[str] = Field(None, max_length=120)
    cycle: Optional[str] = Field(None, max_length=40)
    doc_type: Optional[str] = Field(None, max_length=60)
    published_after: Optional[str] = Field(None, max_length=10)
    published_before: Optional[str] = Field(None, max_length=10)


class HybridRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=2000)
    domain: Optional[Literal["government", "private", "exam", "learning", "career"]] = None
    filters: Filters = Field(default_factory=Filters)
    history: list[Turn] = Field(default_factory=list, max_length=8)
    include_stale: bool = False
    rerank: Optional[bool] = None          # None = automatic (recruitment facts / near-tied results); true/false forces


def _requester(x_user_id: Optional[str]) -> dict:
    return {"user_id": x_user_id} if x_user_id else {}


@router.post("/query")
async def hybrid_query(req: HybridRequest, x_user_id: Optional[str] = Header(None)):
    return await hybrid_rag.get_rag().answer(
        req.question, requester=_requester(x_user_id), filters=req.filters.model_dump(exclude_none=True), domain=req.domain,
        history=[t.model_dump() for t in req.history], include_stale=req.include_stale, rerank=req.rerank)


@router.post("/retrieve")
async def hybrid_retrieve(req: HybridRequest, x_user_id: Optional[str] = Header(None)):
    def run():
        cands, info = hybrid_rag.get_rag().retrieve(
            req.question, requester=_requester(x_user_id), filters=req.filters.model_dump(exclude_none=True), domain=req.domain,
            include_stale=req.include_stale, rerank=req.rerank)
        for i, c in enumerate(cands, 1):
            c.n = i
        return {"sources": [source_view(c) for c in cands[:12]], "retrieval": info}
    return await asyncio.to_thread(run)


@router.get("/status")
async def hybrid_status():
    rag = await asyncio.to_thread(hybrid_rag.get_rag)
    from app.rag_core.lc_chain import langchain_importable
    records = await asyncio.to_thread(lambda: len(hybrid_rag.get_registry().records))   # pass 4 (additive): recruitment drives stored
    reg = await asyncio.to_thread(hybrid_rag.get_registry)
    persistence = {**reg.persistence, "vectors_path": rag.index.vectors_path or None, "vectors_error": rag.index.vectors_error}
    return {"index": rag.index.stats(), "records": records, "metrics": METRICS.snapshot(),
            "reranker": getattr(rag.reranker, "name", "off"), "persistence": persistence,
            "needs_sync": records == 0,                      # empty after a restart (or never synced): the gateway scheduler re-syncs
            "orchestration": rag.orchestration, "langchain_installed": langchain_importable(),
            "cache": {"hits": rag.cache.hits, "misses": rag.cache.misses}}


# ------------------------------------------------------------------------------------------------- pass 2
def _admin(x_user_role: Optional[str]) -> None:
    """The gateway sets x-user-role from the verified JWT (and drops any client-sent value)."""
    if (x_user_role or "").lower() != "admin":
        raise HTTPException(status_code=403, detail={"code": "ADMIN_REQUIRED", "message": "Admin access required."})


class EligibilityRequest(BaseModel):
    profile: dict = Field(default_factory=dict)
    record_id: Optional[str] = Field(None, max_length=80)
    organization: Optional[str] = Field(None, max_length=160)
    role: Optional[str] = Field(None, max_length=160)
    cycle: Optional[str] = Field(None, max_length=40)
    include_closed: bool = False


@router.post("/eligibility")
async def hybrid_eligibility(req: EligibilityRequest):
    """The profile is request-scoped: it is never logged, cached or stored. Verdicts come from code, not from an LLM."""
    try:
        profile = profile_from_input(req.profile)
    except ValueError as e:
        raise HTTPException(status_code=422, detail={"code": "INVALID_PROFILE", "message": str(e)})
    if not (req.record_id or req.organization or req.role):
        raise HTTPException(status_code=422, detail={"code": "SELECT_A_DRIVE", "message": "Provide record_id, or organization and/or role."})

    def run():
        reg = hybrid_rag.get_registry()
        recs = reg.find(record_id=req.record_id or "", organization=req.organization or "", role=req.role or "",
                        cycle=req.cycle or "", include_closed=req.include_closed)[:5]
        results = []
        for rec in recs:
            desc = reg.describe(rec.record_id)
            a = assess(desc, criteria_of(rec), profile, source_text=rec.text)
            a["coverage"] = coverage(criteria_of(rec))
            results.append(a)
        return {"results": results, "profile_fields_used": sorted(profile), "profile_stored": False,
                "message": None if results else "No matching recruitment record is stored. Nothing was assumed."}
    return await asyncio.to_thread(run)


@router.get("/records")
async def hybrid_records():
    return {"records": await asyncio.to_thread(lambda: hybrid_rag.get_registry().list())}


class RecordPayload(BaseModel):
    record_id: str = Field(..., max_length=80)
    organization: str = Field(..., max_length=160)
    role: str = Field(..., max_length=160)
    title: str = Field("", max_length=200)
    advt_no: str = Field("", max_length=80)
    cycle: str = Field("", max_length=40)
    url: str = Field("", max_length=1000)
    text: str = Field("", max_length=200_000)
    published_at: Optional[str] = Field(None, max_length=10)
    opens_at: Optional[str] = Field(None, max_length=10)
    deadline: Optional[str] = Field(None, max_length=10)
    location: str = Field("", max_length=120)
    authority: str = Field("third_party", max_length=20)
    last_verified_at: Optional[str] = Field(None, max_length=40)
    source_status: str = Field("never_checked", max_length=20)
    source_error: str = Field("", max_length=200)
    extraction_status: str = Field("auto_extracted", max_length=20)
    salary: str = Field("", max_length=200)
    domain: str = Field("government", max_length=20)
    criteria: list[dict] = Field(default_factory=list, max_length=40)


@router.post("/records")
async def hybrid_ingest(req: RecordPayload, x_user_role: Optional[str] = Header(None)):
    _admin(x_user_role)
    try:
        return await asyncio.to_thread(lambda: ingest_record(hybrid_rag.get_registry(), req.model_dump(),
                                                              official_domains=hybrid_rag.official_domains()))
    except RecordError as e:
        raise HTTPException(status_code=422, detail={"code": "INVALID_RECORD", "message": str(e)})


@router.post("/records/sweep")
async def hybrid_sweep(x_user_role: Optional[str] = Header(None)):
    _admin(x_user_role)
    return await asyncio.to_thread(lambda: hybrid_rag.get_registry().sweep())


class Unreachable(BaseModel):
    error: str = Field("", max_length=200)


class Verified(BaseModel):
    at: Optional[str] = Field(None, max_length=40)


def _guard(fn):
    try:
        return fn()
    except KeyError:
        raise HTTPException(status_code=404, detail={"code": "RECORD_NOT_FOUND", "message": "No such record."})


@router.post("/records/{record_id}/verified")
async def hybrid_verified(record_id: str, body: Verified, x_user_role: Optional[str] = Header(None)):
    _admin(x_user_role)
    return await asyncio.to_thread(lambda: _guard(lambda: hybrid_rag.get_registry().mark_verified(record_id, at=body.at)))


@router.post("/records/{record_id}/unreachable")
async def hybrid_unreachable(record_id: str, body: Unreachable, x_user_role: Optional[str] = Header(None)):
    _admin(x_user_role)
    return await asyncio.to_thread(lambda: _guard(lambda: hybrid_rag.get_registry().mark_unreachable(record_id, body.error)))


@router.delete("/records/{record_id}")
async def hybrid_remove(record_id: str, x_user_role: Optional[str] = Header(None)):
    _admin(x_user_role)
    removed = await asyncio.to_thread(lambda: hybrid_rag.get_registry().remove(record_id))
    if not removed:
        raise HTTPException(status_code=404, detail={"code": "RECORD_NOT_FOUND", "message": "No such record."})
    return {"removed": True}
