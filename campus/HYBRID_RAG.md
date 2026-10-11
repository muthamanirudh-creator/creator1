# Shared Hybrid RAG core (v2.9.1, passes 1-4 of 4)

An additive, reusable retrieval layer in the AI/ML service (`campus/ai-ml-service/app/rag_core/`). Nothing that existed was
removed: the legacy Career Fit RAG (`/rag/query`, `/rag/retrieve`, `/rag/status`), every tab, every route and every record are unchanged.

## What is in this pass
| Capability | Where |
|---|---|
| BM25 lexical + dense vector retrieval, weighted Reciprocal Rank Fusion | `store.py`, `lexical.py`, `fusion.py` |
| Hard metadata filters (domain, organisation, role, location, cycle, doc type, source, dates, authority) applied **before** ranking; query-derived filters are relaxed when they match nothing and the response says so | `filters.py`, `store.py` |
| Exact-identifier matching (e.g. `Advt. No. 03/2025`) so notification numbers are found lexically | `store.py` |
| Access control: `public` / `user:<id>` / `org:<id>` scopes; per-user cache keys; request-scoped resume docs never persisted | `filters.py`, `pipeline.py` |
| Staleness: `expired` / `superseded` / `withdrawn` / `expires_at` excluded by default, labelled when explicitly requested | `filters.py` |
| Duplicate removal (hash + Jaccard), more authoritative / newer copy wins | `store.py` |
| Embedding cache by content hash: unchanged text is never re-embedded | `store.py` |
| Bounded, source-numbered context with source/issuer/date/authority headers | `context.py` |
| Prompt-injection defence: instruction-like lines removed, delimiters neutralised, rules + no tools in the prompt | `security.py`, `pipeline.py` |
| Citation validation, invalid `[n]` stripped, sentences with figures/dates absent from the cited source removed | `citations.py` |
| Conflict detection between sources of one record (`record_key` + `facts`) | `context.py` |
| Abstention (LLM not called), recruitment facts require an official/verified source, honest extractive fallback, retry + timeout | `pipeline.py` |
| Query router: domain + deterministic operations (auth, application tracking, countdowns, profile, stats) are redirected, not sent to an LLM | `router.py` |
| TTL/LRU cache, privacy-safe metrics (counts/latency only), redaction helper, Recall@K / MRR / nDCG evaluation | `cache.py`, `metrics.py`, `security.py`, `evaluation.py` |
| LangChain bridge (`BaseRetriever`, `Embeddings` adapter) - optional | `langchain_adapter.py`, `requirements-rag.txt` |

## API (through the authenticated gateway `/api/ai-ml/...`)
* `POST /rag/hybrid/query` `{question, domain?, filters?, history?, include_stale?, rerank?}` -> `{mode: llm|extractive|abstained|deterministic_redirect, answer, sources[{n,title,organization,url,published_at,last_verified_at,authority,status,section,excerpt,relevance,flags}], citations_used, unsupported_removed, conflicts, warnings, confidence{level,relevance_signal,not_a_probability}, verification, route, retrieval, trace_id}`
* `POST /rag/hybrid/retrieve` retrieval only
* `GET /rag/hybrid/status` index stats + metrics

Security note: the gateway now sets `x-user-id` from the **verified JWT** and drops any client-supplied `x-user-id`; the AI service uses it only for isolation.

## Honest limits of this pass
* **LangChain was not executed here.** The build sandbox has no PyPI/npm access. The core is dependency-light (stdlib + numpy) and tested; the LangChain adapter follows the `langchain_core` 0.3 interface but is only exercised by `LangChainAdapterTests`, which auto-skips when the package is missing. Install `requirements-rag.txt` and re-run `python3 -I tests/test_rag_core.py`.
* The FastAPI router and service wiring were compile-checked and reviewed, but **not run** (FastAPI/pytest not installable here). The core logic is covered by 27 stdlib tests (26 run, 1 skipped).
* Embeddings in tests are a deterministic stand-in; real-model quality and `HYBRID_RAG_MIN_RELEVANCE` calibration need `scripts/verify_rag.py`-style measurement on your model.
* The shared index is in memory and seeded only from the existing career knowledge base. No government/private documents are indexed yet (that is the ingestion pipeline, pass 2). Until then recruitment questions correctly **abstain** instead of guessing.
* No UI changes in pass 1.

