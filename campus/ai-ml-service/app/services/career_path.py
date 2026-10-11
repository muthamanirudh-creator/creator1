"""
AI Career Path Predictor.

New AI/ML capability (not just a deepening of the existing 3). Given a student's current
skills and/or per-topic mastery from the Adaptive Diagnostic Engine, scores them against a
curated set of career archetypes (data/career_paths.json) by skill overlap, and returns a
ranked list of "you're closest to X" tracks with the concrete milestone roadmap for each.

Follows the same offline-first pattern as market_intel.py and roadmap.py: the ranking and
milestones always work with zero external calls (pure set-overlap scoring against the
curated dataset), and — only if an LLM provider key is configured — an optional short
natural-language rationale is layered on top of the #1 match. A failed/unconfigured LLM
call degrades to the deterministic rationale, never an error.
"""
import json
import logging
from pathlib import Path
from typing import Optional

import asyncio

from app.services import matcher
from app.services.embeddings import EmbeddingUnavailable
from app.services.llm_providers import call_llm, LLMError
from app.services.explainability import career_match_evidence
from app.services.ai_reliability import check_reliability

logger = logging.getLogger("ai_ml_service.career_path")

_DATA_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "career_paths.json"
with open(_DATA_PATH, "r") as _f:
    _DATASET = json.load(_f)

_ARCHETYPES: list[dict] = _DATASET["archetypes"]


def list_archetypes() -> list[dict]:
    return [{"id": a["id"], "title": a["title"], "core_skills": a["core_skills"]} for a in _ARCHETYPES]


def _normalize(skill: str) -> str:
    return str(skill or "").strip().lower()


def _clamp01(v) -> float:
    """Mastery values are documented as 0-1; clamp so a stray 85 (a percent) can't push confidence past 100."""
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.6


def _score_archetype(archetype: dict, matched_flags: list[bool], mastery: dict[str, float]) -> dict:
    core = [_normalize(s) for s in archetype["core_skills"]]
    matched = [s for s, ok in zip(core, matched_flags) if ok]
    missing = [archetype["core_skills"][i] for i, ok in enumerate(matched_flags) if not ok]

    coverage = len(matched) / len(core) if core else 0.0
    # Weight matched skills by mastery level if we have adaptive-engine theta/level data for
    # them (0-1 scale expected; unknown skills default to 0.6 — "some exposure, unverified").
    mastery_bonus = sum(_clamp01(mastery.get(s, 0.6)) for s in matched) / len(core) if core else 0.0
    confidence = round(100 * (0.6 * coverage + 0.4 * mastery_bonus), 1)

    result = {
        "id": archetype["id"],
        "title": archetype["title"],
        "confidence": confidence,
        "matched_skills": [archetype["core_skills"][i] for i, ok in enumerate(matched_flags) if ok],
        "missing_skills": missing,
        "milestones": archetype["milestones"],
    }
    # Exact decomposition stashed for the caller (predict()) to finalize once it knows whether
    # the target-interest boost applied — kept off the public dict shape until then.
    result["_coverage"] = coverage
    result["_mastery_bonus"] = mastery_bonus
    return result


def _match_flags(skill_set: set[str], current_skills: list[str]) -> tuple[dict[str, tuple[bool, Optional[str], float]], Optional[dict]]:
    """For every distinct archetype core skill: (is matched, matched_with, similarity). Exact names always count;
    a near-equivalent (embedding similarity >= SEMANTIC_STRONG_THRESHOLD) counts too. When the embedding model is
    unavailable the result is exact-only and the caller is told (never silently)."""
    cores = sorted({s for a in _ARCHETYPES for s in a["core_skills"]})
    flags = {c: (_normalize(c) in skill_set, c if _normalize(c) in skill_set else None, 1.0 if _normalize(c) in skill_set else 0.0)
             for c in cores}
    have = [s for s in current_skills if _normalize(s)]
    if not have:
        return flags, matcher.engine_info() if matcher.get_engine().is_ready else None
    try:
        outcome = matcher.match_requirements(cores, have, "")
    except EmbeddingUnavailable as exc:
        logger.warning("Career-path ranking is exact-name only for this request: %s", exc)
        return flags, None
    for r in outcome["results"]:
        if r["status"] == "matched":
            flags[r["skill"]] = (True, r.get("matched_with"), r["similarity"])
    return flags, outcome["engine"]


