"""Process-wide HybridRAG singleton wired to the service's embedding engine and LLM providers.

The legacy Career-Fit RAG (services/rag.py) is untouched; its curated knowledge-base passages are mirrored into the
shared index (domain "career"/"exam"/"learning" by source) so both paths see the same content. Government / private
recruitment documents are added by the ingestion pipeline (app/rag_core/ingest.py) and never invented here.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Optional

import numpy as np

from app.config import get_settings
from app.rag_core import HybridIndex, HybridRAG, RagDocument
from app.rag_core.lc_chain import wrap_generator
from app.rag_core.pipeline import RagConfig
from app.rag_core import knowledge as kn
from app.rag_core.recruitment import RecordRegistry
from app.rag_core.rerank import build_reranker

logger = logging.getLogger("ai_ml_service.hybrid_rag")
_lock = threading.RLock()
_rag: Optional[HybridRAG] = None
_registry: Optional[RecordRegistry] = None
_knowledge: Optional[kn.KnowledgeStore] = None


def _embed(texts: list[str]) -> np.ndarray:
    from app.services.embeddings import get_engine
    return np.asarray(get_engine().ensure_ready().encode(list(texts)), dtype=np.float32)   # raises EmbeddingUnavailable -> 503


async def _generate(system: str, user: str) -> dict:
    from app.services.llm_providers import call_llm
    return await call_llm(system, user, {"maxTokens": 700, "temperature": 0.1, "noCache": True})


def _engine_version() -> str:
    try:
        from app.services.embeddings import get_engine
        st = get_engine().status()
        return f"{st.get('engine')}:{st.get('model')}:{st.get('dim') or st.get('dimension')}"
    except Exception:                       # noqa: BLE001
        return "unknown"


def _kb_documents() -> list[RagDocument]:
    from app.services import rag as legacy
    domain_by_source = {"career-path": "career", "market": "career", "knowledge": "career"}
    docs = []
    for i, c in enumerate(legacy.build_kb_chunks()):
        docs.append(RagDocument(text=c.text, source_id=f"kb:{c.id}", title=c.title, ordinal=0, id=f"kb:{c.id}",
                                metadata={"domain": domain_by_source.get(c.source, "career"), "authority": "internal",
                                          "scope": "public", "doc_type": c.source, "roles": sorted(c.roles)}))
    return docs


def records_path() -> str:
    """Where the public-record snapshot lives. Blank config -> ./data/hybrid_rag/records.json beside the service. That is only
    DURABLE if the folder is on persistent storage (a mounted disk/volume); status reports where it is and whether saves work."""
    s = get_settings()
    if s.HYBRID_RAG_RECORDS_PATH:
        return s.HYBRID_RAG_RECORDS_PATH
    return os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "hybrid_rag", "records.json")


def vectors_path() -> str:
    s = get_settings()
    return s.HYBRID_RAG_VECTORS_PATH or os.path.join(os.path.dirname(records_path()), "vectors.npz")


def knowledge_path() -> str:
    s = get_settings()
    return s.HYBRID_RAG_KNOWLEDGE_PATH or os.path.join(os.path.dirname(records_path()), "knowledge.json")


def answer_keys_path() -> str:
    s = get_settings()
    return s.HYBRID_RAG_ANSWER_KEYS_PATH or os.path.join(os.path.dirname(knowledge_path()), "answer_keys.json")


def get_rag() -> HybridRAG:
    global _rag, _knowledge
    with _lock:
        if _rag is None:
            s = get_settings()
            idx = HybridIndex(_embed, embed_version=_engine_version(), rrf_k=s.RAG_RRF_K, dense_weight=s.RAG_DENSE_WEIGHT,
                              lexical_weight=s.RAG_LEXICAL_WEIGHT, min_similarity=s.RAG_MIN_SIMILARITY)
            idx.vectors_path = vectors_path()
            loaded_vecs = idx.load_vectors()
            if loaded_vecs:
                logger.info("Loaded %d cached chunk embeddings (no re-embedding of unchanged text)", loaded_vecs)
            for d in _kb_documents():
                idx.upsert_source(d.source_id, [d])
            kn.WINDOW_DAYS.update({"private": s.HYBRID_RAG_HIRING_WINDOW_DAYS, "exam": s.HYBRID_RAG_EXAM_WINDOW_DAYS})
            vault = kn.AnswerKeyVault(answer_keys_path())
            vault.load()
            _knowledge = kn.KnowledgeStore(idx, vault, snapshot_path=knowledge_path())      # Pass B: same index, so one retrieval path serves every domain
            loaded_kn = _knowledge.load()
            if s.HYBRID_RAG_KNOWLEDGE_DIR:
                _knowledge.load_directory(s.HYBRID_RAG_KNOWLEDGE_DIR)
            if loaded_kn:
                logger.info("Loaded %d knowledge items from snapshot", loaded_kn)
            cfg = RagConfig(top_k=s.RAG_TOP_K, token_budget=max(400, s.RAG_MAX_CONTEXT_CHARS // 4),
                            min_relevance=s.HYBRID_RAG_MIN_RELEVANCE, cache_ttl=s.HYBRID_RAG_CACHE_TTL_SECONDS,
                            llm_timeout=s.HYBRID_RAG_LLM_TIMEOUT_SECONDS, allow_unverified_facts=s.HYBRID_RAG_ALLOW_UNVERIFIED_FACTS)
            generate, orchestration = wrap_generator(_generate, mode=s.HYBRID_RAG_USE_LANGCHAIN)   # LCEL when installed; "on" fails fast if missing
            reranker = build_reranker(s.HYBRID_RAG_RERANKER, s.HYBRID_RAG_RERANKER_MODEL)
            _rag = HybridRAG(idx, generate, config=cfg, reranker=reranker, orchestration=orchestration)
            logger.info("Hybrid RAG ready (orchestration=%s, reranker=%s): %s", orchestration, getattr(reranker, "name", "off"), idx.stats())
        return _rag


def get_registry() -> RecordRegistry:
    """Recruitment records (status, freshness, duplicates) kept in sync with the shared index."""
    global _registry
    rag = get_rag()
    with _lock:
        if _registry is None:
            s = get_settings()
            _registry = RecordRegistry(rag.index, max_age_days=s.HYBRID_RAG_MAX_VERIFICATION_AGE_DAYS,
                                       snapshot_path=records_path())
            n = _registry.load()
            if n:
                logger.info("Loaded %d recruitment records from snapshot", n)
        return _registry


def get_knowledge() -> kn.KnowledgeStore:
    """Pass B knowledge store (private / exam / learning / career documents + the separate answer-key vault)."""
    get_rag()
    return _knowledge


def official_domains() -> tuple[str, ...]:
    return tuple(x.strip() for x in get_settings().HYBRID_RAG_OFFICIAL_DOMAINS.split(",") if x.strip())


def reset_for_tests() -> None:
    global _rag, _registry, _knowledge
    with _lock:
        _rag = None
        _registry = None
        _knowledge = None
