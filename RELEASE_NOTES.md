# v2.11.0 - Combined release: v2.9.3 (Hybrid RAG) + v2.10.0 (trust, national coverage, instant push)
Union of both lines; no feature from either was dropped. Where both changed the same file, the more advanced version was kept (eligibility engine, source policy, crawler, scheduler and alerts from v2.10.0; Career Fit notice check, Campus gateway identity headers and AI-service routes from v2.9.3). Scheduler runs both the v2.10.0 tasks (push, trust monitor, reconcile) and the v2.9.x Hybrid RAG sync/recover tasks.  Service worker is bumped to v21 (the merged Career Fit screen changed) (Hybrid RAG's UI lives in the Campus app and the Campus URL cache key `?v=gc-officialletter2-hrag` is kept). The Career Fit screen in `public/app.js` has both the v2.9.0 trust badges/panels and the v2.9.1 'Check against the notice text' rules check.

---

# v2.10.0 - All-India coverage, corrected Punjab domains, instant push alerts (additive)

See NATIONAL.md. Nothing removed.
- All 36 States/UTs covered (~75 new official sources); Punjab PSC `ppsc.gov.in` and PSSSB `sssb.punjab.gov.in` added; Pakistan look-alike blocked; stale Bihar domain corrected.
- Domain guard + startup reconcile that corrects wrong domains found in existing databases; unreachable portals flagged for review.
- Check tiers: 5 / 10 / 20 minutes (was 30); pending sources retried hourly; broader notice wording incl. regional languages.
- Web Push alerts by State/UT (migration 011, `lib/pushNotify.js`, service worker v20, Overview panel), Atom feed.
- Verified here: new `test-national.js` 35/35; migration 011, reconcile and push fan-out run against a real PostgreSQL 16; live server smoke test; full earlier suites re-run (Phase 2: 44/45, the one failure is a missing Hindi OCR pack in the sandbox).
- Not verified here: live government sites and real push services (no access). Domains other than Punjab and Bihar PSC are run-time verified, not pre-confirmed.

---

## v2.9.3 - Hybrid RAG pass B of 2: knowledge store for private-sector, exam, learning and career documents
Additive. No tab, menu item, existing route or existing response field changed. **New:** `rag_core/knowledge.py` (`KnowledgeStore`, `AnswerKeyVault`); routes in a separate file `routers/hybrid_knowledge.py`: `GET|POST /rag/hybrid/knowledge`, `DELETE /rag/hybrid/knowledge/{id}`, `POST .../{id}/check`, `GET .../{id}/answer` (admin for write, signed-in user for check/answer). **Labels:** old or undated hiring information is labelled `historical` / `unverified` (computed from the stored dates when the answer is built, so a record ages on its own); AI-generated practice content is labelled `ai_generated`, capped at `internal` authority and carries a disclaimer inside the chunk text; an official/verified claim with no source URL is downgraded. **Answer keys never enter the shared index:** key fields and answer lines are moved to a separate vault file (mode 0600) that is not searchable, not embedded and never sent to the LLM. Answers and source cards show the labels; the system prompt forbids stating historical/unverified material as a current requirement. New `batch` filter. New settings `HYBRID_RAG_KNOWLEDGE_PATH|ANSWER_KEYS_PATH|KNOWLEDGE_DIR|HIRING_WINDOW_DAYS|EXAM_WINDOW_DAYS` (all optional, documented in `.env.example`). Tests: `tests/test_rag_passb.py` (48). Contract tests updated intentionally (source-card keys, golden route list). Nothing is seeded: the store starts empty and nothing is invented.

## v2.9.2 - Hybrid RAG pass A of 2: reranker wired in + index survives restarts
Additive. No tab, route, menu item or existing response field changed. **Reranker:** `rag_core/rerank.py`. `rerank` is no longer inert. `HYBRID_RAG_RERANKER=off|lexical|cross-encoder|auto` (default `auto`): a deterministic lexical-coverage reranker always works; a learned cross-encoder (`sentence-transformers`, `HYBRID_RAG_RERANKER_MODEL`) is used when installed and degrades once, reported, to lexical when it cannot load. Request `rerank` is now tri-state: `true`/`false` force, omitted = automatic for recruitment-fact questions and near-tied results. First-stage rank and exact-identifier matches survive reranking; filters/access control/staleness run before it. `retrieval.reranked` and `retrieval.reranker` say what actually ran. Retrieval now runs off the event loop. **Persistence:** snapshot defaults to `data/hybrid_rag/records.json` (fsync + atomic, unwritable/corrupt paths are reported in `GET /rag/hybrid/status` -> `persistence`, never silent), plus an embedding cache `vectors.npz` (content-hash keyed, refused when the embedding model/version differs, public chunk text only - request-scoped resume text is never written). Render disk + compose volume mount `/data`; templates ship `HYBRID_RAG_SYNC_MINUTES=30`. **Auto-recovery:** the scheduler leader checks `GET /rag/hybrid/status` every `HYBRID_RAG_RECOVER_SECONDS` (120) and re-syncs immediately if the AI service restarted empty (`lib/hybridRecords.js` `health`/`syncIfEmpty`). **Tests:** `tests/test_rag_pass5.py` (21), 5 new in `test-hybrid-records.js`. **Honest limits:** the cross-encoder itself was not run here (no package index access) - the lexical reranker is a coverage heuristic, not a learned model; a durable disk is still needed on the host for the snapshot to survive a redeploy.

## v2.9.1 - Hybrid RAG pass 4 of 4 (final): evidence in the existing screens (4A) + API compatibility (4B)
Additive. Nothing removed; no tab, route or menu item added. **4A:** Career Fit "Ask" gets a fourth chip, **Govt notices** (hybrid answers with source cards: drive status, authority, advt. no., published and last-verified dates, safe notice link, conflicts, abstention; the resume is not sent); the existing eligibility drawer gets an opt-in, consent-gated **Check against the notice text** section (Meets / Does not meet / Unknown with verbatim quotes). **4B:** `test-api-compat.js` (25) and `campus/ai-ml-service/tests/test_api_compat.py` (34) with route snapshots in `tests/api-contract/` and `tests/api_contract/`, mutation-checked; `campus/HYBRID_RAG_ARCHITECTURE_BEFORE_AFTER.md`; `campus/HYBRID_RAG_MODIFIED_FILES.md`. **Fixed:** the service worker (cache-first) and the Campus `app-runtime.js` URL kept their old cache keys after 4A, so returning users would not have seen the new UI - now `govcareer-shell-v19` and `?v=gc-officialletter2-hrag`. **Not done / open:** reranker not wired (`rerank` is inert), index is in memory (re-sync after restart), no RAG for private-sector/exam/learning documents, LangChain never run against the real package, no performance or real-embedding measurements. See `campus/HYBRID_RAG.md`.

## v2.9.1 - Hybrid RAG pass 3 of 4: database sync, LangChain orchestration, evaluation harness
Additive. Nothing removed. **New:** `lib/hybridRecords.js` (GovCareer DB -> AI-service records: real published notices only, never sample data; freshness = the source's own last successful crawl; unreachable sources stay "unreachable"; archived records are removed from the index), `POST /api/admin/hybrid-rag/sync` (ADMIN, audited), `npm run hybrid:sync`, optional scheduler task (`HYBRID_RAG_SYNC_MINUTES`, off by default); `rag_core/lc_chain.py` (LangChain LCEL prompt|provider chain for the generation step, `HYBRID_RAG_USE_LANGCHAIN=off|auto|on`, falls back to the direct provider call and never double-calls a failing provider); `scripts/eval_hybrid_rag.py` + `tests/eval/` + `campus/EVALUATION_REPORT.md`. **Fixed (found by the evaluation):** the router sent career-advice questions containing only the word "government" to recruitment-only retrieval (returned nothing); every recruitment chunk now carries a drive header so a section like "Important Dates" is matched to the right advertisement; `RecordPayload` now accepts `source_error`. **Tests:** `test-hybrid-records.js` (17), `tests/test_rag_pass3.py` (9), `tests/test_rag_lc_chain.py` (10, 2 skipped without langchain-core). LangChain itself was NOT executed (no package index access in the build sandbox).

## v2.9.0 - Hybrid RAG pass 2 of 3: recruitment records + deterministic eligibility
Additive. New `rag_core/{recruitment,eligibility,ingest}.py`; routes `POST /rag/hybrid/eligibility`, `GET|POST /rag/hybrid/records`, `/records/{id}/verified|unreachable`, `DELETE`, `/records/sweep` (admin-only mutations; gateway now also sets `x-user-role` from the verified JWT and drops any client value); drive status `active/upcoming/closed/unverified/inaccessible` shown in every source header; three-valued eligibility verdicts decided by code with verbatim notice quotes. 38 new tests pass; see `campus/HYBRID_RAG.md` for what was and was not verified.

## v2.9.0 - Shared Hybrid RAG core (pass 1 of 2)
Additive. New `campus/ai-ml-service/app/rag_core/` (BM25 + vector + RRF + metadata filters + access control + staleness + injection defence + citation/unsupported-claim validation + abstention + routing + cache + metrics), new `/rag/hybrid/*` routes, gateway now sets `x-user-id` from the verified JWT. No tab, route or record changed. See `campus/HYBRID_RAG.md` for what was and was not verified.


# v2.9.0 - Trust & evidence layer (additive)

Reliable, evidence-backed decisions. Nothing removed. See TRUST.md.
- Per-field human verification with page+quote evidence; stale after amendment; hash-chained append-only evidence ledger (migration 010).
- Status explained: verified / partially verified / detected / unverified / conflicted / retracted, plus amended and phase; new detections stay unverified.
- Immediate flags for changed deadlines and conflicting amendments/documents; source monitor for changed pages, expired notices, date mismatch, broken links.
- Eligibility: completed-years age on cutoff date, leap-day and relaxation ambiguity, INSUFFICIENT_EVIDENCE instead of guessing; 28 hand-calculated cases pass.
- AI guard: abstains, reports conflicts, separates official facts / derived / guidance, detects invented dates, figures, qualifications, syllabus topics.
- Alerts: preferences, trust-flag alerts, honest delivery receipts. Career Fit explanations, Exam Prep quality checks and analytics, account consents/sessions.
- Extraction precision/recall harness (Wilson intervals). Evidence grade is SYNTHETIC_ONLY: no real-notice accuracy claim.
- Fixes: "Master's degree" read as bachelor+master; "Number of posts" vacancy wording; missing education/age/domicile no longer crashes evaluate().
- Server/PG/jsdom/live monitor were not exercised in the build sandbox (npm registry unreachable).

---

# v2.8.7 - Merge: v2.8.2 (automatic live monitoring, GovCareer AI sub-tab) + v2.8.6 (RAG / semantic Career Fit, gate-pass letter, QR expiry, scanner fix, same-page sub-tab)

**Base = v2.8.2 (autolive)** for everything GovCareer AI: `lib/{autopublish,sourcePolicy,broadcast,scheduler,feed,detected,providers}.js`, `public/autolive.{js,css}`, `campus/frontend/govcareer-live.js`, migration `009_autolive.sql`, `test-autolive.js`, the scheduler-based `worker.js`, and the unread badge on Roadmaps & Govt Jobs > GovCareer AI.
**Added from v2.8.6** (files only in it, or newer there): the whole `campus/` tree (transformer-embedding Live Semantic Match, Ask Career Fit RAG, AI/ML service + tests, handwritten single white-paper gate-pass letter, college-name field, QR 3-hour expiry blur, camera scanner fix, `collegeName` on public verify), plus GovCareer AI staying inside the Campus portal (`public/embed.js`, `public/account.js`, `GovCareerAiPanel onCampusNav`, extended `test-govcareer-subtab.js`).
**Hand-merged files:** `campus/frontend/app-runtime.js` (v2.8.6 + the v2.8.2 unread-badge hooks), `campus/frontend/index.html` (v2.8.6 font/cache-bust + `govcareer-live.js`), `package.json` (v2.8.2 scripts + `test:subtab`).
Nothing from either zip was removed. Both zips used the label "v2.8.2" for different builds; their notes are kept below, the autolive one is the "Automatic live monitoring" entry.

---

# v2.8.2 - Automatic live monitoring, inside the Campus Portal (additive)

**The problem this fixes.** Nothing could arrive on its own: every real source was seeded "pending" with crawling OFF, and every
document, however clean, waited for a person to approve and publish it. The worker ran every 15 minutes and sent no e-mail.

**What happens now, end to end**
1. The scheduler (inside the server; `node worker.js` is optional) asks each verified source "anything new?" about every 30 minutes
   (per source), using ETag / Last-Modified, same-domain redirects only, robots.txt, per-host rate limits and a cool-down after 5 failures.
2. New official links are downloaded, scanned, read (text, OCR fallback), cited page by page and checked for fraud, duplicates and conflicts.
3. `lib/autopublish.js` publishes **only if every rule holds** (verified official source, schema-valid, confidence >= 0.85, no risky flag,
   title/organisation cited, a vacancy count or closing date present, closing date not long past, and for corrigenda every change cited in both versions).
   The record is labelled **AUTO_EXTRACTED** until a reviewer confirms it (`/api/admin/auto-published`), and can be retracted.
4. Anything that fails a rule stays in the human review queue AND appears in the feed as **"Detected - not yet verified"** with the official link.
   Suspicious items are never announced.
5. The event is written to `feed_events`; the server pushes it over the existing stream (`job.new`, `deadline.extended`, `job.amended`,
   `job.detected`, `job.retracted`) within ~5 s. Open browsers get a toast; the Campus portal shows it from ANY tab and puts an unread badge on
   Roadmaps & Govt Jobs > GovCareer AI. A person who was offline catches up from `/api/feed?since=`.
6. Per-person alerts (watchlists, saved searches) pick the new record up on the next minute; channel broadcast (Telegram / Discord / e-mail API)
   sends each event at most once per channel, with retries.

**Sources.** Fourteen more official recruiters were added (NCS, RRB apply, Railways, RBI, DRDO, ISRO, Army, EPFO, ONGC, NTPC, Power Grid, IOCL, KVS, MHA).
They are verified automatically only if: https + public address, official domain (gov.in / nic.in / curated list / `OFFICIAL_DOMAIN_EXTRA`), the portal answers
with HTML/XML, and the page itself talks about recruitment. Failures stay pending with the reason stored. I could not reach the internet when building this,
so whether each URL answers is reported at run time through source health; it is not assumed.

**GovCareer inside Campus.** The bare GovCareer URL now sends browsers to `/campus/?open=govcareer` (the sub-tab). `?embed=campus`, API clients and
`GOVCAREER_STANDALONE_ENTRY=1` / `?standalone=1` are unaffected. The sub-tab label, position and panel are unchanged.

**New:** `GET /api/feed`, `GET /api/autolive/status` (monitored sources, last successful check, interval, queue, auto-published awaiting audit),
admin `auto-published` confirm/retract and `sources/auto-verify`, migration `009_autolive.sql` (additive), `lib/{autopublish,sourcePolicy,broadcast,scheduler,feed,detected,providers}.js`,
`public/autolive.{js,css}`, `campus/frontend/govcareer-live.js`. SW cache v17.
**Not changed:** every route, tab, test and migration from v2.8.1. Existing "nothing is auto-verified" behaviour still applies to agents, demo/manual sources and AUTO_PUBLISH=0.

**Demo mode (no PostgreSQL).** There is no ingestion pipeline, so links that appear on an official portal after the first look are shown as "detected, not verified". Nothing is read or published.

**Verified here:** new `test-autolive.js` 43/43 (policy, publish transaction, lifecycle guard, SSRF, crawler 304/redirect/cool-down, broadcast retries, scheduler
leader/standby/isolation, feed, wiring); existing offline tests unchanged (test, UI 10/10, realtime 5, advanced 17, upgrade 21, sub-tab wiring); 23/23 Campus tests that run offline identical to before.
**Not verified here (no PostgreSQL, no network, no node_modules):** the SQL against a real database, the other PostgreSQL-backed suites (phase 2-6, bridge, account), live government sites, and real Telegram/Discord/e-mail delivery.
Run `npm ci && npm run test:db:setup && npm test` before deploying.

**Honest limits.** Detection is scheduled, not instant. Pages that need JavaScript rendering, CAPTCHAs or logins are not read (and are never bypassed). Text-only notices without a PDF are weaker than PDFs.
Auto-published records are machine-read: always confirm on the official notice.

---



---

# v2.8.4 - GovCareer AI stays inside the Campus portal (no exits to a separate page or tab)

GovCareer AI is the third sub-tab of **Roadmaps & Govt Jobs**, right after **1000+ Govt Jobs** (unchanged from v2.8.1; no top-level tab was added). Inside that sub-tab three things still pushed people out, and are now closed (embedded mode only; standalone GovCareer behaves exactly as before):
- **Sign in** no longer sends the frame to `/campus/?next=...` (which loaded the whole Campus portal inside the frame). It reuses the Campus session you are already in (consent dialog on first use).
- **Sign out** inside the sub-tab signs out of GovCareer AI only; it no longer logs the Campus session out or navigates away.
- **Campus links** (Bridge "Open Campus", practice links such as aptitude / interview / resume) no longer open a new browser tab. The Campus page opens the matching Campus tab in the same page (Skill Hub > Aptitude, Mock Interview Studio, Career Fit, or the Dashboard).
Also: clearer "not reachable" text (GovCareer AI is served by the unified server), service-worker cache bumped to v17. Files: `public/embed.js`, `public/account.js`, `public/sw.js`, `campus/frontend/app-runtime.js`, `test-govcareer-subtab.js` (extended). Nothing removed.

---

# v2.8.3 - Gate pass: instant handwritten-style letter on submit

When a student submits a gate-pass request, the official letter is generated instantly from the submitted details and shown as a handwritten-style image (ruled paper, handwriting font, the student's drawn signature) with a one-tap PNG download. Also available from every request card (**Handwritten Letter**) and from the letter/pass modal (**Handwritten**). Applied identically to `campus/frontend/app-runtime.js` and `campus/mainapp.js`. Client-side only; every earlier feature (request form, teacher/mentor/guardian/HOD flow, HOD override, QR + 3-hour window, verifier, notifications, letter + pass downloads) is unchanged. New test: `campus/backend/tests/gatePassHandwrittenLetter.test.js`. Details: `campus/CHANGELOG.md`.

---

# v2.7.1 - Career Fit: RAG (Ask Career Fit) - additive

See `campus/RAG_CAREER_FIT.md`. New **Ask Career Fit (RAG)** card in the Career Fit tab: questions are answered only from numbered passages of the student's resume and a curated career knowledge base (role roadmaps, market skill demand, placement guidance). Hybrid retrieval (transformer embeddings + BM25, reciprocal-rank fusion, MMR, role and first-person boosts), Groq/Gemini answer with enforced `[n]` citations, clickable sources with match %, follow-up questions with short history, scope selector (resume / knowledge / both).

- **No guessing:** no evidence -> LLM not called ("no-evidence"); LLM down -> extractive passages; invented citations stripped; uncited answers flagged; model down -> 503 with the reason (no hashed substitute).
- **New:** `ai-ml-service/app/services/rag.py`, `routers/rag.py` (`POST /rag/query`, `POST /rag/retrieve`, `GET /rag/status`), `data/rag_kb/placement-guidance.md`, `scripts/verify_rag.py`, `RAG_*` settings, gateway contract lists the new routes, `.dockerignore` keeps the KB markdown.
- **Tests:** `tests/test_rag.py` 22/22; existing ai-ml-service suite 93/93; `ragCareerFit.test.js` added to `npm test`; Career Fit, advanced, analysis, cookie, resume-wiring, fallback, render, nonce, hardening and secure-gateway Node tests pass. `coldStartAndAiMl.test.js` needs `npm install` (bcryptjs) and was not run.
- **Not changed:** every earlier route, tab, panel (Live Semantic Match, Skill Gap, Roadmap, ATS optimizer, Market Radar, Career-path predictor) and migration.

---

# v2.7 - Career Fit: real semantic matching (no silent fallback)

See `campus/SEMANTIC_CAREER_FIT.md`. Transformer embeddings (sentence-transformers/transformers/torch) are now the only matching engine; the hashed bag-of-words fallback is removed (opt-in `ALLOW_LEXICAL_FALLBACK` only, always flagged). New live semantic panel in the Career Fit tab, `/match/role-fit` + `/match/engine`, role resolution by meaning, per-skill evidence, launcher auto-install + model prefetch, Docker/Render bake the model. Requirements split into `requirements-core.txt` / `requirements-ml.txt`. Dockerfile moved to Python 3.12 (ML wheels).

---

# v2.6.2 - Merge with P1 AI/ML Live Fix + voice/input fixes

**Merge result.** `p1_FINAL_AI_ML_LIVE_FIX` was compared file-by-file against `campus/` inside Unified v2.6.1. Nothing existed only in the P1 zip: every P1 file is already present in `campus/`, and wherever both differ the Unified copy is the newer, better one (live-AI timing 30s/2 retries/38s, response cache off, two-language AI Video Tutor, SSO return, Bridge source routes, monorepo-safe `migrate-deploy.js`, port 3101). So the merged project = Unified v2.6.1 + the fixes below, with no duplicate tree and no feature removed.

**Fix 1 - text pasted back after Send** (`campus/frontend/app-runtime.js`, `public/app.js`)
- Root cause: push-to-talk dictation kept a stale snapshot of the answer box; the next speech result re-wrote the box with the old text after it was sent/cleared. It now detects that the field changed (Send, Clear, manual edit) and rebases on the live value. Fixes Mock Interview, follow-up answers, MirrorMentor-X and all `useMisDictation` boxes.
- Ask AI chat (campus) and Ask the AI (GovCareer): double-submit guard, input remount + re-clear so mobile keyboard composition cannot restore the sent text, autocorrect/spellcheck off. AI Video Tutor follow-up box gets the same re-clear.

**Fix 2 - teacher voice not continuous** (`campus/frontend/app-runtime.js`)
- Browser voice speaks sentence-sized chunks (engines cut one long utterance after ~15 s), with a per-chunk watchdog for engines that never fire `onend`; one failing chunk no longer ends the lesson.
- Neural voice reuses one persistent `<audio>` unlocked on the first tap (iOS/Safari/Android blocked later auto-plays), retries on rate-limit, and pre-fetches the next two segments so there is no gap.
- Segment advance uses a play token (stale callbacks ignored), no state-updater side effects, pause/resume/seek/restart rewritten on the same engine. Non-English lessons choose a matching browser voice (te-IN, hi-IN, ta-IN, kn-IN, ml-IN, bn-IN, mr-IN). The Listen buttons use the same chunking.

**Tests.** New `campus/backend/tests/voiceAndInputRegression.test.js` (added to `npm test`). SW cache v14.

---

# v2.6 - Jobs+ (additive)

- **Search and filters**: department, organisation, keyword, last-date-on-or-before, minimum vacancies, fee-free, has-official-updates; sort by best fit, closing soonest, most vacancies, exam date, recently verified; saved presets; compare up to 3 posts.
- **Alerts**: bell on every result; watched posts show due items (closing within 7 days, exam within 14 days with an admit-card check reminder, result check once the exam date passes). Opt-in browser notifications. Admit card and result dates are not in verified records, so they are never invented.
- **Job detail**: met / partial / not-met summary, what blocks you, date timeline, seats by category (your category highlighted), document checklist, add-to-calendar .ics, share summary.
- **Mobile**: bottom-sheet drawer, 44px touch targets, scrolling chips, safe-area spacing.
- New files `public/jobsplus.js`, `public/jobsplus.css`; `lib/search.js` only gains extra fields on each result. SW cache is now v13. Existing tests: UI 10/10, advanced 17/17, realtime 5/5, phase 1 pass.

---

# v2.5 - Advanced Strategy Suite (additive)

- **New Strategy tab**: brief, decision matrix with user-set weights and rank stability, deadline and conflict radar, age runway, spaced-revision study planner, mock-test analytics, what-if scenarios, target portfolio with syllabus overlap, local photo/signature checker, `.ics` export, print and opt-in browser reminders. See `ADVANCED.md`.
- New stateless API under `/api/advanced/*` in both `server.js` and `standalone.js`; nothing is stored server-side.
- **Bug fix**: ex-servicemen age relaxation was never applied from the main UI (`exServiceman` vs `exServicemen`); the eligibility engine now accepts both.
- Service-worker cache bumped to `govcareer-shell-v12`; command palette gains "Strategy".
- Tests: `test-advanced.js` 17/17, `test-advanced-ui.js` 9/9; Bridge 58/58, UI contract 10/10, Phase 4/5/6 and realtime unchanged. Phase 3 is still 105/107 with the same two date-dependent failures as the v2.4 upload. Phase 2 and Account tests need PostgreSQL and were not run here.
- Not changed: every earlier route, screen, migration and test.

---

# v2.4 - One login + real time

## One login for the whole app
- **The Campus sign-in is the only login screen.** Opening GovCareer without a Campus session redirects to `/campus/?next=/`; after the Campus login (password, Face ID or fingerprint) you are sent straight back.
- GovCareer no longer has its own sign-in / create-account form. Its "Sign in" button goes to the Campus login; the header shows your Campus name.
- `POST /api/account/sso` exchanges the verified Campus session (asked of the Campus service via `GET /api/auth/me`) for a GovCareer session. No password is shared or duplicated. The first visit shows one privacy-consent step (nothing is created without it); after that sign-in is automatic.
- Sign out ends both sessions. `GET /api/session` reports the current state.
- The old `/api/account/register` and `/api/account/login` password endpoints now return 410 unless `LEGACY_ACCOUNT_LOGIN=1` (kept only so the earlier API tests still run).
- Entry gate fails open if the Campus service is unreachable, and is off with `REQUIRE_LOGIN=0`, `DISABLE_CAMPUS_PORTAL=1` or in `standalone.js`.
- Not changed: the staff console at `/admin.html` keeps its separate reviewer login (different people, different roles).

## Real time
- One Server-Sent-Events stream, `GET /api/stream` (also in `standalone.js`), with automatic reconnect and resume from `Last-Event-ID`.
- `pulse` (live counts every 15 s), `jobs.changed` (published set or a deadline status changed, or an admin publishes), `sources` / `source.changed` (official portals checked once on the server every 2 min, not once per visitor), and private `alert` events for the signed-in person (read from `alert_events`, so the separate worker process works too).
- UI: Live pill with "seconds ago", ticking deadline countdown for closing-soon posts, counts and portal monitor updated without polling, results refresh automatically when data changes.
- Everything shown is computed from published records or live portal checks; nothing is simulated.

## Tests
`npm test` now includes `test-realtime.js` (5 checks) and a rewritten `test-account.js` (20 checks, incl. SSO, gate and stream). Phase 2 (44/45) and Phase 3 (105/107) have the same 3 failures as the uploaded v2.3 (date-dependent checks and missing OCR language packs).

---

# Bridge release (additive)

- **New Bridge tab**: Campus aptitude / digital-twin / interview evidence + resume + self-assessment + Exam Lab progress matched to verified recruitments, with explainable fit ranges, readiness hours, skill-gap ranking, daily study plan, what-if simulation and saved progress snapshots.
- **Two-sided, consented, revocable link** between GovCareer and Campus accounts, protected by an HMAC service signature so the student's browser token alone can never create a link or export data.
- Works without PostgreSQL (resume + self-assessment) via the resilient and standalone runtimes.
- Migration `008_bridge.sql`; `/api/account/export` v1.2 includes Bridge data; consent withdrawal and account deletion revoke the link.
- No existing feature, route or test was changed in behaviour. See `BRIDGE.md`.

---

# GovCareer AI — Real-Time Hackathon/IIT M.Tech Hardening Release

## Critical fixes
- Profile selectors now populate immediately from a built-in validated catalog.
- Highest qualification includes 8th, 10th, 12th, ITI, Diploma, Bachelor's, Master's and PhD.
- State, domicile, stream and category selectors are populated even when the metadata API is unavailable.
- Metadata is refreshed from the server when available.
- API calls have bounded client-side timeouts.
- Overview requests use partial-failure handling instead of blanking the application when one service fails.
- Career paths use the resilient runtime when PostgreSQL is unavailable.
- Exam mock-test catalog and tutor behavior are available in resilient mode.
- PostgreSQL migration files restored to the release archive.

## Runtime modes
1. `node standalone.js` — zero-dependency public/hackathon runtime.
2. `npm ci && npm start` — PostgreSQL-backed production runtime.
3. Docker Compose — PostgreSQL + production runtime.

## Verified in this build
- UI contract tests: 10/10
- Phase 5 behavior tests: 46/46
- Phase 6 contract tests: 10/10
- JavaScript syntax checks: PASS
- Standalone `/api/meta`: PASS
- Standalone natural-language search: PASS
- Standalone eligibility evaluation: PASS
- Standalone grounded assistant + audit id: PASS
- Standalone knowledge graph: PASS
- Standalone verified exam syllabus: PASS
- Standalone mock-test catalog: PASS

# v2.2 — Account UI

The account API existed since Phase 4 but the web UI never sent a login token, so My Tools could not work
against the PostgreSQL runtime. This release adds an additive front-end module (`public/account.js`,
`public/account.css`); no existing file's behaviour was removed.

## New
- Sign in / create account (explicit privacy consent, 10+ character password), sign out
- Bearer token attached to `/api/account/*` calls, so the existing tracker now loads for signed-in users
- Watch / unwatch from the opportunity drawer; "Track" also records into the account tracker
- Application tracker with all nine statuses, application number and notes
- Saved searches with an alerts on/off switch; alerts inbox
- Preferences, data export (JSON download), consent withdrawal, account deletion
- Honest demo mode: the zero-dependency runtime has no real accounts and the UI says so
- Service-worker cache bumped to `govcareer-shell-v9`

## Bugs found and fixed by the new tests
- Account deletion originally sent no token (the path match required a trailing slash).
- Demo runtime returns 405 (not 404) for unknown POSTs; both are now treated as "accounts unavailable".

## Verified
- `npm test`: Phase 1 pass, Phase 3 107/107, Phase 2 45/45, Phase 4 10/10 + 27/27, Phase 5 9/9 + 46/46,
  Phase 6 10/10, **Account 17/17** (API round-trip, cross-user isolation, real-DOM behaviour in jsdom, demo mode)
- `npm run check`: syntax + UI contract pass

## Known limitations
- Alerts are only *delivered* when the worker and a notification channel are configured (see `.env.example`);
  the inbox shows whatever the alert planner has already produced. No email/push provider is configured by default.
- The Campus portal (`/campus/`) keeps its own login; GovCareer accounts and Campus accounts are not yet linked.
- Browser behaviour was verified in jsdom, not in a real browser; please click through once on your machine.

## v2.6.3 - Render login "internal error" fix
- Root cause: `campus/backend/scripts/migrate-deploy.js` hard-coded `<repo-root>/node_modules/prisma/build/index.js`.
  On Render `NODE_ENV=production` skips devDependencies, so Prisma was never installed -> `MODULE_NOT_FOUND`,
  migrations were skipped, tables (User, ...) never existed and every sign-up/login returned an internal error.
- Fix: the script now locates the Prisma CLI dynamically (backend, repo root, or `npx` fallback);
  `prisma` moved from devDependencies to dependencies in root and backend `package.json` + lockfiles.
- No features removed; all other files unchanged.
- DB alignment: `campus/backend/prisma` (schema + all 9 migrations) re-synced from the P1 package (identical);
  `.env.example` now uses the P1 PostgreSQL URL format with `DIRECT_URL`; added root `render.yaml`.

---

# v2.8.2 - Merge: GovCareer Unified v2.8.1 (GovCareer AI sub-tab) + v2.7.1-RAG (transformer embeddings, RAG)

**Merge result.** `GovCareer-Unified-v2_8_1` and `GovCareer-Unified-v2_7_1-RAG` were compared file by file. Base = v2.8.1; everything that existed only in v2.7.1-RAG was added, and the three places where both changed the same file were merged by hand. No tree is duplicated and no feature from either zip was removed.

**From v2.8.1 (kept as-is)**
- **GovCareer AI sub-tab** inside Campus Portal > Roadmaps & Govt Jobs (next to "1000+ Govt Jobs"; same origin, same login, Campus theme via `?embed=campus`; honest "not reachable" state with Retry). Files: `public/embed.js`, `public/embed.css`, same-origin framing headers in `server.js`, `test-govcareer-subtab.js`.
- Prep tools (`lib/prep.js`, `public/prep.js`, `public/prep.css`), Next-actions engine (`lib/advanced/nextactions.js`, `POST /api/advanced/next-actions`), provider circuit breaker (`lib/resilience.js`), request ids / structured logs / p50-p95-p99 metrics (`lib/observability.js`), Striver `</>` glyph, `test-upgrade.js`, `UPGRADE_REPORT_v2_7_0.md`.

**From v2.7.1-RAG (added back)**
- AI/ML service: transformer sentence-embeddings as the only matching engine (`app/services/embeddings.py`, `skill_text.py`, `role_catalog.py`), `/match/role-fit`, `/match/engine`, RAG (`app/services/rag.py`, `app/routers/rag.py`: `POST /rag/query`, `POST /rag/retrieve`, `GET /rag/status`, knowledge base `data/rag_kb/`), `requirements-core.txt` + `requirements-ml.txt`, model download / verify scripts, Python 3.12 Docker image with the model baked in, `RAG_*` and embedding settings.
- Campus backend gateway: new routes in the contract list, embedding status in the AI/ML readiness reply, launcher that auto-installs core + ML stack and prefetches the model, `test:rag`.
- Campus frontend (`campus/frontend/app-runtime.js`): **Live Semantic Match** panel and **Ask Career Fit (RAG)** card in the Career Fit tab, semantic Skill Gap result with engine badge.
- Tests: `semanticCareerFit.test.js`, `ragCareerFit.test.js`, `tests/test_rag.py`, `tests/test_semantic_matching.py`; docs `campus/SEMANTIC_CAREER_FIT.md`, `campus/RAG_CAREER_FIT.md`.

**Where both zips changed the same file**
- `campus/frontend/app-runtime.js`: v2.8.1 sub-tab panel, switcher button, workspace-bar action and glyphs + v2.7.1 semantic panels, RAG card and engine-aware Skill Gap (merged, 7 + 5 differing hunks, nothing dropped).
- `campus/ai-ml-service/*`, `campus/backend/{server.js,src/services/mlLauncher.js,package.json}`, `campus/render.yaml`: v2.8.1 still carried the older lightweight (hashed fallback, 512 MB) versions; v2.7.1's strict-semantic versions are used. **Hosting size: the AI/ML service now needs about 2 GB RAM (torch + MiniLM).**
- Root: `package.json` version 2.8.2, `test-govcareer-subtab.js` added to `npm test`; release notes below keep every earlier entry.

## v2.8.8 - Dynamic overview metrics + animated startup loader
- GovCareer AI Overview cards no longer show a bare "0 verified opportunities". New `public/metrics.js` owns the cards:
  shimmer while loading; verified count when > 0; otherwise the live state of the app (notices detected on official
  portals awaiting verification, else official portals monitored live, else "Live"). All values come from
  /api/search, the live pulse, /api/autolive/status and /api/feed. Nothing is invented.
- Intelligence status now reports OFFLINE / PARTIAL correctly instead of always ONLINE.
- Service worker cache bumped to v18 so returning users receive the update.
- Campus portal: animated web-globe loader replaces the static login shell while the app loads (CSP hash updated).
