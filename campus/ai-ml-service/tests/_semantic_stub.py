"""
Deterministic TEST DOUBLE for the embedding model (concept-cluster vectors + a little character-trigram noise).

It exists so the matching LOGIC (thresholds, classification, evidence, request plumbing, strict-mode behaviour)
can be unit-tested with no model download and no network. It is installed through
``EmbeddingEngine.inject_encoder`` which reports the engine as ``injected`` - it can never be mistaken for the
transformer model, and production code has no path that uses it.

Real semantic quality is verified separately with the real model:  python scripts/verify_semantic.py
"""
import hashlib
import re

import numpy as np

DIM = 160
_NOISE_DIMS = 64

# concept -> {token: weight}. Tokens in the same concept are "semantically close" for the test double.
CONCEPTS = {
    "container": {"docker": 1.0, "containerised": 1.0, "containerized": 1.0, "containers": 1.0, "container": 1.0,
                  "ecs": 0.6, "kubernetes": 0.55, "k8s": 0.55, "helm": 0.4},
    "orchestration": {"kubernetes": 1.0, "k8s": 1.0, "orchestration": 1.0, "helm": 0.7},
    "cloud": {"aws": 1.0, "azure": 1.0, "gcp": 1.0, "cloud": 1.0, "ecs": 0.8, "ec2": 1.0, "s3": 0.8},
    "cicd": {"ci/cd": 1.0, "cicd": 1.0, "pipeline": 0.8, "pipelines": 0.8, "jenkins": 1.0, "actions": 0.9,
             "github": 0.4, "deployment": 0.5, "deploy": 0.5, "deployed": 0.5, "shipped": 0.4},
    "python": {"python": 1.0, "flask": 0.7, "django": 0.7, "pandas": 0.5, "pytest": 0.6, "fastapi": 0.7},
    "javascript": {"javascript": 1.0, "js": 1.0, "ecmascript": 1.0, "react": 0.6, "node.js": 0.7, "typescript": 0.7},
    "react": {"react": 1.0, "reactjs": 1.0, "react.js": 1.0, "jsx": 0.8, "components": 0.4, "frontend": 0.4},
    "sql": {"sql": 1.0, "mysql": 1.0, "postgresql": 1.0, "postgres": 1.0, "queries": 0.6, "database": 0.5},
    "ml": {"machine": 0.6, "learning": 0.6, "ml": 1.0, "model": 0.4, "models": 0.4, "tensorflow": 0.8, "pytorch": 0.8,
           "scikit-learn": 0.8, "classifier": 0.6},
    "stats": {"statistics": 1.0, "statistical": 1.0, "regression": 0.6, "hypothesis": 0.6},
    "testing": {"testing": 1.0, "tests": 0.9, "test": 0.9, "pytest": 0.6, "jest": 0.8, "unit": 0.5, "qa": 0.8},
    "api": {"api": 1.0, "apis": 1.0, "rest": 1.0, "endpoints": 0.8, "endpoint": 0.8, "restful": 1.0},
    "git": {"git": 1.0, "github": 0.7, "version": 0.4, "gitlab": 0.8},
    "linux": {"linux": 1.0, "bash": 0.7, "shell": 0.6, "ubuntu": 0.8},
    "security": {"security": 1.0, "owasp": 0.8, "pentest": 0.8, "firewall": 0.7, "siem": 0.7},
    "design": {"figma": 1.0, "wireframes": 0.8, "wireframing": 0.8, "prototype": 0.5, "ux": 0.7},
    "product": {"product": 1.0, "roadmap": 0.5, "stakeholders": 0.4, "manager": 0.5},
    "data": {"data": 0.6, "analytics": 0.8, "analysis": 0.8, "dashboard": 0.5, "excel": 0.8, "tableau": 0.8, "bi": 0.6},
    "software": {"software": 1.0, "engineer": 0.7, "developer": 0.7, "sde": 1.0, "programmer": 0.7},
    "fullstack": {"full": 0.8, "stack": 0.8, "mern": 1.0, "fullstack": 1.0, "software": 0.4},
    "baking": {"sourdough": 1.0, "bread": 1.0, "baking": 1.0, "recipe": 0.8, "pie": 0.8},
}
_CONCEPT_INDEX = {c: i for i, c in enumerate(CONCEPTS)}
_TOKEN = re.compile(r"[a-z][a-z0-9+.#/\-]*", re.I)


def _noise(token: str) -> np.ndarray:
    v = np.zeros(_NOISE_DIMS, dtype=np.float32)
    padded = f"^{token}$"
    for i in range(len(padded) - 2):
        h = int(hashlib.md5(padded[i:i + 3].encode()).hexdigest(), 16)
        v[h % _NOISE_DIMS] += 1.0
    return v


def encode(texts):
    out = np.zeros((len(texts), DIM), dtype=np.float32)
    for row, text in enumerate(texts):
        for tok in _TOKEN.findall(str(text).lower()):
            tok = tok.strip(".-/") or tok
            hit = False
            for concept, members in CONCEPTS.items():
                w = members.get(tok)
                if w:
                    out[row, _CONCEPT_INDEX[concept]] += w
                    hit = True
            parts = re.split(r"[/\-]", tok)
            if not hit and len(parts) > 1:
                for part in parts:
                    for concept, members in CONCEPTS.items():
                        w = members.get(part)
                        if w:
                            out[row, _CONCEPT_INDEX[concept]] += w * 0.8
            out[row, len(CONCEPTS):len(CONCEPTS) + _NOISE_DIMS] += 0.12 * _noise(tok)
    norms = np.linalg.norm(out, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (out / norms).astype(np.float32)


def install():
    from app.services.embeddings import get_engine
    get_engine().inject_encoder(encode, DIM, "test-double")
