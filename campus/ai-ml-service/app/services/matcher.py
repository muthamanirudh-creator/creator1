"""
Semantic skill-matching / vector search.

Embeddings come from app/services/embeddings.py: a real transformer sentence-embedding model
(sentence-transformers on top of transformers + torch, default all-MiniLM-L6-v2, 384-dim). There is NO silent
fallback any more: if the model cannot be loaded the semantic calls raise EmbeddingUnavailable (HTTP 503
EMBEDDING_MODEL_UNAVAILABLE). A lexical hash encoder exists only behind ALLOW_LEXICAL_FALLBACK=true and every
result produced with it is flagged ``fallback_mode: true``.

Vector-store backend is pluggable via VECTOR_BACKEND ("faiss" default | "qdrant" | "pinecone"); all implement the
same upsert/query interface, exactly as before.

What changed in the matching itself (Career Fit tab):
  * Requirement skills are matched in BATCH against (a) the resume's skill labels and (b) the resume's own
    sentences ("Experience with <skill>" vs each bullet), so a paraphrase such as "containerised the services and
    shipped them to ECS" counts as evidence for Docker even when the word is never written.
  * Every verdict carries the exact similarity score, the resume skill it was matched with and the resume
    sentence that supports it - nothing is invented (spec section 33).
  * Whole-document similarity pools ALL resume/JD passages (mean of chunk embeddings) instead of embedding the
    first ~200 words only, which is all a 256-token transformer window can see.
"""
import json
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Optional

import numpy as np

from app.config import get_settings
from app.services import skill_text
from app.services.embeddings import EmbeddingUnavailable, get_engine  # noqa: F401  (re-exported for callers)

settings = get_settings()
logger = logging.getLogger("ai_ml_service.matcher")


# --------------------------------------------------------------------------------------- embedding helpers
def embed(text: str) -> list[float]:
    """Unit-length embedding of `text` (list form kept for backward compatibility)."""
    return get_engine().encode_one(text).tolist()


def embed_many(texts: list[str]) -> np.ndarray:
    return get_engine().encode(texts)


def cosine(a, b) -> float:
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    na = float(np.linalg.norm(a)) or 1.0
    nb = float(np.linalg.norm(b)) or 1.0
    return float(a @ b) / (na * nb)


def engine_info() -> dict:
    """Compact, response-safe description of the engine that produced a result."""
    st = get_engine().status()
    return {
        "engine": st["engine"], "model": st["model"], "device": st["device"], "dimension": st["dimension"],
        "semantic": st["semantic"], "fallback_mode": st["fallback_mode"],
    }


def _dim() -> int:
    return get_engine().ensure_ready().dim


def _model_id() -> str:
    return get_engine().model_name