## Verify
```bash
cd campus/ai-ml-service && python3 -I tests/test_rag_core.py      # 27 tests (pytest also works)
cd ../backend && node tests/hybridRagCore.test.js                 # wiring + gateway identity checks
```


---
# Pass 2 - recruitment records, honest freshness, deterministic eligibility
Additive again: new modules `recruitment.py`, `eligibility.py`, `ingest.py` in `rag_core/`; nothing from pass 1 or the legacy RAG was removed.

## Drive status (never "live" unless verified)
`active` (verified within `HYBRID_RAG_MAX_VERIFICATION_AGE_DAYS`, official/verified source, inside the application window) / `upcoming` / `closed` (by the record's own deadline; flagged "may have been extended" if verification is old) / `unverified` (stale or no verification, unofficial source, or no deadline) / `inaccessible` (last check failed; **the last successful verification time is kept, never refreshed**). Statuses are recomputed on every read and by `sweep`, so a cached label cannot outlive its facts. The status and advertisement number appear in every source header sent to the model, and the prompt forbids calling a drive open unless `drive_status=active`.

## Records, duplicates, drives
Records are **pushed in** (admin / the existing GovCareer crawler); this service performs no outbound fetching, so it adds no SSRF surface. Same drive (organisation + role + advt no., or cycle) from several URLs/versions: the most authoritative, most recently verified copy wins, the rest are marked `superseded` (hidden by default, kept for audit) and a `conflict:<field>` flag is raised when copies disagree. Different advertisement numbers are **separate drives and are never merged** (`multiple_drives_for_role` warning). An `official` claim is downgraded to `verified` unless the URL is on the official-domain policy (`gov.in`, `nic.in`, plus `HYBRID_RAG_OFFICIAL_DOMAINS`) - a policy, not proof of authenticity. Optional JSON snapshot of **public** notice data via `HYBRID_RAG_RECORDS_PATH` (no student data is ever written).

## Eligibility engine (code decides, LLM never does)
Each criterion -> `meets | not_meets | unknown`, with the verbatim notice quote. Criteria come from a conservative regex extractor and/or caller-supplied criteria; **any criterion whose quote is not found verbatim in the stored notice is rejected**, and stored criteria are re-validated on every use. CGPA<->percentage and different CGPA scales are never converted silently (-> `unknown`; only an explicit student-stated university factor is used). Age uses the notice's own reference date; category relaxations are not applied. Verdicts: `eligible_confirmed` (all mandatory met, none unknown, **criteria reviewed by a person**, official/verified source, drive active/upcoming), `eligible_provisional`, `ineligible_confirmed`, `ineligible_provisional` (failure per unreviewed/unofficial criteria - verify on the notice), `indeterminate` (lists `missing_profile_fields`), `drive_closed`. `coverage` lists which criterion keys were *not extracted* (not assumed absent). The student profile is request-scoped: not logged, cached or stored.

## API (via `/api/ai-ml/...`)
`POST /rag/hybrid/eligibility {profile, record_id|organization|role, cycle?, include_closed?}` (any signed-in user) - `GET /rag/hybrid/records` - **admin only** (gateway sets `x-user-role` from the verified JWT and drops any client value): `POST /rag/hybrid/records`, `POST /rag/hybrid/records/{id}/verified`, `/unreachable`, `DELETE /rag/hybrid/records/{id}`, `POST /rag/hybrid/records/sweep`. Errors are structured (`INVALID_PROFILE`, `INVALID_RECORD`, `SELECT_A_DRIVE`, `RECORD_NOT_FOUND`, `ADMIN_REQUIRED`); no match returns an empty result with a message, never a guess.

## Verified in pass 2 (this sandbox)
`python3 -I tests/test_rag_pass2.py` - 38 tests OK (status/freshness, validation + injection, extraction + quote guard, boundary numerics, three-valued verdicts, dedupe/supersede/conflict, sweep, unreachable, snapshot, embedding reuse). `test_rag_core.py` still 27 (26 run, 1 skipped). `node tests/hybridRagCore.test.js` (incl. new route/admin/gateway checks) and the related backend suites (`ragCareerFit`, `semanticCareerFit`, `securityHardening`, `secureGatewayHardening`, `finalHardening`, `renderDeployment`) pass.

## Not verified / limits (pass 2)
* FastAPI routes and the pytest/httpx suites could not be run here (packages not installable offline); the router was compile-checked and its wiring asserted from source only. LangChain still has not been executed.
* Test notices are synthetic fixtures ("Test Corp"). **No real recruitment notice is shipped or indexed**; until an admin/crawler pushes records, recruitment questions abstain. The regex extractor is conservative and English-only; branches/degrees outside its alias tables yield `unknown`, and an incomplete extraction can only produce a *provisional* verdict until a person marks the record `reviewed`.
* There is no bridge yet from the Node GovCareer database to `POST /rag/hybrid/records`; records must be pushed by admin/script.


---
# Pass 3 - database sync, LangChain orchestration, measured comparison
Additive. Nothing from passes 1-2 or the legacy RAG was removed.

## GovCareer database -> Hybrid RAG records (`lib/hybridRecords.js`)
`npm run hybrid:sync` or `POST /api/admin/hybrid-rag/sync` (ADMIN, audited) reads `recruitments` + `sources` + `documents` + `document_pages` (read-only, parameterised SQL) and pushes each record to `POST /rag/hybrid/records` with the AI-service token. Optional automatic sync: `HYBRID_RAG_SYNC_MINUTES=30` (scheduler leader only; off by default). Rules, all covered by `test-hybrid-records.js`:
* **Never sent:** sample/demo rows, rows in non-publishable lifecycle states, rows with no stored notice text (nothing is rendered from guesses). Archived rows are *removed* from the index.
* **Text** is the real extracted page text of the stored notice + amendments/corrigenda, so eligibility criteria can quote the notice verbatim.
* **Freshness** is the source's last *successful* crawl (`sources.last_success_at`), never "now". If the latest check failed the record is sent as `unreachable` with that unchanged timestamp. A source never crawled has no verification time, so its drives cannot become "active".
* **Authority:** `official` only for a VERIFIED `OFFICIAL_*` source whose document is on that source's own domain; the AI service then applies its own official-domain allow-list on top (a policy, not proof of authenticity). Auto-extracted records stay `auto_extracted`, so eligibility on them can only be *provisional* until a person reviews them.
* Missing deadline / advertisement number are omitted, not invented. A payload/schema contract test fails if the mapper sends a field `RecordPayload` does not declare.

## LangChain in the execution path (`rag_core/lc_chain.py`)
`HYBRID_RAG_USE_LANGCHAIN=off|auto|on` (default `auto`). When `langchain-core` is installed the generation step runs as an LCEL chain, `ChatPromptTemplate | messages->(system,user) | existing provider call`, so the project's Groq/Gemini fallback, retries, deadline and cache bypass are reused, not replaced. Everything that makes an answer safe stays in project code: retrieval, RRF, filters, context assembly, injection stripping, citation/unsupported-figure validation, abstention, drive status, eligibility. Every result reports `orchestration` (`langchain-lcel` | `native`); `GET /rag/hybrid/status` reports `langchain_installed`. A provider error is re-raised unchanged (provider called once); a LangChain-internal error falls back to the direct call and is counted (`langchain_fallback`). `on` raises at first use if the package is missing. **Not executed against the real package here**; run `python3 -I tests/test_rag_lc_chain.py` after `pip install -r requirements-rag.txt` and the two real-package tests will run.

## Measured comparison (`scripts/eval_hybrid_rag.py`, report in `campus/EVALUATION_REPORT.md`)
Same 16 labelled career questions through the legacy RAG and the hybrid pipeline, plus 26 recruitment behaviour checks. With the deterministic embedding test double the two pipelines tie on retrieval (Recall@5 1.0, MRR 0.906); the numbers say nothing about production accuracy. The first run **failed 3 checks and lost one retrieval case**; that exposed two real defects (below), both fixed and covered by `tests/test_rag_pass3.py`:
1. *Router:* "can I move from private sector prep to government exams" was classed as a recruitment query because of the single word "government", hard-filtered to recruitment notices, and found nothing. A recruitment route now needs a specific signal (notification, vacancy, advt, a named body...) unless the caller passes `domain` explicitly.
2. *Chunking:* a section chunk such as "Important Dates" did not say which drive it belonged to, so another drive's identical-looking section outranked it for "Advt. No. TC/01/2026 last date". Every chunk now starts with `[organisation | role | Advt. No. ... | cycle]` (built only from record fields; the stored notice text used for eligibility quotes is untouched).

## Verified in pass 3 (this sandbox)
`node test-hybrid-records.js` 17 OK; `python3 -I tests/test_rag_pass3.py` 9 OK; `test_rag_lc_chain.py` 10 (2 skipped); `test_rag_core.py` 27 (1 skipped); `test_rag_pass2.py` 38; `scripts/eval_hybrid_rag.py` exits 0 (26/26). All runnable root Node suites and the campus backend suites listed above pass (23 of 25 root test files; `test-account.js` and `test-phase2.js` need `express`/`pg`, which could not be installed offline).

## Not verified / limits (pass 3)
* `npm install` was impossible offline, so the full `npm test` chain did not run; only suites without third-party modules ran. FastAPI/pytest/httpx were absent: routers are compile-checked and exercised through their service layer, not over HTTP. LangChain not executed.
* The DB sync was tested against a stub database and stub transport, not a live PostgreSQL or a running AI service.
* Career retrieval numbers use a stand-in embedder and 16 questions. No real recruitment notice is shipped; recruitment checks use synthetic fixtures.
* Still not done (pass 4): showing source cards, drive status, freshness and the three-valued eligibility verdict inside the existing Career Fit / Eligibility Checker UI.


---
# Pass 4A - the existing screens now show the evidence (no navigation changes)
Additive UI wiring; no tab, route, or menu item was added, moved or renamed.

## Career Fit "Ask" panel (`campus/frontend/app-runtime.js`, `CareerFitRagPanel`)
* A fourth scope chip, **Govt notices**, next to the existing three. The three original scopes still call `/rag/query` exactly as before. Notices scope calls `POST /rag/hybrid/query` with `domain: "government"`; **the resume is not sent** on that path (notices are public data).
* Source cards (hybrid answers) show: issuer + title, an honest **drive status** badge (`active` / `upcoming` / `closed` / `unverified` / `inaccessible`; only `active` says anything is open and it means "verified recently, official/verified source, inside the window"), authority (official / verified / auto-extracted / third-party), advertisement number, section, published date, **last-verified date with age in days** ("Never verified" when absent), and an "Open the notice" link. Links are only rendered for `http(s)` URLs (a `javascript:` URL is dropped), with `rel="noopener noreferrer"`.
* Also shown: abstained / redirected-to-app modes, **conflicts between sources**, how many sentences were removed for unsupported figures/dates, and the evidence-strength level labelled "not a probability of being correct". The relevance percentage is now labelled *relevance* (it was "match"), including on the legacy cards.
* Empty/unsupported states: when no notices are indexed the panel says questions will say so instead of guessing; on an AI/ML build without the hybrid routes it says notice search is unavailable.

## Eligibility Checker (`public/app.js`, drawer opened by `openJob`)
* Under the existing "Eligibility analysis" a new section **Check against the notice text** (opt-in). It calls `POST /api/ai-ml/rag/hybrid/eligibility` with `record_id = gc:<job id>` (the same id `lib/hybridRecords.js` pushes).
* Verdict labels (three-valued per requirement; code decides, never an LLM): **Meets / Does not meet / Unknown**, each with the verbatim notice quote, the student's value and the reason. Overall: *Eligible - confirmed*, *Likely eligible - provisional*, *Not eligible - confirmed*, *Appears not eligible - verify on the notice* (unreviewed criteria), *Cannot be determined yet* (lists the profile fields to add), *Drive closed*. Caveats, drive status, authority, last-verified date, deadline and notice link are shown; criteria **not found** in the notice are listed as "not assumed absent".
* **Consent and minimisation:** the button stays disabled until the consent box is ticked; the date of birth and experience from the existing profile are sent only after that. The extra academic fields (CGPA, scale, percentage, graduation year, backlogs, degree, branch) exist only in the open drawer: they are **not** written to localStorage or the saved profile. The response states `profile_stored: false` and which fields were used.
* Handled responses: 401/403 (sign-in link to `/campus/`), 404/501 (service not part of this deployment / older build), 502-504 (starting up), validation errors (service message), and "no matching record - nothing was assumed".

## Backend change (additive, backward compatible)
* `source_view()` now also returns `drive_status`, `advt_no`, `record_id` (the existing `status` field is unchanged and still means the index status).
* `GET /rag/hybrid/status` now also returns `records` (number of stored recruitment drives).

## Verified in pass 4A (this sandbox)
* 37 real-browser checks (headless Chromium, Playwright) of both screens against responses produced by the **real Python engine** (not hand-written JSON): source card facts, drive status, last-verified, safe links, abstention, conflicts, `javascript:` URL rejection, legacy scopes unchanged, consent gating, the three verdict outcomes, no-record message, HTTP 401/404/503/422, no horizontal overflow at 375 px, no page errors.
* Existing suites unchanged and passing: 15 root Node suites, 31 of 35 campus backend suites (4 need `express`/`bcryptjs`/`dotenv`, not installable offline), the four Python RAG suites.
* Not verified: a live FastAPI service, live PostgreSQL, or a signed-in session end to end (the gateway and service were mocked at the HTTP boundary). The drive-status wording and the consent text have not had a legal/UX review.


---
# Pass 4B - API compatibility tests, before/after architecture, modified-files list (final pass)
Additive. No route, tab, model or record changed.

## Compatibility tests (new)
* `node test-api-compat.js` (25 checks, in `npm test`; dependency-free): every Node route (198, per file) against `tests/api-contract/node-routes.golden.json`; the only Hybrid-related Node route is `POST /api/admin/hybrid-rag/sync` (ADMIN + audited); gateway drops client `x-user-id`/`x-user-role`; the readiness contract still lists exactly the legacy routes and none of the hybrid ones; the Node fallback never answers hybrid routes; Career Fit's three original scopes still send the original `/rag/query` keys and the notices scope sends no resume/role/JD; seven GovCareer views in order and Campus tab ids identical to the untouched `campus/mainapp.js`; `/api/ai-ml` still bridged by the GovCareer server; service-worker cache and `app-runtime.js` token bumped; every root suite is in `npm test`; env templates hold placeholders and the scheduled sync defaults to off.
* `python3 -I tests/test_api_compat.py` (34 tests; stdlib + numpy; pytest also works): FastAPI routes, request models and admin guards read from source with `ast` (so it runs without FastAPI/pydantic): legacy `/rag/*` routes and `RagRequest` fields unchanged; the ten hybrid routes exactly; no duplicate or shadowed route; every router mounted; every route the gateway requires exists; no request model accepts a caller identity; every record mutation calls `_admin` first; safe model defaults; response shapes produced by the **real** hybrid pipeline (llm / extractive / abstained / deterministic_redirect / rejected) and the **real** legacy `answer_question`; source cards = the pre-4A keys + exactly `drive_status`, `advt_no`, `record_id`; legacy service does not import the hybrid core.
* Update a snapshot only after an intentional change: `npm run test:apicompat:update` / `python3 -I tests/test_api_compat.py --update`, then review the diff.
* **Mutation-checked:** 13 deliberate breakages (admin guard removed, legacy route renamed, response key dropped, `user_id` accepted in a body, router unmounted, legacy importing the hybrid core, unsafe default authority, client role header trusted, stale service-worker cache, extra nav tab, removed route, resume sent to the notices path, hybrid route added to the readiness list) were each caught by a specific test.

## Defect found and fixed
Pass 4A changed `public/app.js`, `public/styles.css` and `campus/frontend/app-runtime.js` without changing the cache keys. The service worker is cache-first, so returning users would have kept the old UI. Now `govcareer-shell-v19` and `app-runtime.js?v=gc-officialletter2-hrag`; `test-govcareer-subtab.js` pins v19.

## Documents
`campus/HYBRID_RAG_ARCHITECTURE_BEFORE_AFTER.md` (diagrams, guarantees, status against the master prompt) and `campus/HYBRID_RAG_MODIFIED_FILES.md` (added/modified files, with the caveat that no v2.8.9 baseline was supplied).

## Findings not fixed here (need a decision)
* `rerank: true` does nothing: no reranker is wired in `services/hybrid_rag.py`.
* The shared index is in memory. Recruitment records vanish on AI-service restart unless `HYBRID_RAG_RECORDS_PATH` is on persistent storage or the sync runs (`HYBRID_RAG_SYNC_MINUTES`, off by default); until then "Govt notices" abstains.
* `campus/backend/tests/voiceAndInputRegression.test.js` and `signupAndAiConfig.test.js` exist but are not in `campus/backend/package.json` `test` (the v2.6.2 notes say the first was added). Left as found.

## Verified in pass 4B (this sandbox)
Root Node: 17 suites pass (including the new one); `test-account.js` and `test-phase2.js` need `express`/`pg`. Campus backend: 27 suites pass, 4 need `bcryptjs`/`dotenv`/`express`. Python: `test_api_compat` 34, `test_rag_core` 27 (1 skipped), `test_rag_pass2` 38, `test_rag_pass3` 9, `test_rag_lc_chain` 10 (2 skipped); `eval_hybrid_rag.py` exits 0. Not verified: a live FastAPI service (the HTTP layer), PostgreSQL, the real LangChain package, real embedding quality, the full `npm test` chain (`npm install` is impossible offline).



---
# Pass A (v2.9.2) - reranker wired in, restart persistence
* **Reranker** (`rag_core/rerank.py`): `HYBRID_RAG_RERANKER=off|lexical|cross-encoder|auto`. `lexical` = deterministic query-coverage + phrase + title score blended with the fused rank (a heuristic, not a learned model). `cross-encoder` = sentence-transformers `CrossEncoder`, lazily loaded; if missing it fails once and the pipeline uses `lexical` (reported as `retrieval.reranker`). `rerank` in the request: `true`/`false` force; omitted = automatic (recruitment-fact questions, or top-2 fused scores within 12%). Exact-identifier hits keep their boost.
* **Persistence:** records snapshot `HYBRID_RAG_RECORDS_PATH` (default `data/hybrid_rag/records.json`), embedding cache `HYBRID_RAG_VECTORS_PATH` (default beside it). `GET /rag/hybrid/status` -> `persistence{path,loaded,last_saved_at,last_error,vectors_error}`, `needs_sync`, `reranker`. Durable only on a mounted disk (`render.yaml` disk, compose `govcareer_data` volume `/data`).
* **Recovery:** `HYBRID_RAG_SYNC_MINUTES=30` (templates) full sync + `HYBRID_RAG_RECOVER_SECONDS=120` empty-index check.
* Tests: `python3 -I tests/test_rag_pass5.py` (21), `node test-hybrid-records.js` (22).


# Pass B (v2.9.3) - knowledge store for private-sector, exam, learning and career documents

`app/rag_core/knowledge.py` is a writer into the **same** `HybridIndex` the government records use, so there is still one retrieval path. Government notices stay in the recruitment registry; this store refuses `domain=government`.

| Rule | Behaviour |
|---|---|
| Kinds | `company_hiring`, `job_description`, `hiring_process`, `interview_experience`, `exam_pattern`, `exam_syllabus`, `cutoff` (these *age*); `study_material`, `question_bank`, `practice_question`, `mock_test`, `career_guide` (timeless); `answer_key` (vault only) |
| `freshness` | `current` (official/verified, dated, inside the window, current cycle) / `historical` (not verified inside the window - 365 days hiring, 730 exam - or the cycle ended more than a year ago, or expired/superseded) / `unverified` (undated, date in the future, or not official/verified) / `evergreen` (timeless kinds). `historical` wins over `unverified`; both reasons are reported in `freshness_reasons` |
| Ageing | Labels are computed from the stored dates **when the answer is built** (`effective_labels`), so no sweep has to run for a record to become `historical` |
| AI-generated practice | `content_origin=ai_generated`; `practice_question`/`mock_test` with no declared origin are treated as AI-generated; authority capped at `internal`; a visible `[AI-generated practice content ...]` prefix is part of the chunk text; the UI shows an "AI-generated practice" badge |
| No bought authority | `official`/`verified` without a source URL is downgraded to `internal`; `content_origin=official` without a URL becomes `curated` |
| Answer keys | Fields `answer`, `answer_key`, `correct_option`, `solution`, `explanation` and lines such as `Answer: B` / `7. C` key rows are removed before chunking and stored in `AnswerKeyVault` (own file, mode 0600). Not searchable, not embedded, not in listings/snapshots/prompts. `check` grades an answer without revealing it; `answer` reveals on request. Both need a signed-in user (gateway `x-user-id`). `scan_index_for_answer_keys` is exposed in the listing summary and must be `[]` |
| Scope | `public` or `org:<id>` only. A user's own documents stay request-scoped and are never written here |
| Injection | Instruction-like lines are stripped at ingest and again when the context is built |
| Duplicates / updates | Identical content under another id is reported (`duplicate_of`), not indexed twice. Unchanged re-ingest embeds nothing |

Not done here, on purpose: the store ships **empty** (no seeded company data), there is no crawler (push-based, no outbound fetching), and the labels describe how old/official a record is - they are not a guarantee that a company's current process matches it.
