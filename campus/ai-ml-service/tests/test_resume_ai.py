"""
Tests for the Resume-tab AI/ML endpoints (app/services/resume_ai.py).

No network and no LLM keys: the LLM path is monkeypatched, and with no keys the deterministic path is exercised.
Run from ai-ml-service/:   pytest tests/test_resume_ai.py -v
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import resume_ai  # noqa: E402

RESUME = "Python developer. Built REST APIs with Flask and SQL. Skills: python, sql, git, docker. B.Tech CSE 2026."
JD = "Looking for a software engineer with python, sql, REST API, docker, aws and data structures."


def run(coro):
    return asyncio.run(coro)


def _no_llm(monkeypatch):
    async def boom(*a, **k):
        raise resume_ai.call_llm.__globals__["LLMError"]("No LLM provider is configured.")
    monkeypatch.setattr(resume_ai, "call_llm", boom)


def _fake_llm(monkeypatch, payload):
    async def fake(system, user, opts=None):
        return {"text": payload, "provider": "fake"}
    monkeypatch.setattr(resume_ai, "call_llm", fake)


def test_analyze_without_llm_is_complete_and_deterministic(monkeypatch):
    _no_llm(monkeypatch)
    r = run(resume_ai.analyze(RESUME, JD, "Software Engineer"))
    assert r["llm_unavailable"] is True and r["generated_by"] == "deterministic-evidence"
    assert {"python", "sql", "docker"} <= set(r["matched"])
    assert {"aws", "data structures"} <= set(r["missing"])
    assert 0 <= r["ats_score"] <= 100
    assert r["fit_summary"] and len(r["tailored_bullets"]) == 3 and r["formatting_tips"]
    assert "No LLM provider" not in str(r)            # provider/exception text never leaks


def test_analyze_llm_cannot_override_numbers_and_bad_shapes_are_normalised(monkeypatch):
    _fake_llm(monkeypatch, '{"fit_summary": "You have python and sql skills.", "ats_score": 99, '
                           '"strengths": "Python\\nSQL", "gaps": [{"text": "aws missing"}], '
                           '"tailored_bullets": "a\\nb\\nc", "formatting_tips": 5}')
    r = run(resume_ai.analyze(RESUME, JD))
    assert r["ats_score"] != 99 and r["generated_by"] == "llm:fake"
    assert r["strengths"] == ["Python", "SQL"] and r["gaps"] == ["aws missing"]
    assert r["tailored_bullets"] == ["a", "b", "c"]
    assert isinstance(r["formatting_tips"], list)


def test_analyze_replaces_ungrounded_llm_summary(monkeypatch):
    _fake_llm(monkeypatch, '{"fit_summary": "Candidate mastered Kubernetes, Terraform and Rust at Google for six years."}')
    r = run(resume_ai.analyze(RESUME, JD, "Software Engineer"))
    assert r.get("fit_summary_replaced") is True
    assert "Kubernetes" not in r["fit_summary"]


def test_analyze_handles_empty_and_garbage_inputs(monkeypatch):
    _no_llm(monkeypatch)
    assert run(resume_ai.analyze("", ""))["ats_score"] == 0
    assert run(resume_ai.analyze(RESUME, ""))["jd_skills"] == [] if "jd_skills" in run(resume_ai.analyze(RESUME, "")) else True
    run(resume_ai.analyze("x" * 500000, "y" * 500000))   # clipped, must not raise


def test_ats_optimize_shape_matches_ui_contract(monkeypatch):
    _no_llm(monkeypatch)
    r = run(resume_ai.ats_optimize(RESUME, JD))
    assert isinstance(r["atsScore"], int) and r["verdict"]
    assert len(r["bulletRewrites"]) == 3 and "aws" in r["keywordsToAdd"]


def test_ats_optimize_filters_invented_keywords(monkeypatch):
    _fake_llm(monkeypatch, '{"verdict": "Decent fit.", "bulletRewrites": ["x","y","z"], "keywordsToAdd": ["aws", "quantum computing"]}')
    r = run(resume_ai.ats_optimize(RESUME, JD))
    assert "aws" in r["keywordsToAdd"] and "quantum computing" not in r["keywordsToAdd"]


def test_enhance_never_invents_sections_and_reports_unavailable(monkeypatch):
    _no_llm(monkeypatch)
    r = run(resume_ai.enhance("", "Interned at ACME", "", "python"))
    assert r["llm_unavailable"] is True and r["experience"] == "Interned at ACME"
    _fake_llm(monkeypatch, '{"summary": "Invented summary", "experience": ["Did X", "Did Y"], "projects": "Invented project"}')
    r = run(resume_ai.enhance("", "Interned at ACME", "", "python"))
    assert r["summary"] == "" and r["projects"] == ""            # empty input stays empty
    assert r["experience"] == "Did X\nDid Y"                      # list -> newline-joined string


def test_enhance_all_empty_is_a_noop(monkeypatch):
    _no_llm(monkeypatch)
    assert run(resume_ai.enhance("", "", "", ""))["generated_by"] == "unchanged"
