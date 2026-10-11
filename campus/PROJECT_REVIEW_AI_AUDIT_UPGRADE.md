# Project Reviewer — AI Evidence Audit & Purpose-Aware Review Upgrade

## AI Evidence Audit
- **Run AI evidence audit** is now the live AI path.
- It calls the existing same-origin secure `/api/ai` gateway and retains server-side provider fallback (Groq → Gemini when configured).
- The audit retries once after a transient failure.
- A failed AI request is no longer silently converted into the primary offline result.
- The UI reports `AI RUNNING`, `LIVE AI`, or `AI UNAVAILABLE` accurately.
- The deterministic evidence engine remains available explicitly through **Use offline evidence audit**.

## Review purpose
The reviewer now accepts a purpose that changes the AI review criteria and generated questions:
- B.Tech 1st Year
- B.Tech 2nd Year
- B.Tech 3rd Year
- B.Tech 4th Year / Major Project
- College / Internal Hackathon
- National Hackathon
- International Hackathon
- General Project Submission
- Custom Review Requirement

The optional custom requirement accepts an official rubric, department rules, hackathon criteria, or submission instructions. The selected purpose and custom requirement are included in the AI system/user context.

## Evidence discipline
AI scores remain calibrated against deterministic evidence signals. The reviewer does not invent missing evidence. Evidence percentages remain explainable separately from the AI interpretation.

## QR
The existing atomic one-time redemption and expiry behavior is preserved. A successfully consumed QR is immediately displayed as `QR EXPIRED — ALREADY SCANNED`, and reuse remains rejected server-side.
