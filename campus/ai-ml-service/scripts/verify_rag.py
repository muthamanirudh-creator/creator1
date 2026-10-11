"""Prove Career Fit RAG retrieval works with the REAL transformer model (prints every score; exits non-zero on failure).

    cd campus/ai-ml-service && python scripts/verify_rag.py

Use the printed similarities to tune RAG_MIN_SIMILARITY in .env if you switch embedding model.
No LLM key is needed - this checks retrieval only.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import rag  # noqa: E402
from app.services.embeddings import EmbeddingUnavailable, get_engine  # noqa: E402

RESUME = """PROJECTS
- Containerised a payment microservice with Docker and deployed it to AWS ECS using GitHub Actions pipelines.
- Built REST endpoints with Flask and wrote unit tests with pytest.
- Trained a scikit-learn classifier to predict customer churn and presented the results in a dashboard.
SKILLS
Python, SQL, Git, Linux
EDUCATION
B.Tech Computer Science, 2026"""

# (question, role, expectation) - expectation is checked against the top hit
CASES = [
    ("Do I have any cloud deployment experience?", "DevOps Engineer", lambda h: h["source"] == "resume" and "AWS" in h["text"]),
    ("Have I done any machine learning work?", "Data Scientist", lambda h: h["source"] == "resume" and "classifier" in h["text"]),
    ("What should a data analyst learn first?", "Data Analyst", lambda h: h["source"] in ("career-path", "market", "knowledge")),
    ("How do I answer behavioural interview questions?", "", lambda h: h["source"] == "knowledge"),
]
NEGATIVE = "how do I bake sourdough bread"


def main() -> int:
    try:
        eng = get_engine().ensure_ready(timeout=300)
    except EmbeddingUnavailable as exc:
        print("FAIL: embedding model unavailable:", exc)
        return 2
    st = eng.status()
    print(f"engine: {st['model']} on {st['device']} (semantic={st['semantic']}, self-test={st['self_test']})")
    print("knowledge base:", rag.KB.status())
    bad = 0
    for q, role, ok in CASES:
        r = rag.retrieve(q, resume_text=RESUME, target_role=role)
        print(f"\nQ: {q}  [role: {role or '-'}]")
        for h in r["hits"][:4]:
            print(f"   [{h['n']}] sim={h['similarity']:.3f} kw={h['keyword_score']:.2f} {h['source']:<15} {h['title'][:40]:<40} {h['text'][:70]!r}")
        if not r["hits"] or not ok(r["hits"][0]):
            print("   -> FAIL: unexpected top hit")
            bad += 1
        else:
            print("   -> ok")
    r = rag.retrieve(NEGATIVE, resume_text=RESUME)
    print(f"\nNegative control: {NEGATIVE!r} -> {len(r['hits'])} hits above the bar (min_similarity={r['info']['min_similarity']})")
    if r["hits"]:
        print("   top similarity:", r["hits"][0]["similarity"], "- raise RAG_MIN_SIMILARITY if this is unrelated text")
        bad += 1
    print("\nALL CHECKS PASSED" if not bad else f"\n{bad} CHECK(S) FAILED")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
