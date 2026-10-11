# P1 — Live AI/ML Final Integration

- AI/ML provider calls use Groq/Gemini live generation with request-scoped admin keys.
- Response caching is disabled by default (`AI_DISABLE_RESPONSE_CACHE=true`) so user-facing AI/ML results are freshly generated.
- Provider timeout/retry/deadline defaults match the stable v16.1 live-AI timing (30s / 2 retries / 38s overall).
- P1-only Resume and Skill Gap endpoints remain enabled.
- Career Path keeps deterministic evidence scoring but adds live LLM rationale when configured.
- AI Video Tutor supports separate explanation and example languages plus optional two-language reinforcement.
