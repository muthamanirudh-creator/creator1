"""Shared Hybrid RAG core (BM25 + dense vectors + metadata filters + RRF + optional rerank + grounded answers).

One reusable pipeline for every knowledge-heavy feature; domain behaviour is configuration (`DOMAINS`), not copies of
the pipeline. LangChain interfaces are used when `langchain_core` is installed (see langchain_adapter.py); the
core itself has no hard dependency on it so the service still boots without it.
"""
from .models import RagDocument, Candidate  # noqa: F401
from .pipeline import HybridRAG, RagResult  # noqa: F401
from .store import HybridIndex  # noqa: F401
