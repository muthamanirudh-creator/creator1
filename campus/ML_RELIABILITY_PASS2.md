# ML / RAG reliability - Pass 2

Goal: every AI/ML feature (Semantic Match, Live Semantic Match, Ask Career Fit/RAG, Skill Gap, Roadmap, Career Path,
Resume ATS, Market Radar) works without error banners, and no screen announces a "fallback".

## Root causes
1. Deadlines shorter than a free-tier cold start: gateway waited 9 s / 25 s, then answered from the keyword engine;
   the root proxy (`server.js`) cut campus requests at 60 s; the browser wrapper (`advanced-v23.js`) reused one aborted
   AbortController for its retries and capped /api/ai-ml at 75 s; `aimlFetch` capped at 58 s.
2. "Ask Career Fit" was disabled until a status poll succeeded, so a slow first poll left it on
   "Waiting for the semantic engine..." although the gateway would have answered the question itself.
3. Banners/labels exposed internals: "temporarily unavailable (Request timeout)", "Keyword fallback active - not semantic",
   "Vector backend: local keyword matcher / Embedding engine: deterministic-fallback", "Exact-name estimate (not semantic)".
4. The red `"error": null` line in the Render build log is just the log viewer highlighting the word "error"; the model
   loaded fine (`ready: true`, `semantic: true`, self-test passed). The build script no longer prints null fields.

## Changes (nothing removed)
- `backend/server.js`: on long-running hosts the gateway waits up to 100 s total (70 s for a waking service, 85 s upstream);
  serverless (Vercel) keeps the 55 s ceiling. Env: AI_ML_PROXY_TIMEOUT_MS, AI_ML_FAST_WAKE_MS, AI_ML_FALLBACKABLE_TIMEOUT_MS.
- `server.js` (root): campus proxy timeout 60 s -> 125 s.
- `frontend/advanced-v23.js`: /api/ai-ml 130 s, /api/ai 90 s, status 45 s; a fresh AbortController per retry.
- `frontend/app-runtime.js`: `aimlFetch` 125 s x 3 attempts; Ask is never blocked on the status poll; Live Semantic Match
  quietly retries (6 x 6 s) while the engine wakes; the badge reads "AI/ML engine starting..." -> "AI/ML engine ready";
  all fallback/timeout wording removed (`aimlQuiet` only surfaces an expired session). Local results are still produced
  if the service truly cannot answer, but are shown as ordinary results.
- `campus/render.yaml`, `backend/.env.example`: new timeout values. `scripts/download_models.py`: quieter log.
- Tests updated to the new wording; ATS component fingerprint re-baselined.

## Still worth doing on Render free tier
The free instance sleeps after ~15 min idle. Point a free uptime pinger (e.g. UptimeRobot, every 5 min) at
`https://<ai-ml-service>.onrender.com/health` so the first student request never pays the cold start.

## GovCareer AI tab removed (pass 2b)
The third sub-tab of "Roadmaps & Govt Jobs" is gone: its button, entry-card shortcut, workspace-bar action, panel
(`GovCareerAiPanel`), unread badge/deep-link handling and `frontend/govcareer-live.js`. "1000+ Roadmaps" and "1000+ Govt Jobs"
are unchanged. A saved sector of `govcareer` in a student's browser opens Govt Jobs instead. The standalone GovCareer app
at `/?standalone=1` and its API are untouched; its root URL now redirects to `/campus/`.

## Verification notes (pass 2c)
- Service logic (role-fit, resume-JD, explain, skill-gap, career path, RAG) was executed against the project's deterministic
  embedding test double, and the Node-side engine against every Career Fit route; all returned the response shapes the UI reads.
  The real transformer model could not be downloaded in the authoring sandbox, so run `python scripts/verify_semantic.py`
  once on your own deployment.
- `embeddings.py`: a failed model load is retried after a 30 s cool-down instead of staying failed until restart.
- `Dockerfile` (ai-ml-service): single-thread BLAS + `MALLOC_ARENA_MAX=2` to keep memory low on small hosts.
- Live Semantic Match re-runs automatically when the transformer engine comes online after a warm-up.
- Memory: torch + MiniLM + spaCy need roughly 1 GB. A 512 MB free instance can be OOM-killed; if the AI/ML service restarts in a loop,
  use a plan with >= 1-2 GB (or set ALLOW_LEXICAL_FALLBACK=true on that host).
