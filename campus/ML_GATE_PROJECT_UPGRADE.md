# ML / Resume / Gate QR / Project Reviewer Upgrade

## Fixed
- AI/ML requests now use bounded client-side timeouts, retries, and service warming instead of hanging until a generic request-timeout error.
- Render builds the FastAPI AI/ML environment before deployment, so the first student request no longer triggers the Python package installation path.
- Roadmap Generator always returns a complete deterministic roadmap if live AI/ML is waking or temporarily unavailable; a successful AI response still replaces it.
- Find My Career Path always returns a local skill-overlap result during an ML cold start, while live AI enrichment remains available when the service is healthy.
- Resume semantic matching and resume AI analysis now retain deterministic compatibility fallbacks instead of leaving the Resume tabs empty.
- Resume ATS optimizer and the standalone gap-closing roadmap also retain usable evidence-based fallbacks.
- Added `/api/ai-status` so the portal does not falsely advertise a live AI panel when no server-side provider key is configured.
- Gate QR verification now has a dedicated standalone verifier plus aliases. Old root `?verifyGatePass=` QR links are routed to the same verifier, avoiding the full SPA loading path.
- Successful QR scans explicitly show that the pass was valid at scan time, the gate decision was recorded, and the one-time QR is now consumed/expired. Expired and already-used passes remain distinct outcomes.
- Project Reviewer AI audits now include uploaded README/evidence-package text in the AI context, while preserving the student's editable profile and deterministic evidence guardrails.
- Project Reviewer displays the number of uploaded evidence items used for the audit.
- Review purpose remains active: B.Tech year, college/national/international hackathon, general submission, and custom requirements continue to change the review expectations.

## Regression coverage
- Gate-pass route ordering and CSP verifier tests pass.
- Project-review AI-audit/purpose/ZIP-import regression tests pass.
- Frontend, project-review, analysis, and Render deployment regression tests pass.
- Node and Python syntax/compile checks pass.
