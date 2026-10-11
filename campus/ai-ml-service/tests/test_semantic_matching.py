"""
Tests for the real-semantic-matching layer (embeddings.py, matcher.py, role_catalog.py, skill_gap.py, match router logic).

Matching LOGIC is tested with the deterministic test double from _semantic_stub.py (installed by conftest.py).
The transformer model itself is verified by `python scripts/verify_semantic.py`.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _semantic_stub  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.services import career_path, matcher, role_catalog, skill_gap, skill_text  # noqa: E402
from app.services.embeddings import EmbeddingEngine, EmbeddingUnavailable, get_engine  # noqa: E402

RESUME = ("Skills: Python, SQL\n"
          "- Containerised the payment service and shipped it to AWS ECS using GitHub Actions.\n"
          "- Built REST endpoints with Flask and wrote unit tests with pytest.")


def run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------------------------------------- engine
def test_engine_reports_injected_engine_never_as_transformer():
    st = get_engine().status()
    assert st["ready"] and st["engine"] == "injected" and st["fallback_mode"] is False


def test_strict_mode_raises_instead_of_hashing(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ALLOW_LEXICAL_FALLBACK", False)
    monkeypatch.setattr(s, "EMBEDDING_MODEL_PATH", "/definitely/not/a/model")
    eng = EmbeddingEngine()
    try:
        eng.ensure_ready(timeout=30)
        raise AssertionError("must not become ready without a model")
    except EmbeddingUnavailable as exc:
        assert exc.code == "EMBEDDING_MODEL_UNAVAILABLE"
        assert eng.state == "error" and not eng.is_ready
    st = eng.status()
    assert st["semantic"] is False and st["error"]


def test_lexical_fallback_is_opt_in_and_always_flagged(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ALLOW_LEXICAL_FALLBACK", True)
    monkeypatch.setattr(s, "EMBEDDING_MODEL_PATH", "/definitely/not/a/model")
    eng = EmbeddingEngine()
    eng.ensure_ready(timeout=30)
    st = eng.status()
    assert st["fallback_mode"] is True and st["semantic"] is False and st["engine"] == "lexical-hash"
    assert eng.encode(["python developer"]).shape[1] == s.EMBEDDING_DIM


def test_encode_is_normalised_cached_and_batched():
    eng = get_engine()
    a = eng.encode(["docker", "docker", "kubernetes"])
    assert a.shape == (3, _semantic_stub.DIM)
    assert abs(float((a[0] * a[0]).sum()) - 1.0) < 1e-5
    before = eng.status()["cache"]["hits"]
    eng.encode(["docker"])
    assert eng.status()["cache"]["hits"] == before + 1


# ------------------------------------------------------------------------------------- skill_text
def test_aliases_variants_and_whole_word_matching():
    assert skill_text.canonical("JS") == "javascript" and skill_text.canonical("ReactJS") == "react"
    assert skill_text.variants("Pandas/NumPy")[:3] == ["Pandas/NumPy", "Pandas", "NumPy"]
    assert "Prometheus" in skill_text.variants("Monitoring (Prometheus/Grafana)")
    assert skill_text.word_in_text("java", "I know JavaScript only") is None
    assert skill_text.word_in_text("js", "wrote JS and CSS")
    assert skill_text.word_in_text("go", "good Google") is None


def test_candidate_skills_read_the_skills_section_beyond_any_vocabulary():
    text = "Education\nB.Tech\nTechnical Skills: Rust, gRPC, Terraform | Figma\nProjects\nBuilt things"
    got = skill_text.candidate_skills(text, ["python"])
    assert {"python", "Rust", "gRPC", "Terraform", "Figma"} <= set(got)


# --------------------------------------------------------------------------------------- matcher
def test_listed_skill_is_exact_and_paraphrase_is_credited_from_the_sentence():
    out = matcher.match_requirements(["Python", "Docker", "Statistics"], ["python", "sql"], RESUME)
    by = {r["skill"]: r for r in out["results"]}
    assert by["Python"]["match_type"] == "exact" and by["Python"]["confidence"] == 1.0
    assert by["Docker"]["status"] in ("matched", "partial") and "Containerised" in by["Docker"]["passage"]
    assert by["Docker"]["similarity"] > 0.4
    assert by["Statistics"]["status"] == "missing" and by["Statistics"]["passage"] is None


def test_verbatim_mention_in_text_counts_without_being_in_the_skill_list():
    out = matcher.match_requirements(["pytest"], [], "Wrote unit tests with pytest for every service.")
    assert out["results"][0]["match_type"] == "mention" and "pytest" in out["results"][0]["passage"]


def test_alias_equivalence_is_exact_not_fuzzy():
    out = matcher.match_requirements(["JavaScript"], ["js"], "")
    assert out["results"][0]["match_type"] == "exact" and out["results"][0]["matched_with"] == "js"


def test_slash_variants_any_one_satisfies_the_requirement():
    out = matcher.match_requirements(["Pandas/NumPy"], ["numpy"], "")
    assert out["results"][0]["status"] == "matched"


def test_no_resume_means_missing_without_needing_the_model(monkeypatch):
    eng = get_engine()
    eng.reset()   # model unavailable and nothing to compare -> still a well-defined answer, no exception
    try:
        out = matcher.match_requirements(["docker"], [], "")
        assert out["results"][0]["status"] == "missing"
    finally:
        _semantic_stub.install()


def test_semantic_endpoints_raise_when_model_is_unavailable(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ALLOW_LEXICAL_FALLBACK", False)
    monkeypatch.setattr(s, "EMBEDDING_MODEL_PATH", "/definitely/not/a/model")
    get_engine().reset()
    try:
        for fn in (lambda: matcher.match_requirements(["docker"], ["python"], RESUME),
                   lambda: matcher.match_resume_to_jd(RESUME, "docker and aws"),
                   lambda: role_catalog.resolve("Senior MERN stack engineer")):
            try:
                fn()
                raise AssertionError("expected EmbeddingUnavailable")
            except EmbeddingUnavailable as exc:
                assert exc.code == "EMBEDDING_MODEL_UNAVAILABLE"
    finally:
        _semantic_stub.install()


def test_whole_document_similarity_pools_every_passage():
    r = matcher.match_resume_to_jd(RESUME, "We need python, REST APIs, docker and aws deployment with unit tests.")
    assert 0 < r["semantic_similarity"] <= 100 and r["jd_requirement_coverage"] is not None
    assert r["fallback_mode"] is False and r["engine"]["engine"] == "injected"
    unrelated = matcher.match_resume_to_jd(RESUME, "Sourdough bread baking recipe for a pie.")
    assert unrelated["semantic_similarity"] < r["semantic_similarity"]


def test_explain_keeps_backward_compatible_shape_and_adds_evidence():
    r = matcher.explain_resume_jd_match(["python", "sql"], ["python", "docker", "statistics"], RESUME, "python docker statistics")
    assert {"matched_skills", "partially_matched_skills", "missing_skills", "skill_coverage_score",
            "semantic_similarity", "backend", "embedding_engine"} <= set(r)
    docker = next(x for x in r["matched_skills"] + r["partially_matched_skills"] if x["skill"] == "docker")
    assert docker["evidence_passage"] and docker["similarity"] > 0.4
    assert r["fallback_mode"] is False


# --------------------------------------------------------------------------------- role catalogue
def test_role_resolution_alias_then_meaning_then_none():
    assert role_catalog.resolve("SDE")["method"] == "alias"
    assert role_catalog.resolve("data scientist")["role"] == "Data Scientist"
    assert role_catalog.resolve("")["role"] is None
    far = role_catalog.resolve("Sourdough baker")
    assert far["role"] is None and far["method"] == "none"
    reqs = role_catalog.requirements("Data Scientist")
    assert reqs and all({"skill", "weight"} <= set(x) for x in reqs)


# --------------------------------------------------------------------------------------- skill gap
def test_skill_gap_semantic_judging_overrides_llm_claims(monkeypatch):
    async def fake(*a, **k):
        # The LLM wrongly claims SQL is matched and Docker is missing; the semantic judge decides.
        return {"text": '{"need":["Python","SQL","Kubernetes"],"matched":["SQL"],"missing":["Python"],"notes":"Learn Kubernetes next."}', "provider": "groq"}
    monkeypatch.setattr(skill_gap, "call_llm", fake)
    res = run(skill_gap.analyze("Data Analyst", ["Python"], ""))
    assert res["matched"] == ["Python"] and "SQL" in res["missing"] and "Kubernetes" in res["missing"]
    assert res["matching_engine"]["mode"] == "semantic-embeddings"
    assert res["generated_by"] == "llm:groq+semantic" and res["ai_enriched"] is True
    assert all({"skill", "status", "similarity", "evidence"} <= set(s) for s in res["skills"])


def test_skill_gap_without_llm_still_uses_embeddings_and_catalogue(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("no provider")
    monkeypatch.setattr(skill_gap, "call_llm", boom)
    res = run(skill_gap.analyze("Data Scientist", ["Python", "SQL"], RESUME))
    assert res["llm_unavailable"] is True and res["requirements_source"] in ("catalog", "llm+catalog")
    assert res["generated_by"] == "semantic-catalog" and res["resolved_role"] == "Data Scientist"
    assert res["need"] and 0 <= res["pct"] <= 100


def test_skill_gap_propagates_model_unavailable_instead_of_guessing(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ALLOW_LEXICAL_FALLBACK", False)
    monkeypatch.setattr(s, "EMBEDDING_MODEL_PATH", "/definitely/not/a/model")
    get_engine().reset()
    try:
        try:
            run(skill_gap.analyze("Quantum Product Engineer", ["Python"], "x"))
            raise AssertionError("expected EmbeddingUnavailable")
        except EmbeddingUnavailable:
            pass
    finally:
        _semantic_stub.install()


# ------------------------------------------------------------------------------------ career path
def test_career_path_counts_equivalent_skill_and_reports_engine(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("no provider")
    monkeypatch.setattr(career_path, "call_llm", boom)
    res = run(career_path.predict(["js", "react", "html/css"], target_interest=None, top_n=2))
    top = res["matches"][0]
    assert top["id"] == "frontend-engineer" and "JavaScript" in top["matched_skills"]
    assert top["matched_via_equivalent_skill"].get("JavaScript") == "js"
    assert res["matching_engine"]["mode"] == "semantic-embeddings"


def test_career_path_is_exact_only_and_says_so_when_model_unavailable(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("no provider")
    monkeypatch.setattr(career_path, "call_llm", boom)
    s = get_settings()
    monkeypatch.setattr(s, "ALLOW_LEXICAL_FALLBACK", False)
    monkeypatch.setattr(s, "EMBEDDING_MODEL_PATH", "/definitely/not/a/model")
    get_engine().reset()
    try:
        res = run(career_path.predict(["Python", "SQL"], top_n=1))
        assert res["matching_engine"] == {"mode": "exact-name-only"} and res["matches"]
    finally:
        _semantic_stub.install()
