# Hybrid RAG - modified and added files (v2.8.9 -> v2.9.1, passes 1-4)

**How this list was built.** The upload contains only the final zip, not the v2.8.9 baseline, so there is no byte-level diff. Classification uses (a) file timestamps - everything from the Hybrid RAG work is dated 11 Oct 07:47 or later, everything older is untouched - and (b) the release notes of each pass. Files marked *modified* were checked by reading the Hybrid-related lines in them. If you still have the v2.8.9 zip, `diff -rq` against it is the authoritative check.

Line counts are for the file as shipped. `P1-P4` = pass in which the file first appeared or changed; **4B** = this pass.

## A. Added files

### AI/ML service (`campus/ai-ml-service/`)
| File | Lines | Purpose |
|---|---|---|
| `campus/ai-ml-service/app/rag_core/__init__.py` | 9 | package exports |
| `campus/ai-ml-service/app/rag_core/cache.py` | 44 | per-user TTL/LRU cache |
| `campus/ai-ml-service/app/rag_core/citations.py` | 51 | citation + unsupported-figure validation |
| `campus/ai-ml-service/app/rag_core/context.py` | 63 | bounded context, conflict detection |
| `campus/ai-ml-service/app/rag_core/eligibility.py` | 429 | three-valued deterministic eligibility |
| `campus/ai-ml-service/app/rag_core/evaluation.py` | 36 | Recall@K / MRR / nDCG |
| `campus/ai-ml-service/app/rag_core/filters.py` | 103 | metadata filters, access scopes, staleness |
| `campus/ai-ml-service/app/rag_core/fusion.py` | 11 | weighted RRF |
| `campus/ai-ml-service/app/rag_core/ingest.py` | 35 | record ingestion + criteria validation |
| `campus/ai-ml-service/app/rag_core/langchain_adapter.py` | 47 | optional BaseRetriever / Embeddings adapter |
| `campus/ai-ml-service/app/rag_core/lc_chain.py` | 111 | optional LCEL generation chain |
| `campus/ai-ml-service/app/rag_core/lexical.py` | 54 | BM25 tokenizer/scorer |
| `campus/ai-ml-service/app/rag_core/metrics.py` | 38 | privacy-safe counters |
| `campus/ai-ml-service/app/rag_core/models.py` | 55 | RagDocument / Candidate / authority ranks |
| `campus/ai-ml-service/app/rag_core/pipeline.py` | 266 | HybridRAG pipeline + `source_view` |
| `campus/ai-ml-service/app/rag_core/recruitment.py` | 427 | record registry, drive status, supersession |
| `campus/ai-ml-service/app/rag_core/router.py` | 57 | query routing, deterministic redirects |
| `campus/ai-ml-service/app/rag_core/security.py` | 57 | injection defence, redaction |
| `campus/ai-ml-service/app/rag_core/store.py` | 210 | HybridIndex (BM25 + dense + RRF) |

### Everything else added
| File | Lines | Purpose |
|---|---|---|
| `campus/ai-ml-service/app/routers/hybrid_rag.py` | 208 | `/rag/hybrid/*` routes (10), admin gate, request models |
| `campus/ai-ml-service/app/services/hybrid_rag.py` | 98 | process-wide singleton wiring: embeddings, LLM, KB mirror, registry |
| `campus/ai-ml-service/requirements-rag.txt` | 5 | optional `langchain-core>=0.3,<0.4` |
| `campus/ai-ml-service/scripts/eval_hybrid_rag.py` | 326 | legacy-vs-hybrid evaluation + 26 behaviour checks |
| `campus/ai-ml-service/tests/test_rag_core.py` | 303 | core: retrieval, isolation, injection, citations, abstention (27 tests, 1 skipped) |
| `campus/ai-ml-service/tests/test_rag_pass2.py` | 328 | records, freshness, eligibility (38) |
| `campus/ai-ml-service/tests/test_rag_pass3.py` | 109 | router/chunk regressions, Node payload contract, eval harness (9) |
| `campus/ai-ml-service/tests/test_rag_lc_chain.py` | 199 | LCEL chain behaviour (10, 2 need langchain-core) |
| `campus/ai-ml-service/tests/test_api_compat.py` | 376 | **4B** route/model/auth/response-shape compatibility (34) |
| `campus/ai-ml-service/tests/api_contract/ai_ml_routes.golden.json` | 81 | **4B** FastAPI route snapshot |
| `campus/ai-ml-service/tests/eval/career_cases.json` | 21 | 16 labelled career questions |
| `campus/ai-ml-service/tests/eval/node_record_payload.json` | 19 | example payload built by the Node mapper |
| `campus/backend/tests/hybridRagCore.test.js` | 37 | gateway identity/admin wiring checks |
| `lib/hybridRecords.js` | 161 | GovCareer DB -> AI-service record mapper and sync (P3) |
| `test-hybrid-records.js` | 130 | mapper + sync tests (17) |
| `test-api-compat.js` | 206 | **4B** Node route/gateway/UI-call/packaging compatibility (25 checks) |
| `tests/api-contract/node-routes.golden.json` | 229 | **4B** Node route snapshot (198 routes) |
| `campus/HYBRID_RAG.md` | 124 | technical notes per pass |
| `campus/EVALUATION_REPORT.md` | 53 | measured comparison (P3) |
| `campus/HYBRID_RAG_ARCHITECTURE_BEFORE_AFTER.md` | 108 | **4B** before/after architecture and status against the master prompt |
| `campus/HYBRID_RAG_MODIFIED_FILES.md` | 82 | **4B** this file |

