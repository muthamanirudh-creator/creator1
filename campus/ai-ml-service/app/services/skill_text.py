"""
Text helpers for semantic skill matching: canonical skill names, label variants, resume passages and
candidate-skill extraction. Pure Python (no model) so it is cheap, deterministic and unit-testable.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

# Short tech labels embed poorly on their own ("js", "k8s", "ml"). Canonicalising common abbreviations first
# lets exact-equivalence be decided deterministically and gives the encoder a full word to work with.
ALIASES = {
    "js": "javascript", "ecmascript": "javascript", "ts": "typescript", "py": "python", "python3": "python",
    "reactjs": "react", "react.js": "react", "react js": "react", "nodejs": "node.js", "node": "node.js",
    "node js": "node.js", "expressjs": "express", "express.js": "express", "vuejs": "vue", "vue.js": "vue",
    "angularjs": "angular", "nextjs": "next.js", "k8s": "kubernetes", "kube": "kubernetes",
    "ml": "machine learning", "dl": "deep learning", "ai": "artificial intelligence", "cv": "computer vision",
    "nlp": "natural language processing", "llms": "llm", "gen ai": "generative ai", "genai": "generative ai",
    "postgres": "postgresql", "psql": "postgresql", "mongo": "mongodb", "mssql": "sql server",
    "sklearn": "scikit-learn", "scikit learn": "scikit-learn", "tf": "tensorflow", "torch": "pytorch",
    "gh actions": "github actions", "ci cd": "ci/cd", "cicd": "ci/cd", "rest": "rest apis",
    "rest api": "rest apis", "restful apis": "rest apis", "restful api": "rest apis", "api": "rest apis",
    "oops": "oop", "object oriented programming": "oop", "dsa": "data structures and algorithms",
    "data structures & algorithms": "data structures and algorithms", "data structures": "data structures and algorithms",
    "algorithms": "data structures and algorithms", "ms excel": "excel", "microsoft excel": "excel",
    "powerbi": "power bi", "ux": "user experience", "ui": "user interface", "aws cloud": "aws",
    "amazon web services": "aws", "google cloud": "gcp", "google cloud platform": "gcp", "gha": "github actions",
    "tailwindcss": "tailwind", "tailwind css": "tailwind", "html5": "html", "css3": "css", "golang": "go",
    "c plus plus": "c++", "cpp": "c++", "csharp": "c#", "dotnet": ".net", "springboot": "spring boot",
}

_WS = re.compile(r"\s+")
_PAREN = re.compile(r"\(([^)]*)\)")
_SPLIT_VARIANTS = re.compile(r"\s*(?:/|&|,|;|\band\b|\bor\b)\s*", re.I)
_BULLET = re.compile(r"^\s*(?:[-*\u2022\u25cf\u25aa\u25e6\u2023>]|\d+[.)])\s*")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")
_SECTION_SKILLS = re.compile(
    r"^\s*(?:technical\s+|key\s+|core\s+)?(?:skills?|technologies|tech\s*stack|tools(?:\s*(?:&|and)\s*technologies)?|"
    r"competenc(?:y|ies)|expertise)\b[\s:\-\u2013]*(.*)$", re.I)
_OTHER_HEADER = re.compile(
    r"^\s*(?:education|experience|work\s+experience|projects?|certifications?|achievements?|publications?|"
    r"internships?|summary|objective|profile|awards?|languages|interests|references|extracurricular\w*)\b\s*:?\s*$", re.I)


def clean(text: Optional[str]) -> str:
    return _WS.sub(" ", str(text or "")).strip()


def canonical(skill: Optional[str]) -> str:
    """Lower-case, punctuation-light, alias-resolved form used for exact-equivalence checks."""
    s = clean(skill).lower().strip(" .,:;-\u2022*")
    if not s:
        return ""
    s = s.replace("\u2013", "-")
    return ALIASES.get(s, ALIASES.get(re.sub(r"[^a-z0-9+#.\s/&-]", "", s), s))


def display(skill: Optional[str]) -> str:
    return clean(skill)[:100]


def variants(label: Optional[str]) -> list[str]:
    """Alternatives a requirement label stands for. 'Pandas/NumPy' -> ['Pandas/NumPy', 'Pandas', 'NumPy'];
    'Monitoring (Prometheus/Grafana)' -> [..., 'Monitoring', 'Prometheus', 'Grafana']. The requirement counts as
    met if ANY variant is evidenced. The whole label is always first."""
    raw = clean(label)
    if not raw:
        return []
    out = [raw]
    inner = _PAREN.findall(raw)
    outer = _PAREN.sub(" ", raw)
    pieces = [outer] + inner
    for piece in pieces:
        for part in _SPLIT_VARIANTS.split(piece):
            part = clean(part)
            if part and part.lower() not in {o.lower() for o in out} and len(part) >= 2:
                out.append(part)
    return out[:6]


def word_in_text(skill: str, text: str) -> Optional[re.Match]:
    """Whole-token containment (so 'java' is not found in 'javascript', 'go' not in 'good', 'c' not in 'ice')."""
    s = canonical(skill)
    if not s or not text:
        return None
    forms = {s, clean(skill).lower()}
    for alias, canon in ALIASES.items():
        if canon == s:
            forms.add(alias)
    for form in sorted(forms, key=len, reverse=True):
        if len(form) < 2 and form not in {"c", "r"}:
            continue
        body = re.escape(form).replace(r"\ ", r"[\s\-]+")
        flags = 0 if form in {"c", "r"} else re.I
        if form in {"c", "r"}:
            body = form.upper()
        m = re.search(r"(?<![A-Za-z0-9+#.])" + body + r"(?![A-Za-z0-9+#]|\.[A-Za-z0-9])", text, flags)
        if m:
            return m
    return None


def split_passages(text: Optional[str], *, max_passages: int = 160, min_words: int = 3, max_words: int = 55) -> list[str]:
    """Split a resume / job description into sentence-sized passages (bullets, lines, sentences). Long lines are
    windowed so no passage exceeds the encoder's useful length. Order preserved, duplicates removed."""
    passages: list[str] = []
    seen: set[str] = set()
    for raw_line in str(text or "").replace("\r", "\n").split("\n"):
        line = _BULLET.sub("", raw_line).strip()
        if not line:
            continue
        for sentence in _SENTENCE_END.split(line):
            sentence = clean(sentence)
            words = sentence.split()
            if len(words) < min_words:
                continue
            chunks = [sentence] if len(words) <= max_words else [
                " ".join(words[i:i + max_words]) for i in range(0, len(words), max_words - 10)]
            for chunk in chunks:
                key = chunk.lower()
                if key not in seen and len(chunk.split()) >= min_words:
                    seen.add(key)
                    passages.append(chunk[:600])
                    if len(passages) >= max_passages:
                        return passages
    return passages


