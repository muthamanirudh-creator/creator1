# GovCareer AI — World-Class Real-Time Government Career Intelligence

> v2.8.7 (merged): v2.8.2 automatic live monitoring + GovCareer AI sub-tab, with v2.8.6 RAG / semantic Career Fit and the new gate-pass letter / QR expiry / scanner fix. See `RELEASE_NOTES.md`.
> v2.8.2 (merged): GovCareer AI is a sub-tab of the Campus Portal (Roadmaps & Govt Jobs > GovCareer AI) and the Career Fit tab keeps the transformer-embedding Live Semantic Match and the **Ask Career Fit (RAG)** card. See `RELEASE_NOTES.md` (top entry), `campus/SEMANTIC_CAREER_FIT.md` and `campus/RAG_CAREER_FIT.md`. The AI/ML service needs ~2 GB RAM; install with `pip install -r campus/ai-ml-service/requirements.txt` then `python campus/ai-ml-service/scripts/download_models.py`.
> v2.7.0: see `UPGRADE_REPORT_v2_7_0.md` for what changed, what was verified, and what remains.

## Fastest guaranteed demo runtime
This release includes a **zero-dependency standalone runtime**. It requires only Node.js 18+ and does not require PostgreSQL, npm install, API keys, or an internet connection for the core intelligence features.

```bash
node standalone.js
```
Open `http://localhost:3000`.

The standalone runtime provides the public opportunity radar, profile qualification catalog, eligibility engine, grounded assistant, audit trail, exam lab, syllabus explorer, career graph, career paths, mock-test catalog, privacy information and PWA shell.

## Production runtime
For persistence, authenticated accounts, ingestion, document processing, review workflows and PostgreSQL-backed data, use:

```bash
npm ci
npm start
```

Then configure `.env` using `.env.example`.

## Data integrity
Demo records are explicitly marked as demo records. They are not presented as live government vacancies. Production publication requires the verified ingestion/review pipeline.
# GovCareer AI — Consolidated Phases 1–6

This package contains the consolidated Phase 1–6 implementation. Each later phase extends the earlier verified functionality; no phase is intended to replace the previous data-grounding, audit, account, alert or study capabilities.

## Phase 4 capabilities
- Citizen registration/login with consent version + consent event history.
- Account export and deletion/consent withdrawal endpoints.
- Recruitment watchlists and saved validated searches.
- Queue-driven alert processing with a database uniqueness constraint for deduplication.
- Deadline-change alerts and new-search-match alerts.
- In-app, email and push notification delivery records. Provider adapters are intentionally side-effect-free until SMTP/push credentials are configured.
- Application tracker with statuses and notes.
- Private ICS calendar subscription token.
- State-level published-job aggregation API.
- Existing Phase 3 grounded assistant, audit trail, source-page viewer, knowledge graph and validated LLM search remain intact.

## Start
```bash
cp .env.example .env  # if present; otherwise configure DATABASE_URL
npm install
npm run migrate
npm start
```

Run the queue worker separately:
```bash
npm run worker
```

## Phase 4 API highlights
- `POST /api/account/register`
- `POST /api/account/login`
- `GET /api/account/export`
- `DELETE /api/account`
- `POST /api/account/consent/withdraw`
- `GET/POST/DELETE /api/account/watchlist...`
- `GET/POST/PATCH/DELETE /api/account/searches...`
- `GET /api/account/alerts`
- `GET/PUT /api/account/applications...`
- `POST /api/account/calendar/token`
- `GET /api/calendar/:token.ics`
- `GET /api/map/states`

## Security notes
- Citizen passwords use the existing scrypt password-hashing implementation.
- Citizen login attempts are throttled per IP/email key; production deployments should also place a shared rate limiter at the edge for multi-instance enforcement.
- Sessions use opaque random bearer tokens stored only as SHA-256 hashes.
- Account exports exclude password hashes and session tokens.
- Deletion is implemented as a database cascade from `citizen_accounts` and is separately auditable before deletion through the existing append-only audit mechanism.
- Do not put SMTP, Firebase/APNs, or other production credentials in source control.


## Phase 6 — upload, languages and operations

- Private user document upload with MIME allowlisting, magic-byte type validation and **confirm-before-use** state. A production deployment should additionally run uploaded files through an external malware scanner before confirmation. Uploaded documents remain isolated from eligibility until explicitly confirmed.
- Account export includes user documents' metadata, preferences and privacy events; account deletion cascades through private data.
- Eleven supported Indian UI languages: English, Hindi, Bengali, Telugu, Marathi, Tamil, Gujarati, Kannada, Malayalam, Punjabi and Odia. Dates, age and vacancy values remain structured data; localization supplies labels rather than letting the model rewrite facts.
- Browser voice support is opt-in and uses the device speech synthesis API by default; audio is not retained by this app by default.
- Privacy/operations endpoints, request/error/latency metrics and data-lineage API.
- Extraction smoke benchmark runs against the real sample notifications in `samples/`.
- WCAG-oriented static audit and a configurable HTTP load-test script are included.

