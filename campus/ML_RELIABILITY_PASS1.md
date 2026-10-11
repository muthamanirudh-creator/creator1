# ML / RAG reliability - Pass 1

## Root cause of "Live AI/ML semantic matching is temporarily unavailable (Request timeout)"
`frontend/advanced-v23.js` wraps `window.fetch` and aborted EVERY `/api/` request after 20 s with `DOMException('Request timeout')`.
The AI/ML gateway (`/api/ai-ml/*`) legitimately waits up to ~55 s for a sleeping Render service, so on every cold start Semantic
Match, Ask Career Fit (RAG), Skill Gap, Live Match and "Connecting to the AI/ML gateway..." died at 20 s even though the
service log showed `ready: true`.

## Fixes
1. **advanced-v23.js** - per-route deadlines (`/api/ai-ml/` 75 s, `/api/ai` 70 s, `/api/voice` 70 s, streams none).
2. **Node keyword engine** (`backend/src/services/mlLexicalEngine.js`) answers, with the exact FastAPI response shapes:
   `GET /match/engine`, `POST /match/role-fit`, `/match/resume-jd`, `/match/resume-jd/explain`, `GET /rag/status`,
   `POST /rag/query`, `/rag/retrieve`, `GET /rag/hybrid/status`. Always labelled `fallback_mode: true`, `semantic: false`,
   `served_by: "node-fallback"`. RAG uses BM25 over resume + knowledge base, extractive answers with [n] citations, or a
   Groq/Gemini answer that is accepted only if it cites real sources; it abstains when evidence is weak.
3. **Gateway** (`server.js`) - for these routes it waits at most `AI_ML_FAST_WAKE_MS` (9 s) for a sleeping service and
   caps the upstream call at `AI_ML_FALLBACKABLE_TIMEOUT_MS` (25 s), then serves the fallback while the service keeps waking.
4. **Keep-alive** - the backend pings the remote service every `AI_ML_KEEPALIVE_MINUTES` (9) so it stops sleeping.
5. **UI** - the engine badge shows an amber "Keyword fallback active - not semantic" state (RAG box and Ask button stay
   usable) and re-checks every 12 s, flipping to the green semantic badge by itself when the service is up.
6. Data for the fallback is exported from ai-ml-service into `backend/src/services/data/ml_fallback_data.json`.

Tests: `node tests/mlLexicalEngine.test.js` (added to `npm test`).
