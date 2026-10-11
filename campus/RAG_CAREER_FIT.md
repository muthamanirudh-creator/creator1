# Career Fit - RAG (Ask Career Fit) - v2.7.1

A new **Ask Career Fit (RAG)** card in the Career Fit tab (between *Live Semantic Match* and *Skill Gap*). Students ask
questions in plain language and get an answer written **only from numbered passages** of (a) their own resume and
(b) the curated career knowledge base. Nothing that existed was removed or changed.

## Flow
```
question ──► embed (shared transformer engine) ──► dense cosine  ┐
         └─► BM25 keywords                                       ├─► reciprocal-rank fusion ─► MMR ─► top-k passages
resume ─► chunk (bullets/sentences, headings kept)               │            (+ role boost, + "my/I" resume boost)
KB: roadmaps + market demand + guidance (cached vectors)         ┘
top-k ─► Groq/Gemini with a "sources only, cite [n]" prompt ─► citation check ─► answer + clickable sources
```

## Honesty rules (enforced in code and covered by tests)
| Situation | Behaviour |
|---|---|
| Embedding model unavailable | HTTP 503 `EMBEDDING_MODEL_UNAVAILABLE`; the panel shows why. No hashed substitute (unless the operator set `ALLOW_LEXICAL_FALLBACK=true`, then every answer is flagged). |
| Nothing clears the evidence bar (`RAG_MIN_SIMILARITY`) | Mode `no-evidence`: the LLM is **not called**; the student is told nothing was found. |
| No LLM provider answers | Mode `extractive`: the retrieved passages are shown, labelled "AI writer unavailable". |
| LLM cites a source that does not exist | Citation stripped and reported in `warnings`. |
| LLM answer has no citations | Flagged `grounded: false` with a warning. |
| Resume contains "ignore previous instructions" | Treated as data (delimited SOURCES block + rule 5 in the system prompt). |
| Vacancies / dates / eligibility | The prompt forbids stating them; they stay with the verified Govt Jobs records. |
| Privacy | Resume/JD text is request-scoped: never stored, never shared between students. The knowledge base contains no student data. |

## API (through the authenticated gateway `/api/ai-ml/...`)
* `POST /rag/query` `{question, resume_text?, jd_text?, target_role?, scope: all|resume|knowledge, top_k?, history?[], provider?}`
  -> `{answer, mode: llm|extractive|no-evidence, grounded, sources[{n, source, title, text, similarity, keyword_score, score}], citations_used[], citation_coverage, retrieval{...}, warnings[], provider}`
* `POST /rag/retrieve` same body, retrieval only (no LLM).
* `GET /rag/status` knowledge-base size/sources, embedding engine state, retrieval settings.

## Knowledge base
Built automatically from `data/career_paths.json` (roadmap overview + one passage per milestone), `data/market_skills.json`
(skills by demand per role) and everything in `data/rag_kb/` (`.md`/`.txt` split on headings, `.json` as
`[{"title","text","roles":[...]}]`). **To teach it more, drop a file in `data/rag_kb/` and restart** - it is re-indexed
when a file changes. Set `RAG_KB_DIR` to use another folder. Keep it to evergreen guidance; do not put vacancy facts in it.

## Settings (`ai-ml-service/.env`)
`RAG_TOP_K` (6) · `RAG_MIN_SIMILARITY` (0.22) · `RAG_MAX_CONTEXT_CHARS` (6500) · `RAG_DENSE_WEIGHT` (1.0) · `RAG_LEXICAL_WEIGHT` (0.6) · `RAG_KB_DIR`.

## Verify
```bash
cd campus/ai-ml-service
pytest tests/test_rag.py                 # 22 tests: chunking, KB, retrieval, prompt hardening, citations, fallbacks, HTTP 422/503
python scripts/verify_rag.py             # REAL model: prints similarities, checks top hits + a negative control
cd ../backend && node tests/ragCareerFit.test.js     # UI/gateway wiring + "no earlier feature removed"
```
`npm test` in `backend/` now includes the RAG wiring test.

## Known limits
* The default `RAG_MIN_SIMILARITY=0.22` is calibrated for all-MiniLM-L6-v2 but was **not** measured against the real model in
  the build sandbox (no Hugging Face access) - run `verify_rag.py` once and tune it.
* The knowledge base is small (roadmaps, market demand, one guidance file). Answer quality grows with what you put in `data/rag_kb/`.
* The answer needs a Groq or Gemini key; without one the panel shows retrieved passages only.
* The vector index is in-memory (rebuilt at start, ~1 s); fine at this size, swap for FAISS/Qdrant if the KB reaches many thousands of passages.
* `campus/mainapp.js` is an older copy that `index.html` does not load; only `frontend/app-runtime.js` was changed.