class _FaissBackend:
    """Local, file-persisted vector index — no external service required."""

    def __init__(self):
        self.path = Path(settings.FAISS_INDEX_PATH)
        self.path.mkdir(parents=True, exist_ok=True)
        self.meta_file = self.path / "meta.jsonl"
        self._records: list[dict] = []
        self._index = None
        self._dim_cached = _dim()
        self._load()

    def _load(self):
        if self.meta_file.exists():
            # One truncated/corrupt line (e.g. the process was killed mid-write) must not stop the backend from
            # starting. Bad lines, and vectors written by a DIFFERENT embedding model (even with the same
            # dimension - their vector spaces are not comparable), are skipped.
            records = []
            model = _model_id()
            with open(self.meta_file, "r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        logger.warning("Skipping a corrupt line in %s", self.meta_file)
                        continue
                    if not (isinstance(rec, dict) and isinstance(rec.get("vector"), list)
                            and len(rec["vector"]) == self._dim_cached):
                        continue
                    if rec.get("model") not in (None, model):
                        continue
                    records.append(rec)
            self._records = records
        try:
            import faiss  # noqa: F401
            self._faiss = faiss
            self._np = np
            self._index = faiss.IndexFlatIP(self._dim_cached)
            if self._records:
                self._index.add(np.array([r["vector"] for r in self._records], dtype="float32"))
        except ImportError:
            self._index = None  # exact numpy cosine below (same result, no faiss needed)

    def upsert(self, id_: str, text: str, metadata: dict):
        vector = embed(text)
        record = {"id": id_, "text": text, "metadata": metadata, "vector": vector, "model": _model_id()}
        self._records = [r for r in self._records if r["id"] != id_]
        self._records.append(record)
        # Write to a temp file then atomically replace, so a crash mid-write can't leave a half-written index.
        tmp_file = self.meta_file.with_suffix(".jsonl.tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            for r in self._records:
                f.write(json.dumps(r) + "\n")
        os.replace(tmp_file, self.meta_file)
        if self._index is not None:
            self._index = self._faiss.IndexFlatIP(self._dim_cached)
            self._index.add(np.array([r["vector"] for r in self._records], dtype="float32"))

    def query(self, text: str, top_k: int = 5) -> list[dict]:
        if not self._records:
            return []
        qvec = np.asarray(embed(text), dtype="float32")
        if self._index is not None:
            k = min(top_k, len(self._records))
            scores, idxs = self._index.search(qvec.reshape(1, -1), k)
            ranked = [(float(sc), self._records[int(i)]) for sc, i in zip(scores[0], idxs[0]) if int(i) >= 0]
        else:
            mat = np.array([r["vector"] for r in self._records], dtype="float32")
            sims = mat @ qvec
            order = np.argsort(-sims)[:top_k]
            ranked = [(float(sims[i]), self._records[int(i)]) for i in order]
        return [{"id": r["id"], "score": round(score, 4), "text": r["text"], "metadata": r["metadata"]}
                for score, r in ranked[:top_k]]


class _QdrantBackend:
    def __init__(self):
        from qdrant_client import QdrantClient
        from qdrant_client.models import Distance, VectorParams
        self.client = QdrantClient(url=settings.QDRANT_URL, api_key=settings.QDRANT_API_KEY or None)
        self.collection = settings.QDRANT_COLLECTION
        try:
            self.client.get_collection(self.collection)
        except Exception:  # noqa: BLE001
            self.client.create_collection(
                collection_name=self.collection,
                vectors_config=VectorParams(size=_dim(), distance=Distance.COSINE),
            )

    def upsert(self, id_: str, text: str, metadata: dict):
        from qdrant_client.models import PointStruct
        vector = embed(text)
        self.client.upsert(self.collection, points=[
            # Deterministic UUID: Python's hash() is randomised per process, which used to create duplicates.
            PointStruct(id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"campus-portal/{id_}")), vector=vector,
                        payload={**metadata, "text": text, "ext_id": id_})
        ])

    def query(self, text: str, top_k: int = 5) -> list[dict]:
        vector = embed(text)
        # QdrantClient.search() was removed in recent qdrant-client releases; prefer query_points().
        if hasattr(self.client, "query_points"):
            hits = self.client.query_points(self.collection, query=vector, limit=top_k, with_payload=True).points
        else:
            hits = self.client.search(self.collection, query_vector=vector, limit=top_k)
        return [
            {"id": h.payload.get("ext_id"), "score": round(h.score, 4),
             "text": h.payload.get("text"), "metadata": {k: v for k, v in h.payload.items() if k not in ("text", "ext_id")}}
            for h in hits
        ]


class _PineconeBackend:
    def __init__(self):
        from pinecone import Pinecone
        self.pc = Pinecone(api_key=settings.PINECONE_API_KEY)
        self.index = self.pc.Index(settings.PINECONE_INDEX)

    def upsert(self, id_: str, text: str, metadata: dict):
        vector = embed(text)
        self.index.upsert(vectors=[{"id": id_, "values": vector, "metadata": {**metadata, "text": text}}])

    def query(self, text: str, top_k: int = 5) -> list[dict]:
        vector = embed(text)
        res = self.index.query(vector=vector, top_k=top_k, include_metadata=True)
        return [
            {"id": m.id, "score": round(m.score, 4), "text": m.metadata.get("text"),
             "metadata": {k: v for k, v in m.metadata.items() if k != "text"}}
            for m in res.matches
        ]


_backend = None


def get_backend():
    global _backend
    if _backend is not None:
        return _backend
    if settings.VECTOR_BACKEND == "qdrant":
        try:
            _backend = _QdrantBackend()
        except Exception as exc:  # noqa: BLE001 — Qdrant unreachable: use the local index (embeddings still real)
            logger.warning("Qdrant unavailable (%s); using the local FAISS index.", exc)
            _backend = _FaissBackend()
    elif settings.VECTOR_BACKEND == "pinecone":
        try:
            _backend = _PineconeBackend()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Pinecone unavailable (%s); using the local FAISS index.", exc)
            _backend = _FaissBackend()
    else:
        _backend = _FaissBackend()
    return _backend


def reset_backend_for_tests():
    global _backend
    _backend = None