### Phase 6 validation

- Phase 6 contract tests: 10/10 passed.
- WCAG static audit: passed for the shipped HTML pages.
- Extraction pipeline smoke benchmark: 3/3 sample PDFs processed, 13 pages recovered.
- Full PostgreSQL integration tests were not executed in this build environment because the `pg` package could not be installed before the package-manager timeout; run `npm ci` and `npm test` in the deployment environment.

## Consolidated Phase 5 — exams and study

- Versioned exam records and recruitment-year-specific syllabus versions.
- Hierarchical syllabus tree with source page/reference metadata.
- Per-user syllabus progress and study plans generated from the selected verified version.
- Mock tests and persisted attempts; AI-generated questions can be represented with explicit question metadata.
- Career-path records.
- Tutor endpoint pinned to a verified exam version and returns syllabus citations; it does not silently substitute another year's syllabus.

### Phase 5 API highlights
- `GET /api/exams`
- `GET /api/exams/:versionId/syllabus`
- `GET /api/account/syllabus-progress/:versionId`
- `PUT /api/account/syllabus-progress/:nodeId`
- `GET/POST /api/account/study-plans`
- `GET /api/mock-tests/:versionId`
- `POST /api/mock-tests/:id/attempts`
- `GET /api/career-paths`
- `POST /api/assistant/tutor`

## Consolidated build validation

- All shipped JavaScript files pass `node --check`.
- Phase 5 dependency-free contract suite: 9/9 passed.
- Full PostgreSQL integration remains environment-dependent; run `npm ci`, `npm run migrate`, then `npm test` against a test PostgreSQL database before production deployment.

## Phase 3 (hardened) — grounded assistant

- `lib/claims.js`: typed claims with **exact** matching on rendered forms. The earlier substring matcher accepted figures like "9" or "20" because they appeared inside other values; that is fixed. Fuzzed with 52,800 random numbers/dates: 0 false positives.
- `lib/answer.js`: answers are built from **field-bound segments**; each figure is re-verified against the exact field it claims to state, and page/section/document citations are checked against recorded sources. A failed audit returns HTTP 409 and the answer is never shown.
- `lib/intent.js`: deterministic intent router + at most one clarifying question (recruitment, topic or missing profile detail).
- Seven modes. `OFFICIAL_ONLY` answers only what was asked and says "The official source does not specify this." when the record is silent.
- `lib/answerAudit.js` + migration `006`: per-answer hash-chained audit trail (intent, segments, page-level sources, verification); `GET /api/assistant/audit/verify` checks the chain.
- `lib/knowledgeGraph.js`: fixed an edge/node id mismatch; adds multi-hop constraint queries and shortest path (`POST /api/assistant/graph`).
- LLM search: provider is injectable; hostile model output is stripped to the validated filter schema and runs through the same `runSearch`.
- `node test-phase3.js`: 108 checks (50 distinct end-to-end questions + adversarial tamper tests), no DB or network needed.

### Not yet verified
`node_modules` in the supplied zip was empty and this build environment has no PostgreSQL, so `server.js`, the SQL migrations and the pg audit store were syntax-checked only. Run `npm ci && npm run migrate && npm test` against a real database.

## Phase 4 alert-engine hardening (v0.8.0)

Found by reading the code (the earlier Phase 4/5/6 "contract tests" only grep source for route and table names, so they could not catch behavior bugs). Fixed:

- Alerts no longer fire for changes without page+quote evidence (`supported = false`) or for versions still awaiting review.
- A user is only alerted about changes detected **after** they started watching; new saved searches no longer flood with pre-existing jobs.
- Withdrawn-consent accounts receive nothing, including already-queued deliveries (they become `SKIPPED`).
- Several date changes in one version produce **one** alert listing all of them (previously only the first field was reported).
- Alert row + delivery rows are created in one transaction.
- Deliveries are never reported `SENT` unless a provider returned a message id. With no EMAIL/PUSH provider configured they are `SKIPPED` (previously a fake `dev-…` id and `SENT`). IN_APP counts as sent because the alert row is the in-app notification.
- Atomic `FOR UPDATE SKIP LOCKED` claim (no double sends across workers), exponential-backoff retries, stuck-lease recovery. Providers are injected: `workerTick({ providers: { EMAIL: async ({to,payload,idempotencyKey}) => ({id}) } })`.
- `POST /api/alerts/run` now requires the ADMIN role (it was public).
- Migration `007_alert_delivery.sql` adds `SENDING`/`SKIPPED` statuses, `next_attempt_at`, `locked_at`, and relabels legacy fake-`SENT` rows.