## B. Modified files (everything not listed here is unchanged)
| File | Pass | What changed | Risk |
|---|---|---|---|
| `campus/backend/server.js` | P1-P2 | AI/ML gateway: strips client `x-user-id`/`x-user-role`; sets them from the verified JWT (role only for ADMIN) | Low - headers only; checked by both 4B suites |
| `campus/ai-ml-service/app/main.py` | P1 | imports and mounts `hybrid_rag.router` (one import, one `include_router`) | Low |
| `campus/ai-ml-service/app/config.py` | P1-P3 | 8 `HYBRID_RAG_*` settings with safe defaults | Low |
| `campus/ai-ml-service/.env.example` | P1-P3 | documents the `HYBRID_RAG_*` settings (placeholders) | None |
| `.env.example` | P3 | documents `HYBRID_RAG_SYNC_MINUTES` (default 0 = off), `_TIMEOUT_MS`, `_BATCH` | None |
| `package.json` | P3, 4B | scripts `hybrid:sync`, `test:hybrid`, `test:apicompat`, `test:apicompat:update`; `test` chain now ends with the two hybrid suites | Low |
| `campus/backend/package.json` | P1 | `hybridRagCore.test.js` added to the test chain | None |
| `routes/admin.js` | P3 | `POST /hybrid-rag/sync` (ADMIN, audited) | Low - one new route |
| `lib/scheduler.js` | P3 | optional sync task, off unless `HYBRID_RAG_SYNC_MINUTES>0` (leader only) | Low |
| `public/app.js` | 4A | eligibility drawer: opt-in "Check against the notice text" section; existing analysis untouched | Medium - UI; browser-tested in 4A |
| `public/styles.css` | 4A | styles for that section | Low |
| `campus/frontend/app-runtime.js` | 4A | Career Fit panel: 4th chip "Govt notices", source cards, relevance label wording; original 3 scopes still call `/rag/query` | Medium - 30k-line file; checked by 4B and 4A browser tests |
| `public/sw.js` | **4B** | cache name `govcareer-shell-v18` -> `v19` (without it returning users keep the old UI) | Low - forces one cache refresh |
| `campus/frontend/index.html` | **4B** | `app-runtime.js?v=gc-officialletter2` -> `...-hrag` (same reason) | Low |
| `test-govcareer-subtab.js` | **4B** | one assertion: service-worker pin `v18` -> `v19` (no behaviour check removed) | None |
| `RELEASE_NOTES.md` | P1-P4, 4B | entries added at the top | None |
| `campus/HYBRID_RAG.md` | 4B | header + Pass 4B section | None |

## C. Deliberately not touched
`lib/answer.js`, `claims.js`, `eligibility.js`, `search.js` and `/api/assistant/*` (existing grounded assistant and structured eligibility); `campus/ai-ml-service/app/services/rag.py` and `routers/rag.py` (legacy Career Fit RAG); all migrations in `db/migrations`; Dockerfiles, `render.yaml`, compose files; every other tab, route and test. No database migration was added: the shared index is in memory.

## D. Test suites that run offline (no `express`/`pg`/`torch`/`httpx`)
Root Node: 17 suites. Campus backend: 27 suites. Python: `test_rag_core`, `test_rag_pass2`, `test_rag_pass3`, `test_rag_lc_chain`, `test_api_compat`, plus `scripts/eval_hybrid_rag.py`. Not runnable here: `test-account.js` (needs `express`), `test-phase2.js` (needs `pg`), four campus suites needing `bcryptjs`/`dotenv`/`express`, and the pytest/FastAPI HTTP tests.