def index_profile(profile_id: str, text: str, metadata: Optional[dict] = None):
    get_backend().upsert(profile_id, text, metadata or {})


def semantic_search(query_text: str, top_k: int = 5) -> list[dict]:
    return get_backend().query(query_text, top_k)


# ------------------------------------------------------------------------------------ document similarity
def _doc_vector(text: str) -> Optional[np.ndarray]:
    """Mean of all passage embeddings (unit length) so the WHOLE document counts, not just its first window."""
    text = (text or "").strip()
    if not text:
        return None
    passages = skill_text.split_passages(text) or [skill_text.clean(text)[:600]]
    vecs = embed_many(passages)
    mean = vecs.mean(axis=0)
    norm = float(np.linalg.norm(mean)) or 1.0
    return mean / norm


def _requirement_coverage(jd_passages: list[str], resume_vecs: np.ndarray, jd_vecs: np.ndarray) -> Optional[float]:
    """Late-interaction score: how well each JD sentence is answered by SOME resume sentence (mean of maxima)."""
    if not len(jd_passages) or not len(resume_vecs):
        return None
    return float((jd_vecs @ resume_vecs.T).max(axis=1).mean())


def match_resume_to_jd(resume_text: str, jd_text: str) -> dict:
    """Single-pair semantic similarity — no index needed, used by the Resume-JD panel."""
    get_engine().ensure_ready()
    info = engine_info()
    rv, jv = _doc_vector(resume_text), _doc_vector(jd_text)
    score = float(rv @ jv) if rv is not None and jv is not None else 0.0
    coverage = None
    if rv is not None and jv is not None:
        r_pass = skill_text.split_passages(resume_text) or [skill_text.clean(resume_text)[:600]]
        j_pass = skill_text.split_passages(jd_text) or [skill_text.clean(jd_text)[:600]]
        coverage = _requirement_coverage(j_pass, embed_many(r_pass), embed_many(j_pass))
    return {
        "semantic_similarity": round(max(0.0, score) * 100, 1),
        "jd_requirement_coverage": round(max(0.0, coverage) * 100, 1) if coverage is not None else None,
        "backend": settings.VECTOR_BACKEND,
        "embedding_engine": info["model"] if info["semantic"] else "lexical-hash",
        "engine": info,
        # A lexical fallback result must never be presented as equivalent to a semantic model.
        "confidence": "high" if info["semantic"] else "low",
        "fallback_mode": info["fallback_mode"],
    }


# ---------------------------------------------------------------------------------------
# Explainable Competency Matching (spec section 9): per-skill matched / partially-matched / missing, each with
# the exact evidence behind it. Prerequisite/"required-by" reasoning for missing skills lives in the Node
# backend's Competency Knowledge Graph (GET /api/twin/gap-analysis), not duplicated here.
PARTIAL_MATCH_THRESHOLD = settings.SEMANTIC_PARTIAL_THRESHOLD   # skill label ~ skill label: related, not equivalent
STRONG_PARTIAL_THRESHOLD = settings.SEMANTIC_STRONG_THRESHOLD   # at/above: equivalent skill ("already have it")


def _normalize_skill(skill: str) -> str:
    return (skill or "").strip().lower()


def _thresholds() -> dict:
    s = get_settings()   # re-read each call so tests / operators can retune without a restart
    return {"strong": s.SEMANTIC_STRONG_THRESHOLD, "partial": s.SEMANTIC_PARTIAL_THRESHOLD,
            "passage": s.SEMANTIC_PASSAGE_MATCH, "passage_partial": s.SEMANTIC_PASSAGE_PARTIAL}


def _snippet(text: str, limit: int = 220) -> str:
    text = skill_text.clean(text)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _passage_containing(skill: str, passages: list[str]) -> Optional[str]:
    for p in passages:
        if skill_text.word_in_text(skill, p):
            return p
    return None


