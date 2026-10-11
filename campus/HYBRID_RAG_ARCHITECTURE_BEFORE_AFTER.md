# Hybrid RAG - architecture before and after (v2.8.9 -> v2.9.1, passes 1-4)

Scope: what the Hybrid RAG upgrade changed, what it deliberately did **not** touch, and where it still falls short of the
master prompt. Everything here was checked against the source in this zip; where something could not be run in the build
sandbox it says so.

## 1. Before (v2.8.9)

```
Browser
 |- GovCareer UI (public/*)  ---- /api/assistant/ask ----> lib/answer.js + claims.js + answerAudit.js
 |                                  (structured-record answers; every figure re-verified against a typed field; 409 on a failed audit)
 |                          ---- eligibility drawer ------> lib/eligibility.js (deterministic rules on STRUCTURED job fields)
 |
 |- Campus UI (campus/frontend/app-runtime.js)
      |- Career Fit "Ask" panel --- /api/ai-ml/rag/query ---> Express gateway (auth) ---> FastAPI /rag/query
                                                                  services/rag.py: resume + curated career KB, in memory,
                                                                  BM25 + transformer embeddings -> RRF -> MMR, [n] citations,
                                                                  no evidence => LLM not called
```

* Two separate "grounding" mechanisms, neither shared: Node structured-claim audit for recruitment records, Python RAG for
  Career Fit only.
* No retrieval over the text of official notices. Eligibility was decided only from structured fields.
* The AI service had no notion of drive status, source freshness, supersession, per-user scopes or a record registry.

## 2. After (v2.9.1)

```
Browser
 |- GovCareer UI
 |    |- /api/assistant/ask  ................................. UNCHANGED (still lib/answer.js)
 |    |- eligibility drawer: existing "Eligibility analysis" ... UNCHANGED
 |    |     + NEW opt-in section "Check against the notice text" --- /api/ai-ml/rag/hybrid/eligibility
 |
 |- Campus UI
      |- Career Fit "Ask": scopes all / resume / knowledge ..... UNCHANGED  -> /rag/query (legacy service)
      |     + NEW scope chip "Govt notices" (no resume sent) ---- /rag/hybrid/query  {domain: "government"}

Express gateway /api/ai-ml/*  (requireAuth)
   sets x-user-id and x-user-role ONLY from the verified JWT; strips any client-sent value

FastAPI
 |- /rag/*            legacy Career Fit RAG                    (unchanged; does not import the hybrid core)
 |- /rag/hybrid/*     NEW router -> services/hybrid_rag.py -> app/rag_core/ (shared core)
                           router.py     intent + domain; deterministic operations are redirected, never sent to an LLM
                           filters.py    hard metadata filters + access scopes (public / user:<id> / org:<id>) + staleness
                           store.py      HybridIndex: BM25 + dense vectors -> weighted RRF; exact-identifier match; dedupe; embedding cache
                           context.py    bounded, source-numbered context; conflicts between sources of one record
                           pipeline.py   validate -> route -> retrieve -> context -> generate -> citation/figure validation -> abstain/extractive
                           security.py   injection-line stripping, delimiter neutralising, log redaction
                           citations.py  invalid [n] stripped; sentences with figures/dates absent from the cited source removed
                           recruitment.py RecordRegistry: drive status active/upcoming/closed/unverified/inaccessible, supersession, conflicts
                           eligibility.py three-valued, code-decided verdicts with verbatim notice quotes
                           lc_chain.py   optional LangChain LCEL generation step (falls back to the direct provider call)

Node GovCareer DB --lib/hybridRecords.js (admin button / npm run hybrid:sync / optional scheduler task)--> POST /rag/hybrid/records
   real published notices only; freshness = the source's own last successful crawl; archived records are removed from the index
```

## 3. Compatibility guarantees and how each is enforced

| Guarantee | Enforced by |
|---|---|
| No existing route removed/renamed (198 Node routes, all FastAPI routes) | `test-api-compat.js`, `tests/test_api_compat.py` (golden route snapshots) |
| The only Node route added is `POST /api/admin/hybrid-rag/sync` (ADMIN + audited) | `test-api-compat.js` |
| Legacy `/rag/query|retrieve|status` request and response shapes unchanged | `test_api_compat.py` (real legacy engine, stub LLM) |
| New request models need only `question` / `record_id+organization+role`; unsafe defaults impossible (`authority=third_party`, `extraction_status=auto_extracted`, `include_stale=false`) | `test_api_compat.py` |
| Source cards only **add** `drive_status`, `advt_no`, `record_id`; `status` keeps its old meaning | `test_api_compat.py` |
| Caller identity only from the gateway header; admin routes fail closed | `test_api_compat.py`, `test-api-compat.js` |
| Older AI builds are not reported "incomplete" (hybrid routes are not in the readiness list; the Node fallback never fakes hybrid answers) | `test-api-compat.js` |
| No new tab / nav item / duplicate chatbot | `test-api-compat.js` (7 GovCareer views in order; Campus tab ids identical to the untouched `mainapp.js`), `test-govcareer-subtab.js` |
| Scheduled sync off by default; env templates hold placeholders only | `test-api-compat.js`, `test_api_compat.py` |