`node test-phase4-behavior.js`: 27 behavioral tests; each safety rule was mutation-checked (disabling it makes a test fail).

**Still unverified:** the SQL in `lib/alerts.js` and migration 007 have not been run against PostgreSQL. The eligibility rules are enforced in code too (`alertPlanner.js`), which is what the tests exercise; the in-memory store emulates the `UNIQUE(account_id, dedupe_key)` constraint rather than using it. Run `npm ci && npm run migrate && npm test` on a real database.

## Phase 5 hardening (v0.9.0)

Same method as Phase 4: the earlier Phase 5 "contract tests" only grep for names. Reading the code found, and this release fixes:

- **Answer key leak:** `GET /api/mock-tests/:versionId` returned every question's correct answer to anyone, unauthenticated. Learners now get questions with no `answer`/`explanation`; the key appears only in the post-attempt `result.review`.
- **Unanswered counted correct:** a question with a missing answer key matched a blank submission. Unkeyed questions are now excluded from scoring; unanswered is never correct. Negative marking is read from the exam `pattern`.
- **AI-generated labelling was unenforceable.** Every question must now declare an `origin` (`PREVIOUS_YEAR`, `AI_GENERATED`, `EDITORIAL`); AI questions are labelled and flagged; previous-year questions require `source_ref` and a `legal_basis` (`OFFICIAL_PUBLIC`, `LICENSED`, `PERMISSION`); legacy questions with no origin are shown as "Origin not recorded", never as official. New admin route `POST /api/admin/mock-tests` (REVIEWER) enforces this.
- **Draft syllabi were served** (`/syllabus` returned unverified trees with `exam_version: null`). Now 404 unless VERIFIED. Mock tests and progress updates are likewise limited to verified versions.
- **Tutor was a stub** that returned a canned sentence (including prompt-like text). It now answers from the pinned version's syllabus nodes (description, parent path, subtopics, page citations; missing pages are disclosed). A topic that exists only in another year's syllabus is reported as "not in this version, appears in YYYY" and is never answered from the other year. It states plainly that it does not teach the subject. There is **no LLM explainer**; that would need a provider plus a grounding audit like Phase 3.
- **Study planner:** schedules only leaf topics (parents were counted as extra work), skips mastered topics, spreads evenly instead of front-loading, rejects impossible dates (`2026-02-31` used to roll over), plans over 366 days, and absurd daily minutes; returns warnings when time per topic is too low.
- **Progress input:** `"abc"`, `NaN`, `[]`, out-of-range values and unknown node ids returned a 500 or were silently clamped; now clear 400/404 responses.

`node test-phase5-behavior.js`: 46 tests; 12 safety rules were mutation-checked (disabling any makes a test fail).

**Still missing in Phase 5 (not built, not hidden):** no seed data and no admin screens for creating exams, syllabus versions or syllabus nodes (only mock tests have an admin route); no UI for any Phase 5 feature in `public/`; no previous-year paper ingestion; no AI question generator. SQL/routes are not executed here; run against PostgreSQL before relying on them.

## World-Class Runtime / Hackathon Mode

The public intelligence surface is deliberately resilient. PostgreSQL is the production persistence layer, but the app no longer becomes a blank/dead interface when PostgreSQL is missing: it automatically enters `RESILIENT_DEMO` mode and serves the verified local corpus, deterministic eligibility/search/assistant logic, exam lab, career graph, local application cockpit, and live official-portal monitor.

### Fast start

```bash
npm ci
npm start
```

Open `http://localhost:3000`.

### Production / IIT M.Tech deployment

```bash
docker compose up --build
```

For live AI enhancement, copy `.env.example` to `.env` and provide your own provider keys. Never commit real credentials. AI output is treated as a proposal layer; recruitment facts remain bound to verified structured records and source lineage.

### Real-time architecture

1. **Official-source monitor** checks configured government portals directly and exposes current reachability/discovered recruitment links.
2. **Allowlisted crawler** respects domain boundaries, robots rules and rate limits.
3. **Document pipeline** extracts fields with page-level lineage.
4. **Verification gate** prevents unverified facts from becoming public recruitment records.
5. **Grounded assistant** answers from the verified corpus and blocks unsupported figures.
6. **PostgreSQL** persists accounts, audits, applications, exam versions, study plans and ingestion history.
7. **Resilient runtime** keeps public features usable during database/provider outages.


## v2.10.0 national coverage and instant alerts
See NATIONAL.md.


## v2.11.0 combined release
Combines v2.9.3 (Hybrid RAG: notices, knowledge store, reranker, persistence, DB sync) with v2.10.0 (trust & evidence layer, all-India coverage, instant Web Push). Nothing removed. See RELEASE_NOTES.md, campus/HYBRID_RAG.md, TRUST.md and NATIONAL.md.