def match_requirements(requirements: list[str], resume_skills: Optional[list[str]] = None,
                       resume_text: str = "") -> dict:
    """Judge every requirement against a resume by MEANING.

    Returns {"results": [...], "engine": {...}, "thresholds": {...}, "passages": n, "candidates": n}; each result:
      skill, status (matched|partial|missing), match_type (exact|mention|semantic|evidenced|partial|missing),
      confidence (0-1; 1.0 for exact/mention), similarity (best cosine seen), matched_with (resume skill label),
      passage (supporting resume sentence), evidence (plain-language reason).
    Raises EmbeddingUnavailable when the model is not usable and there is something to compare.
    """
    reqs = [skill_text.display(r) for r in (requirements or []) if skill_text.display(r)]
    cands = skill_text.candidate_skills(resume_text, resume_skills or [])
    passages = skill_text.split_passages(resume_text)
    th = _thresholds()
    results: list[dict] = []

    def _missing(req, why):
        return {"skill": req, "status": "missing", "match_type": "missing", "confidence": 0.0, "similarity": 0.0,
                "matched_with": None, "passage": None, "evidence": why}

    if not reqs:
        return {"results": [], "engine": None, "thresholds": th, "passages": len(passages), "candidates": len(cands)}
    if not cands and not passages and not (resume_text or "").strip():
        # Nothing to compare against: every requirement is missing. No model call is needed for that conclusion.
        return {"results": [_missing(r, "No resume skills or text were provided to compare against.") for r in reqs],
                "engine": None, "thresholds": th, "passages": 0, "candidates": 0}

    engine = get_engine().ensure_ready()
    var_map = {r: skill_text.variants(r) or [r] for r in reqs}
    all_variants = sorted({v for vs in var_map.values() for v in vs})
    queries = {v: skill_text.evidence_query(v) for v in all_variants}
    cand_mat = engine.encode(cands) if cands else np.zeros((0, engine.dim), dtype=np.float32)
    pass_mat = engine.encode(passages) if passages else np.zeros((0, engine.dim), dtype=np.float32)
    var_mat = engine.encode(all_variants)
    qry_mat = engine.encode([queries[v] for v in all_variants])
    v_index = {v: i for i, v in enumerate(all_variants)}
    label_sims = var_mat @ cand_mat.T if len(cands) else np.zeros((len(all_variants), 0), dtype=np.float32)
    pass_sims = qry_mat @ pass_mat.T if len(passages) else np.zeros((len(all_variants), 0), dtype=np.float32)
    cand_canon = {skill_text.canonical(c): c for c in cands}

    for req in reqs:
        vs = var_map[req]
        # 1) deterministic: the skill (or an alias / one of its variants) is literally on the resume.
        exact_label = next((cand_canon[skill_text.canonical(v)] for v in vs if skill_text.canonical(v) in cand_canon), None)
        mention_passage = None
        mention_variant = None
        for v in vs:
            mp = _passage_containing(v, passages)
            if mp is None and resume_text and skill_text.word_in_text(v, resume_text):
                mp = ""   # present in the text but not inside a split passage (e.g. a one-word line)
            if mp is not None:
                mention_passage, mention_variant = mp, v
                break
        if exact_label is not None or mention_variant is not None:
            via = exact_label or mention_variant
            passage = mention_passage or (_passage_containing(via, passages) or None)
            results.append({
                "skill": req, "status": "matched", "match_type": "exact" if exact_label is not None else "mention",
                "confidence": 1.0, "similarity": 1.0, "matched_with": via,
                "passage": _snippet(passage) if passage else None,
                "evidence": (f"'{via}' is listed verbatim in your resume's skills." if exact_label is not None
                             else f"'{via}' is mentioned in your resume text."),
            })
            continue

        # 2) semantic: best label-to-label and best requirement-to-sentence similarity across all variants.
        best_label, best_label_with = 0.0, None
        best_pass, best_pass_text = 0.0, None
        for v in vs:
            i = v_index[v]
            if label_sims.shape[1]:
                j = int(np.argmax(label_sims[i]))
                if float(label_sims[i, j]) > best_label:
                    best_label, best_label_with = float(label_sims[i, j]), cands[j]
            if pass_sims.shape[1]:
                j = int(np.argmax(pass_sims[i]))
                if float(pass_sims[i, j]) > best_pass:
                    best_pass, best_pass_text = float(pass_sims[i, j]), passages[j]
        best_label, best_pass = round(max(0.0, best_label), 3), round(max(0.0, best_pass), 3)

        if best_label >= th["strong"]:
            results.append({"skill": req, "status": "matched", "match_type": "semantic", "confidence": best_label,
                            "similarity": best_label, "matched_with": best_label_with,
                            "passage": _snippet(best_pass_text) if best_pass >= th["passage_partial"] and best_pass_text else None,
                            "evidence": f"Not listed verbatim, but your '{best_label_with}' is a near-equivalent skill "
                                        f"(semantic similarity {best_label})."})
        elif best_pass >= th["passage"]:
            results.append({"skill": req, "status": "matched", "match_type": "evidenced", "confidence": best_pass,
                            "similarity": best_pass, "matched_with": best_label_with if best_label >= th["partial"] else None,
                            "passage": _snippet(best_pass_text),
                            "evidence": f"Evidenced by this line of your resume (semantic similarity {best_pass}): "
                                        f"“{_snippet(best_pass_text, 140)}”"})
        elif best_label >= th["partial"] or best_pass >= th["passage_partial"]:
            use_label = best_label >= th["partial"] and best_label >= best_pass
            conf = best_label if use_label else best_pass
            results.append({"skill": req, "status": "partial", "match_type": "partial", "confidence": conf,
                            "similarity": conf, "matched_with": best_label_with if use_label else None,
                            "closest_resume_skill": best_label_with if use_label else None,
                            "passage": _snippet(best_pass_text) if best_pass_text and not use_label else None,
                            "evidence": (f"Your '{best_label_with}' is related but not equivalent (semantic similarity "
                                         f"{best_label}) — likely a transferable skill rather than direct experience."
                                         if use_label else
                                         f"Partly evidenced by: “{_snippet(best_pass_text, 140)}” (semantic "
                                         f"similarity {best_pass}) — related work, not clear direct experience.")})
        else:
            closest = best_label_with if best_label >= best_pass or not best_pass_text else None
            r = _missing(req, "No resume skill or sentence is semantically close to this requirement"
                              + (f" (closest: '{closest}' at {best_label})." if closest else "."))
            r["similarity"] = max(best_label, best_pass)
            r["matched_with"] = None
            r["closest_resume_skill"] = closest
            results.append(r)

    return {"results": results, "engine": engine_info(), "thresholds": th,
            "passages": len(passages), "candidates": len(cands)}


