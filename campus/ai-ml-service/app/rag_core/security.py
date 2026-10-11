"""Retrieved text is untrusted DATA. This module neutralises indirect prompt injection before text reaches an LLM:
instruction-like lines are flagged and removed from the model-visible text; delimiters are escaped so a document
cannot close the SOURCES block; control characters are stripped. Detection is heuristic - the real defences are
structural (data block + system rules + no tools + citation validation), this is defence in depth."""
from __future__ import annotations

import re

_INJECTION = [
    r"ignore (all |any |the )?(previous|prior|above|earlier) (instructions?|rules?|prompts?)",
    r"disregard (all |any |the )?(previous|prior|above|system)",
    r"(forget|override|bypass) (your|the|all) (instructions?|rules?|guidelines|system prompt)",
    r"you are now (a|an|the)\b",
    r"\bsystem\s*(prompt|message)\s*:",
    r"^\s*(system|assistant|developer)\s*:",
    r"(reveal|print|show|leak) (your|the) (system prompt|instructions|api[_ ]?key|secrets?)",
    r"</?\s*(system|assistant|instructions?|sources?)\s*>",
    r"(call|invoke|run|execute) (the )?(tool|function|command|shell)",
    r"(send|forward|email|post) (this|the|all|user|their)\b.*\b(to|at) \S+@\S+",
    r"(curl|wget)\s+https?://",
    r"act as (if|though)? ?(you|the)\b.*(admin|root|developer)",
]
_INJ_RE = [re.compile(p, re.I) for p in _INJECTION]
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]")
_FENCE = re.compile(r"(<<<|>>>|```|\[\[|\]\])")


def sanitize_untrusted(text: str) -> tuple[str, list[str]]:
    """Return (model-safe text, flags). Lines that look like instructions are replaced by a marker."""
    flags: list[str] = []
    out_lines = []
    for ln in _CTRL.sub("", text or "").splitlines():
        if any(r.search(ln) for r in _INJ_RE):
            if "possible_prompt_injection" not in flags:
                flags.append("possible_prompt_injection")
            out_lines.append("[line removed: instruction-like text inside a source document]")
        else:
            out_lines.append(ln)
    clean = _FENCE.sub(" ", "\n".join(out_lines))
    return clean.strip(), flags


def looks_like_injection(text: str) -> bool:
    return any(r.search(text or "") for r in _INJ_RE)


_SECRET = re.compile(r"(?i)\b(api[_-]?key|secret|token|password|bearer)\b\s*[:=]\s*\S+")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\s-]{8,13}\d)(?!\d)")


def redact_for_log(text: str, limit: int = 0) -> str:
    """Logs never get raw queries/resumes. Returns a redacted (optionally truncated) string."""
    t = _SECRET.sub(r"\1=[redacted]", text or "")
    t = _EMAIL.sub("[email]", t)
    t = _PHONE.sub("[phone]", t)
    return t[:limit] if limit else t