async def predict(
    current_skills: list[str],
    topic_mastery: Optional[dict[str, float]] = None,
    target_interest: Optional[str] = None,
    top_n: int = 3,
) -> dict:
    skill_set = {_normalize(s) for s in (current_skills or []) if _normalize(s)}
    mastery = {_normalize(k): v for k, v in (topic_mastery or {}).items()}

    flags, engine = await asyncio.to_thread(_match_flags, skill_set, list(current_skills or []))
    scored = [_score_archetype(a, [flags[c][0] for c in a["core_skills"]], mastery) for a in _ARCHETYPES]
    for sc, a in zip(scored, _ARCHETYPES):
        via = {c: flags[c][1] for c in a["core_skills"] if flags[c][0] and flags[c][1] and _normalize(flags[c][1]) != _normalize(c)}
        if via:
            sc["matched_via_equivalent_skill"] = via     # e.g. {"JavaScript": "js"}: shown, never hidden

    interest_matched_ids: set[str] = set()
    # FIX: a whitespace-only target_interest passed the truthiness check, became "" after strip(), and
    # `"" in title` is True for every archetype — so every track got the +15 boost and the ranking was distorted.
    interest = (target_interest or "").strip().lower()
    if interest:
        for s in scored:
            if interest in s["title"].lower() or interest in s["id"]:
                s["confidence"] = min(100.0, s["confidence"] + 15)
                interest_matched_ids.add(s["id"])

    scored.sort(key=lambda s: s["confidence"], reverse=True)
    top = scored[:top_n]

    # Build exact, non-fabricated "why this recommendation" evidence for each returned match,
    # then drop the internal-only decomposition fields from the public response shape.
    for s in top:
        s["evidence"] = career_match_evidence(
            s, s["_coverage"], s["_mastery_bonus"], s["id"] in interest_matched_ids, semantic=engine is not None
        )
        del s["_coverage"]
        del s["_mastery_bonus"]

    rationale = (
        f"Based on overlap with your current skills, {top[0]['title']} is your closest match "
        f"({top[0]['confidence']}% skill coverage)."
        if top else "Add a few skills to get a career-path match."
    )
    llm_used = False
    if top:
        try:
            system = (
                "You are a concise, encouraging career coach for campus placement students in India. "
                "In 2-3 sentences, explain why the given top career-path match fits the student's current "
                "skills, and name the single most valuable skill to learn next from the missing list. "
                "No markdown, no preamble, plain text only."
            )
            user = json.dumps({
                "top_match": top[0]["title"],
                "matched_skills": top[0]["matched_skills"],
                "missing_skills": top[0]["missing_skills"],
                "confidence": top[0]["confidence"],
            })
            result = await call_llm(system, user, opts={"maxTokens": 320, "temperature": 0.5, "noCache": True})
            text = (result or {}).get("text", "")
            if text and text.strip():
                rationale = text.strip()
                llm_used = True
        except LLMError:
            pass  # deterministic rationale above already covers this
        except Exception as exc:  # noqa: BLE001 - the LLM rationale is optional; never fail the ranking over it
            logger.warning("Career-path LLM rationale failed: %s: %s", type(exc).__name__, exc)

    response = {"matches": top, "rationale": rationale, "llm_enriched": llm_used,
                "generated_by": "live-llm" if llm_used else "grounded-algorithmic-fallback",
                "matching_engine": ({**engine, "mode": "semantic-embeddings"} if engine else {"mode": "exact-name-only"})}

    # AI Reliability layer (spec §16): only meaningful for LLM-generated text — the
    # deterministic rationale above is built directly from these same facts, so checking it
    # against itself would be circular and add nothing.
    if llm_used:
        known_facts = [
            f"{top[0]['title']} matched skills: {', '.join(top[0]['matched_skills']) or 'none'}.",
            f"{top[0]['title']} missing skills: {', '.join(top[0]['missing_skills']) or 'none'}.",
            f"Skill coverage confidence for {top[0]['title']} is {top[0]['confidence']}%.",
        ]
        known_facts += [f"{s} is a matched skill for {top[0]['title']}." for s in top[0]["matched_skills"]]
        known_facts += [f"{s} is a missing skill for {top[0]['title']}, recommended to learn next."
                         for s in top[0]["missing_skills"]]
        reliability = check_reliability(rationale, known_facts)
        response["rationale_reliability"] = reliability
        if reliability.get("confidence_label") == "low":
            response["rationale"] = (
                f"Based on overlap with your current skills, {top[0]['title']} is your closest match "
                f"({top[0]['confidence']}% skill coverage)."
            )
            response["rationale_replaced"] = True

    return response
