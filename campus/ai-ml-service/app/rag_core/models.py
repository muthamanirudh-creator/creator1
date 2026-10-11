from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any, Optional

# Authority classes, strongest first. Official notifications outrank everything for recruitment facts.
AUTHORITY_RANK = {"official": 3, "verified": 2, "internal": 1, "third_party": 0, "user": 0}


def norm_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(norm_text(text).lower().encode("utf-8")).hexdigest()[:32]


@dataclass
class RagDocument:
    """One retrievable chunk. `source_id` groups chunks of one source document; `id` is stable across re-ingests
    of unchanged content (source_id + chunk ordinal + content hash prefix)."""
    text: str
    source_id: str
    title: str = ""
    ordinal: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    id: str = ""
    hash: str = ""

    def __post_init__(self):
        self.text = norm_text(self.text)
        self.hash = self.hash or content_hash(self.text)
        self.id = self.id or f"{self.source_id}#{self.ordinal}:{self.hash[:8]}"
        md = self.metadata
        md.setdefault("domain", "career")
        md.setdefault("authority", "internal")      # official | verified | internal | third_party | user
        md.setdefault("scope", "public")            # public | user:<id> | org:<id>   (access-control scope)
        md.setdefault("status", "active")           # active | expired | superseded | withdrawn

    @property
    def search_text(self) -> str:
        return f"{self.title}. {self.text}" if self.title else self.text


@dataclass
class Candidate:
    doc: RagDocument
    dense: float = 0.0
    lexical: float = 0.0          # BM25 score normalised to 0..1 within the candidate set
    fused: float = 0.0
    rerank: Optional[float] = None
    flags: list[str] = field(default_factory=list)
    n: int = 0                    # citation number once selected
