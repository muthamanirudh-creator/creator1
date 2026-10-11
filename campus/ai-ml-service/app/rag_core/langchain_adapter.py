"""Optional LangChain bridge. When `langchain_core` is installed, `as_langchain_retriever()` exposes the shared index as a
standard `BaseRetriever` (so it can be dropped into LCEL chains / LangGraph), and `embeddings_adapter()` wraps any
LangChain `Embeddings` object as this core's embedder. When it is not installed these raise a clear ImportError and the
rest of the core keeps working unchanged.

NOTE: written against the langchain_core 0.3.x public interface (BaseRetriever._get_relevant_documents,
langchain_core.documents.Document, langchain_core.embeddings.Embeddings). It could not be executed in the build
sandbox (no package index access); `tests/test_rag_core.py::test_langchain_adapter_*` runs it automatically when the
package is present.
"""
from __future__ import annotations

from typing import Any, Optional

import numpy as np

from .pipeline import HybridRAG


def langchain_available() -> bool:
    try:
        import langchain_core  # noqa: F401
        return True
    except Exception:           # noqa: BLE001
        return False


def embeddings_adapter(lc_embeddings: Any):
    def embed(texts: list[str]) -> np.ndarray:
        v = np.asarray(lc_embeddings.embed_documents(list(texts)), dtype=np.float32)
        n = np.linalg.norm(v, axis=1, keepdims=True)
        return v / np.where(n == 0, 1, n)
    return embed


def as_langchain_retriever(rag: HybridRAG, *, requester: Optional[dict] = None, filters: Optional[dict] = None, k: int = 6):
    from langchain_core.callbacks import CallbackManagerForRetrieverRun  # noqa: F401
    from langchain_core.documents import Document
    from langchain_core.retrievers import BaseRetriever

    class HybridLangChainRetriever(BaseRetriever):
        def _get_relevant_documents(self, query: str, *, run_manager: Any = None) -> list:
            cands, _ = rag.retrieve(query, requester=requester, filters=filters)
            return [Document(page_content=c.doc.text, metadata={**c.doc.metadata, "id": c.doc.id, "title": c.doc.title,
                                                                "relevance": c.dense, "fused": c.fused}) for c in cands[:k]]

    return HybridLangChainRetriever()