## 4. A defect found and fixed in this pass

Pass 4A changed `public/app.js`, `public/styles.css` and `campus/frontend/app-runtime.js`, but the service worker
(`govcareer-shell-v18`) serves static files **cache-first**, and the Campus `index.html` still loaded
`app-runtime.js?v=gc-officialletter2`. Returning users would have kept the old UI and never seen the new source cards or
eligibility section. Fixed: `govcareer-shell-v19`, token `gc-officialletter2-hrag` (the prefix is kept because
`gatePassHandwrittenLetter.test.js` pins it), and `test-govcareer-subtab.js` now pins v19. The compatibility suite fails if
this is forgotten again.

## 5. Status against the master prompt (honest)

| Prompt requirement | Status |
|---|---|
| Shared, modular Hybrid RAG (BM25 + vectors + metadata filters + RRF, dedupe, token budget, citations, abstention, routing, cache, metrics) | **Done** - `app/rag_core/`, tested with a deterministic embedding stand-in |
| LangChain | **Partly.** Generation step is an LCEL chain and there is a `BaseRetriever`/`Embeddings` adapter, both optional. **Never executed against the real package here** (no package index in the sandbox) |
| Deterministic eligibility (satisfied / not satisfied / unknown, rule + source + reason) | **Done** for criteria found in notice text; criteria not extracted are listed, not assumed absent |
| Government notices: dates, change detection, supersession, expired flags, never invent | **Done** for records pushed from the DB; drive status recomputed on read |
| Prompt-injection defence, user isolation, redaction | **Done** in the core; tested |
| Source cards, last-verified dates, loading/empty/error states in existing screens | **Done** (pass 4A) for Career Fit "Govt notices" and the eligibility drawer |
| Cross-encoder reranking | **Not active.** The `rerank` request flag and hook exist, but no reranker is wired in `services/hybrid_rag.py`, so `rerank: true` has no effect |
| pgvector / persistent vector store / migrations for RAG tables | **Not done.** The index is in memory (rebuilt from the KB at start; recruitment records need a re-sync after every AI-service restart unless `HYBRID_RAG_RECORDS_PATH` points at a persistent disk). No RAG migration was added |
| Background ingestion workers, retries/dead-letter, OCR | **Not done in the AI service.** Records are pushed from the existing Node crawler/DB (which already does OCR fallback and retries); the AI service does no fetching by design |
| Private-sector, exam, learning, resume-to-JD retrieval | **Not done** beyond the existing curated career KB. `domain` values exist, but no such documents are indexed |
| Hybrid RAG behind the GovCareer chatbot `/api/assistant/ask` | **Deliberately not done.** That path already audits every figure against structured fields; replacing it would risk the guarantees it has. Hybrid RAG is reachable from Career Fit and the eligibility drawer |
| Circuit breakers | Timeout + retry in the core; provider-level resilience is the existing `llm_providers` behaviour. No separate breaker was added |
| Performance / concurrency tests, cost measurement | **Not done** |
| Measured improvement over baseline | **Not demonstrated.** With the stand-in embedder the legacy and hybrid pipelines tie on retrieval (Recall@5 1.0, MRR 0.906, 16 questions). No claim of improvement is made |

## 6. Things to do before relying on it

1. `npm ci && npm run test:db:setup && npm test`; `cd campus/ai-ml-service && pip install -r requirements.txt -r requirements-rag.txt && python3 -I tests/test_rag_lc_chain.py && pytest`.
2. Set `HYBRID_RAG_SYNC_MINUTES=30` (and `HYBRID_RAG_RECORDS_PATH` on persistent storage) - otherwise "Govt notices" abstains after every AI-service restart until an admin presses sync.
3. Measure `HYBRID_RAG_MIN_RELEVANCE` with the real embedding model (`scripts/eval_hybrid_rag.py`, `scripts/verify_rag.py`).
4. Legal/UX review of the drive-status wording and the eligibility consent text.
