# Live AI/ML fix — what changed and what to check

The message "Live AI/ML enrichment is temporarily unavailable. Showing a deterministic career-path match…" appears only when
the browser's call to `/api/ai-ml/...` fails (the FastAPI service itself never errors on `/career-path/predict`, even without keys).

## Added (nothing removed)
- `backend/src/services/aiMlFallback.js` (+ `data/career_paths.json`): Node-side implementation of `/career-path/predict`,
  identical ranking/evidence to `ai-ml-service/app/services/career_path.py`, plus a live Groq/Gemini rationale when a key is set.
- `backend/server.js`: the `/api/ai-ml` gateway now tries that fallback when the FastAPI service is unreachable, asleep,
  rejects the service token (401), crashed (5xx), is busy (429) or is an older build missing the route. Response header
  `x-ai-ml-fallback: <reason>` and the server log say why; the JSON carries `served_by: "node-fallback"`.
- `frontend/app-runtime.js`: when the career-path call still fails, the banner now shows the gateway's real reason.
- `backend/tests/aiMlNodeFallback.test.js` (added to `npm test`).

## Limits (be aware)
- Only `/career-path/predict` has a Node live fallback. Roadmap, Skill-Gap, Resume and Interview tabs still use FastAPI for
  live AI and their existing deterministic fallbacks otherwise.
- Live LLM text needs a Groq or Gemini key (Admin -> Settings -> AI Keys & Services, or GROQ_API_KEY / GEMINI_API_KEY).

## To get the FastAPI service itself live — check in this order
1. Render logs: look for `[ai-ml]` lines (service exited / packages missing / did not become ready).
2. `GET /api/ai-ml-status` on your site: `available:true` and `missingRoutes: []` expected.
3. Vercel deployments cannot run Python: set `AI_ML_SERVICE_URL` (or Admin link) to your separately deployed service.
4. `AI_ML_SERVICE_TOKEN` must be identical on both sides (mismatch = 401, now logged as "upstream rejected the service token").
