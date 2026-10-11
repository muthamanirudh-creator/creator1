# GovCareer Unified v2.6.3 → v2.7.0 — upgrade report

Scope note: the master prompt describes a very large programme. This release implements a focused set of real, tested
upgrades inside existing modules, and lists everything **not** done in section 6. Nothing below is claimed beyond what was run.

## 1. Structure preservation (verified)
- Top-level navigation is unchanged: Overview, Opportunities, Exam Lab, Career Paths, Bridge, Strategy, My Tools, then the Campus AI Portal link.
- No new tabs. The Research tab is not present and was not reintroduced.
- `test-upgrade.js` now fails the build if the nav order changes, a Research item appears, an Advanced sub-tab disappears, or the Striver subtab is removed.

## 2. What changed, by existing tab
| Existing tab / area | Change |
|---|---|
| Strategy → Brief | New **Next actions** card: ranked, explained actions with evidence, urgency, confidence, caveats, and a list of missing profile fields. Backed by `POST /api/advanced/next-actions` (`lib/advanced/nextactions.js`). |
| Strategy / Opportunities (API) | Next actions never suggest vacancies the user is ineligible for, skip applications already marked applied in the supplied tracker data, mark unverified records LOW confidence, and label sample/demo records as "not a real vacancy". Missing data is reported, never assumed. |
| Exam Lab / Strategy → Mock analytics | Next actions reuse the existing Wilson-interval analytics: weak topics need ≥5 attempts; thinner topics ask for more answers instead of claiming a weakness; overdue SM-2 revisions are surfaced. |
| Campus AI Portal → Coding → Striver A2Z | Visible `</>` glyph on the existing subtab button and panel heading (decorative, `aria-hidden`; text label unchanged). Topic order and problems untouched. |
| AI gateway (`lib/llm.js`) | Providers now run behind a circuit breaker (`lib/resilience.js`): after repeated failures a provider is skipped for a cool-down, then probed once. Latency and error counts are tracked per provider. Malformed output still yields an error, never invented fields. |
| Operations metrics (`/api/operations/metrics`) | Original fields preserved; added p50/p95/p99 latency, per-route stats (ids and query strings stripped) and provider circuit state. |
| All API responses | `X-Request-Id` header (client value accepted only if it matches a safe pattern). Optional structured JSON request logs (`LOG_REQUESTS=1`) that never include bodies, headers, tokens, e-mail or query strings. 5xx always logged. |

## 3. Existing features preserved
All routes, tests and modules from v2.6.3 are untouched except the additive edits above (`lib/advanced/index.js`, `lib/llm.js`, `lib/observability.js`,
`server.js`/`standalone.js` one route line each, `public/advanced.js` one card, `campus/frontend/app-runtime.js` two glyph spans). The standalone runtime serves the new endpoint too.

## 4. Verified results (run in this environment, Node 22, local PostgreSQL 16)
| Suite | Result |
|---|---|
| test.js, phase 3 (107), phase 4 (10 + 27), phase 5 (9 + 46), phase 6 (10), bridge (58), account UI (20), realtime (5), advanced (17), advanced UI (9), UI contract (10) | all pass |
| **test-upgrade.js (new)** | **21 passed, 0 failed** |
| test-phase2.js | 44/45 — see below |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `node --check` on server, campus backend, new files | OK |
| Live HTTP check of `/api/advanced/next-actions` via the standalone runtime | 200 with expected payload |

Baseline before any change was identical (same single phase-2 failure).
**Known failing test:** `pipeline: regional-language OCR packs…` fails because the Hindi Tesseract language pack is not installed in the build sandbox. It is an environment dependency (`apt install tesseract-ocr-hin`), not a code change; it failed identically before the upgrade.

## 5. Setup
- `npm ci` (or `npm install`), copy `.env.example` to `.env`, set `DATABASE_URL`, `npm run migrate`, `npm start`. No new migrations in this release; no new required variables.
- New optional variable: `LOG_REQUESTS=1`.
- Tests needing PostgreSQL: `npm run test:db:setup`, then `npm test`. Run `npm run samples` first for phase 2.
- Still requires your credentials/infrastructure: PostgreSQL, Groq/Gemini keys, SMTP/push, the AI/ML service, and Campus JWT/bridge secrets. None were available here, so provider calls were exercised only with in-process fakes.

## 6. Not done / not verified (honest list)
The following master-prompt items were **not** implemented or were **not** re-verified in this release; the existing v2.6.3 behaviour is unchanged for them:
- Adaptive question selection, new prerequisite-aware learning paths, question-quality/duplicate checks.
- Server-side sandboxed code execution for the IDE; hidden-test feedback; complexity-analysis changes; server-persisted solution history. (The existing judge flow is unchanged and was not run here.)
- Resume/ATS/interview/viva upgrades; job-description-specific resume matching changes.
- Gate Pass QR/replay protections, library upgrades, admin dashboards: not re-audited or modified. The campus backend was syntax-checked only; its Prisma tests and the Python AI/ML service tests were not run (no Prisma engine download or Python deps in the sandbox).
- Document-checklist/file-dimension validation, retention policies, backup/restore test, database-level idempotency keys.
- End-to-end browser journeys, performance and accessibility test additions. The existing `wcag` and `load` scripts were not run.
- Request-ID/log/circuit-breaker state is in-memory per process (not shared across instances).
- Next actions use data the browser sends (profile, attempts, tracker rows); they do not yet read server-stored accounts.

## 7. Recommended next steps
1. Feed Next actions from the stored account (tracker, syllabus progress, Bridge evidence) so it works across devices.
2. Add a sandboxed runner (container/isolate with CPU, memory, time limits) before enabling any "run code" claim.
3. Install the Hindi OCR pack in CI so phase 2 is fully green.
4. Run the campus Prisma and AI/ML service suites in an environment with Prisma engines and Python deps.