def candidate_skills(resume_text: Optional[str], known: Optional[Iterable[str]] = None, *, limit: int = 120) -> list[str]:
    """Skill-like labels from a resume: the caller's known skills + the comma/pipe separated items inside a
    'Skills' style section. This catches tools outside any fixed vocabulary (they are then compared by meaning)."""
    out: list[str] = []
    seen: set[str] = set()

    def add(label: str):
        label = clean(label).strip(" .,:;-\u2022*|")
        key = canonical(label)
        if label and key and key not in seen and 2 <= len(label) <= 40 and len(label.split()) <= 4:
            seen.add(key)
            out.append(label)

    for k in known or []:
        add(str(k))
    in_section = False
    for raw in str(resume_text or "").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if not line:
            in_section = in_section  # blank lines do not end a skills block (resumes put them between groups)
            continue
        m = _SECTION_SKILLS.match(line)
        if m:
            in_section = True
            rest = m.group(1)
            if rest and ":" not in rest[:0]:
                for item in re.split(r"[,;|\u2022/]", rest):
                    add(item)
            continue
        if _OTHER_HEADER.match(line):
            in_section = False
            continue
        if in_section:
            body = line.split(":", 1)[1] if ":" in line[:32] else line
            for item in re.split(r"[,;|\u2022]", _BULLET.sub("", body)):
                add(item)
        if len(out) >= limit:
            break
    return out[:limit]


def evidence_query(skill: str) -> str:
    """Natural-language probe used against resume sentences ('Experience with Docker')."""
    return f"Experience with {clean(skill)}"
