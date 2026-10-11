"""
Role catalogue: one merged view of every role the service knows about, with semantic role resolution.

Sources merged (nothing is dropped):
  * data/market_skills.json        - roles + aliases + demand-weighted skills (market radar)
  * skill_gap.ROLE_SKILLS / ALIASES - curated skill-gap role requirements
  * data/career_paths.json         - career-path archetype titles + core skills

``resolve(query)`` maps free text ("Senior MERN stack engineer", "ML intern", "SDE-1") to the nearest known role:
  1. alias / whole-word match (deterministic, same rules as market_intel.resolve_role),
  2. otherwise nearest role NAME by embedding similarity (>= SEMANTIC_ROLE_THRESHOLD),
  3. otherwise ``None`` - the caller must then ask the user for a JD or let the LLM propose requirements.
It never guesses a role below the threshold.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from app.config import get_settings
from app.services import market_intel, skill_text
from app.services.embeddings import get_engine

_DATA = Path(__file__).resolve().parent.parent.parent / "data"


def _load_archetypes() -> list[dict]:
    try:
        with open(_DATA / "career_paths.json", "r", encoding="utf-8") as f:
            return json.load(f).get("archetypes", [])
    except (OSError, ValueError):
        return []


def _build() -> dict[str, dict]:
    cat: dict[str, dict] = {}

    def entry(name: str) -> dict:
        key = re.sub(r"\s+", " ", name.strip().lower())
        if key not in cat:
            cat[key] = {"name": name.strip(), "aliases": set(), "skills": {}, "sources": set()}
        return cat[key]

    def add_skill(e: dict, label: str, weight: float):
        k = skill_text.canonical(label)
        if k and (k not in e["skills"] or weight > e["skills"][k][1]):
            e["skills"][k] = (label, weight)

    for role, info in market_intel._ROLES.items():           # noqa: SLF001 - same package, curated data
        e = entry(role)
        e["sources"].add("market")
        e["aliases"].update(info.get("aliases", []))
        for s in info.get("skills", []):
            add_skill(e, s["skill"], float(s.get("demand", 50)) / 100.0)

    from app.services import skill_gap                        # local import: skill_gap imports this module
    for role, skills in skill_gap.ROLE_SKILLS.items():
        e = entry(role.title() if role.islower() else role)
        e["sources"].add("skill-gap")
        for i, s in enumerate(skills):
            add_skill(e, s, 0.85 - 0.02 * i)
    for alias, canon in skill_gap.ALIASES.items():
        e = entry(canon)
        e["aliases"].add(alias)

    for a in _load_archetypes():
        e = entry(a["title"])
        e["sources"].add("career-path")
        e["aliases"].add(a.get("id", "").replace("-", " "))
        for i, s in enumerate(a.get("core_skills", [])):
            add_skill(e, s, 0.8 - 0.02 * i)
    return cat


_CATALOG: Optional[dict[str, dict]] = None


def catalog() -> dict[str, dict]:
    global _CATALOG
    if _CATALOG is None:
        _CATALOG = _build()
    return _CATALOG


def roles() -> list[str]:
    return sorted(e["name"] for e in catalog().values())


def _names() -> list[tuple[str, str]]:
    """(text to embed, canonical role name) for every role name and alias."""
    out = []
    for e in catalog().values():
        out.append((e["name"], e["name"]))
        for a in e["aliases"]:
            if a and len(a.strip()) >= 2:
                out.append((a.strip(), e["name"]))
    return out


def _clean_query(q: str) -> str:
    q = re.sub(r"\b(senior|junior|jr\.?|sr\.?|lead|principal|staff|intern(ship)?|trainee|fresher|entry[- ]level|associate|i{1,3}|[1-3])\b", " ", q, flags=re.I)
    return re.sub(r"\s+", " ", q).strip(" -/,")


def resolve(query: str) -> dict:
    """{role, method: alias|semantic|none, similarity, matched_name}. Raises EmbeddingUnavailable only when the
    deterministic alias match fails AND the semantic model is unavailable."""
    q = re.sub(r"\s+", " ", (query or "").strip())
    if not q:
        return {"role": None, "method": "none", "similarity": 0.0, "matched_name": None}
    cat = catalog()
    low = q.lower()
    for e in cat.values():
        if low == e["name"].lower() or low in {a.lower() for a in e["aliases"]}:
            return {"role": e["name"], "method": "alias", "similarity": 1.0, "matched_name": e["name"]}
    via_market = market_intel.resolve_role(q)
    if via_market and via_market.lower() in cat:
        return {"role": cat[via_market.lower()]["name"], "method": "alias", "similarity": 1.0, "matched_name": via_market}

    engine = get_engine().ensure_ready()
    names = _names()
    texts = [t for t, _ in names]
    probe = _clean_query(q) or q
    vecs = engine.encode([probe] + texts)
    sims = vecs[1:] @ vecs[0]
    i = int(sims.argmax())
    best = float(sims[i])
    threshold = get_settings().SEMANTIC_ROLE_THRESHOLD
    if best >= threshold:
        return {"role": names[i][1], "method": "semantic", "similarity": round(best, 3), "matched_name": names[i][0]}
    return {"role": None, "method": "none", "similarity": round(best, 3), "matched_name": names[i][0]}


def requirements(role: Optional[str], limit: int = 14) -> list[dict]:
    """[{skill, weight}] for a catalogue role, most important first."""
    if not role:
        return []
    e = catalog().get(re.sub(r"\s+", " ", role.strip().lower()))
    if not e:
        return []
    rows = sorted(e["skills"].values(), key=lambda t: -t[1])[:limit]
    return [{"skill": label, "weight": round(w, 2)} for label, w in rows]