def explain_resume_jd_match(resume_skills: list[str], jd_skills: list[str],
                             resume_text: str = "", jd_text: str = "") -> dict:
    """Skill-level explainable match. `resume_skills`/`jd_skills` are the lists already produced by
    parser.extract_skills()/parse_job_description() — extraction is not re-run here.

    Every JD skill is judged by match_requirements(): literal listing/mention -> "matched" (exact), otherwise by
    embedding similarity to the resume's skills AND sentences -> matched (semantic/evidenced), partially_matched
    or missing. Every confidence number is the exact cosine score (or 1.0 for a literal match).
    """
    outcome = match_requirements(list(jd_skills or []), list(resume_skills or []), resume_text or "")
    matched, partial, missing = [], [], []
    for r in outcome["results"]:
        item = {"skill": r["skill"], "confidence": r["confidence"], "evidence": r["evidence"],
                "match_type": r["match_type"], "similarity": r["similarity"],
                "matched_with": r.get("matched_with"), "evidence_passage": r.get("passage")}
        if r["status"] == "matched":
            matched.append(item)
        elif r["status"] == "partial":
            item["closest_resume_skill"] = r.get("closest_resume_skill")
            partial.append(item)
        else:
            item["closest_resume_skill"] = r.get("closest_resume_skill")
            missing.append(item)

    total = len(jd_skills or []) or 1
    # Exact, traceable decomposition (not an approximation): each matched skill contributes a full point, each
    # partial match contributes its own similarity score as a fraction of a point.
    skill_coverage_score = round(100 * (len(matched) + sum(p["confidence"] for p in partial)) / total, 1)

    whole_doc = None
    requirement_cov = None
    if (resume_text or "").strip() and (jd_text or "").strip():
        pair = match_resume_to_jd(resume_text, jd_text)
        whole_doc = pair["semantic_similarity"]
        requirement_cov = pair["jd_requirement_coverage"]

    info = outcome["engine"] or (engine_info() if get_engine().is_ready else None)
    return {
        "matched_skills": matched,
        "partially_matched_skills": partial,
        "missing_skills": missing,
        "skill_coverage_score": skill_coverage_score,
        "semantic_similarity": whole_doc,  # kept for backward compatibility with existing callers
        "jd_requirement_coverage": requirement_cov,
        "backend": settings.VECTOR_BACKEND,
        "embedding_engine": (info["model"] if info and info["semantic"] else ("lexical-hash" if info else None)),
        "engine": info,
        "fallback_mode": bool(info and info["fallback_mode"]),
        "thresholds": outcome["thresholds"],
        "note": "Prerequisite/graph-based explanations for missing skills are available via the "
                "Digital Twin's gap-analysis endpoint once matched skills are synced (see "
                "POST /api/twin/sync-resume-match then GET /api/twin/gap-analysis).",
    }
