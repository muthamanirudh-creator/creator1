"""Query routing. Decides the domain (which retriever settings apply) and whether RAG should be used at all:
deterministic operations (auth, profile CRUD, application tracking, deadlines countdowns, stats, exact eligibility
verdicts) must go to the existing services, not to an LLM."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

DOMAINS = {
    # domain -> (keyword regex, default filters, min_authority for factual claims)
    "government": (re.compile(r"\b(govt|government|sarkari|ssc|upsc|rrb|railway|ibps|sbi|police|defen[cs]e|psc|notification|advt|advertisement|vacanc|recruitment|corrigendum|admit card)\b", re.I), {"domain": "government"}, "official"),
    "private": (re.compile(r"\b(tcs|infosys|wipro|accenture|cognizant|capgemini|amazon|google|microsoft|campus (hiring|placement)|off[- ]campus|placement|company|hr round|ctc)\b", re.I), {"domain": "private"}, None),
    "exam": (re.compile(r"\b(syllabus|exam pattern|cutoff|cut-off|marking scheme|prelims|mains|tier|gate|cat\b|negative marking)\b", re.I), {"domain": "exam"}, None),
    "learning": (re.compile(r"\b(explain|how does|what is|difference between|practice|question bank|leetcode|dsa|algorithm|revise|revision)\b", re.I), {"domain": "learning"}, None),
    "career": (re.compile(r"\b(career|roadmap|skill gap|resume|cv|interview|role|switch)\b", re.I), {"domain": "career"}, None),
}
_DETERMINISTIC = [
    (re.compile(r"\b(my|track|update|change) (application|applications) (status|tracker)\b|\bapplication status\b", re.I), "application_tracking"),
    (re.compile(r"\b(change|reset|forgot) (my )?(password|email)\b|\b(log ?in|log ?out|sign ?up|register)\b", re.I), "authentication"),
    (re.compile(r"\bhow many days (left|remain)|\bdays? (left|remaining)\b|\bcountdown\b", re.I), "deadline_calculation"),
    (re.compile(r"\b(delete|export) my (account|data)\b|\bupdate my profile\b", re.I), "profile_management"),
    (re.compile(r"\bhow many (jobs|vacancies|users|applications)\b.*\b(total|in all|dashboard|stats)\b|\bdashboard stats\b", re.I), "statistics"),
]
# "government"/"govt" alone is a weak signal: "can I move from private prep to government exams" is career advice, not a
# recruitment-notice lookup. A recruitment route needs a specific signal (notification, vacancy, advt, a named body ...).
_GOV_GENERIC = re.compile(r"^(govt|government|sarkari)$", re.I)
_GOV_SPECIFIC = re.compile(r"\b(ssc|upsc|rrb|ibps|sbi|police|defen[cs]e|psc|railway|notification|advt|advertisement|vacanc\w*|recruitment|corrigendum|admit card)\b", re.I)
_ADVICE = re.compile(r"\b(prep|preparation|prepare|switch|move|moving|transition|shift|plan|should i|how (do|can) i|strategy|path|track|guidance)\b", re.I)
_ELIGIBILITY = re.compile(r"\b(am i eligible|do i qualify|can i apply|eligible for|my eligibility)\b", re.I)


@dataclass
class Route:
    kind: str                       # "rag" | "deterministic"
    domain: str = "career"
    deterministic_service: str = ""
    wants_eligibility: bool = False  # RAG fetches the rule text; verdict comes from the rules engine
    filters: dict = field(default_factory=dict)
    min_authority: str | None = None
    strict_facts: bool = False       # recruitment facts: official sources only, abstain otherwise


def classify(query: str, hint_domain: str | None = None) -> Route:
    q = query or ""
    for rx, svc in _DETERMINISTIC:
        if rx.search(q):
            return Route("deterministic", deterministic_service=svc)
    domain = hint_domain if hint_domain in DOMAINS else None
    if not domain:
        scores = {d: len(spec[0].findall(q)) for d, spec in DOMAINS.items()}
        best = max(scores, key=scores.get)
        domain = best if scores[best] else "career"
        if domain == "government" and not _GOV_SPECIFIC.search(q) and _ADVICE.search(q):
            domain = "career"                                    # only the generic word matched and the question asks for guidance
    _, flt, auth = DOMAINS[domain]
    return Route("rag", domain=domain, filters=dict(flt), min_authority=auth, wants_eligibility=bool(_ELIGIBILITY.search(q)),
                 strict_facts=(domain == "government"))
