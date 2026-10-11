#!/usr/bin/env python
"""End-to-end proof that matching is REAL semantic matching (not the lexical fallback).

    python scripts/verify_semantic.py

Checks, with the real transformer model:
  1. the engine is a sentence-transformer, not 'lexical-hash'/'injected', and not in fallback mode;
  2. paraphrases with ZERO shared words score far above unrelated pairs (impossible for a bag-of-words model);
  3. the skill matcher credits a requirement from a resume SENTENCE that never names the skill;
  4. role resolution maps free text to the right role by meaning.
Exit 0 = all passed. Prints each score so you can calibrate SEMANTIC_*_THRESHOLD in .env if needed.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["ALLOW_LEXICAL_FALLBACK"] = "false"

from app.services import matcher, role_catalog           # noqa: E402
from app.services.embeddings import EmbeddingUnavailable, get_engine  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail else ""))
    if not ok:
        failures.append(name)


def main() -> int:
    try:
        eng = get_engine().ensure_ready(timeout=1800)
    except EmbeddingUnavailable as exc:
        print(f"FAIL  engine: {exc}")
        return 1
    st = eng.status()
    check("engine is a transformer model", st["engine"] == "sentence-transformers" and st["semantic"] and not st["fallback_mode"],
          f"{st['engine']} | {st['model']} | {st['device']} | dim {st['dimension']}")
    check("model self-test passed", bool(st["self_test"] and st["self_test"]["passed"]), str(st["self_test"]))

    pairs = [
        ("automobile mechanic", "car repair technician", True),
        ("deployed containers to the cloud", "Docker and AWS experience", True),
        ("machine learning engineer", "grandmother's apple pie recipe", False),
    ]
    sims = {}
    for a, b, related in pairs:
        sims[(a, b)] = float(eng.encode([a])[0] @ eng.encode([b])[0])
        print(f"      sim({a!r}, {b!r}) = {sims[(a, b)]:.3f}")
    check("zero-overlap paraphrases beat unrelated text",
          sims[pairs[0][:2]] > sims[pairs[2][:2]] + 0.2 and sims[pairs[1][:2]] > sims[pairs[2][:2]] + 0.2)

    resume = ("Skills: Python, SQL\n- Containerised the payment service and shipped it to AWS ECS using GitHub Actions.\n"
              "- Built REST endpoints with Flask and wrote unit tests with pytest.")
    out = matcher.match_requirements(["Docker", "CI/CD", "Kubernetes", "Watercolor painting"], ["python", "sql"], resume)
    by = {r["skill"]: r for r in out["results"]}
    for k, r in by.items():
        print(f"      {k:<20} {r['status']:<8} {r['match_type']:<10} sim={r['similarity']}  passage={r['passage']!r}")
    check("Docker credited from a sentence that never says 'Docker'", by["Docker"]["status"] in ("matched", "partial") and by["Docker"]["passage"])
    check("CI/CD credited from 'GitHub Actions'", by["CI/CD"]["status"] in ("matched", "partial"))
    check("unrelated skill stays missing", by["Watercolor painting"]["status"] == "missing")

    for q, expect in [("Senior MERN stack engineer", ("full stack", "frontend", "backend", "software")),
                      ("ML intern", ("ml", "machine learning", "data scientist")),
                      ("SDE-1", ("software",))]:
        got = role_catalog.resolve(q)
        print(f"      role {q!r} -> {got}")
        check(f"role '{q}' resolved", bool(got["role"]) and any(e in got["role"].lower() for e in expect))

    print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
