# Career Fit — real semantic matching (v2.7)

## What was wrong
`ai-ml-service/app/services/matcher.py` imported `sentence-transformers` inside a bare `try/except`. When the
package or model was missing, it silently switched to a hashed bag-of-words score. The Career Fit tab then showed a
"semantic" match that was really word overlap. The old `requirements.txt` also left torch / sentence-transformers out.

## What it does now
| Layer | Change |
|---|---|
| `app/services/embeddings.py` (new) | One shared transformer engine (sentence-transformers → transformers → torch). Loaded in the background at start-up, thread-safe, batch encoding, LRU vector cache, load-time self-test (paraphrase must outrank unrelated text). **Strict:** if it cannot load, semantic endpoints return `503 EMBEDDING_MODEL_UNAVAILABLE` with the reason. The lexical hash encoder only exists behind `ALLOW_LEXICAL_FALLBACK=true` and flags every result `fallback_mode: true`. |
| `matcher.py` | Requirements are judged against resume skill labels **and resume sentences** ("Experience with Docker" vs each bullet). Returns similarity, matched resume skill and the supporting sentence per skill. Whole-document similarity pools all passages instead of the first ~200 words. |
| `skill_gap.py` | Live LLM (Groq/Gemini) proposes the role's requirements; embeddings decide who has them. Output adds `partial`, per-skill `skills[]` evidence, `matching_engine`. |
| `role_catalog.py` (new) | Free-text role → nearest known role by alias, then by meaning (threshold `SEMANTIC_ROLE_THRESHOLD`). |
| `career_path.py`, `resume_ai.py`, `ai_reliability.py` | Use the same engine; career-path says explicitly when it had to be exact-name only. |
| `POST /match/role-fit`, `GET /match/engine` | Live (no-LLM, sub-second when warm) fit + engine status. |
| Career Fit tab | New **Live Semantic Match** panel: updates as you type (debounced, stale requests aborted), engine badge (model · device · self-test), per-skill evidence on hover, optional JD matching. If the engine is down it says so and why — no approximate score is shown. The Skill Gap result shows its engine and "Why? Evidence per skill"; the old local comparison is now labelled "NOT semantic". |
| Node gateway / launcher | Auth unchanged (`/api/ai-ml` still requires the signed-in session + service token). Launcher installs `requirements-ml.txt` and pre-downloads the model on first start; `/api/ai-ml-status` reports the embedding state. |

Nothing that existed was removed: Resume builder, ATS optimizer, Roadmap, Career-path predictor, Market Radar, mock
interview, adaptive quiz etc. are untouched apart from using the shared engine.

## Install / run
```bash
cd campus/ai-ml-service
python3.12 -m venv .venv && source .venv/bin/activate      # Python 3.10–3.13
pip install -r requirements.txt                              # core + torch(CPU) + transformers + sentence-transformers + faiss + spaCy
python scripts/download_models.py --spacy                    # downloads ~90 MB once, runs the sanity check
python scripts/verify_semantic.py                            # proves matching is real (prints every score)
uvicorn app.main:app --port 8000
```
Starting the portal backend (`cd backend && npm start`) does all of this automatically on first start
(disable with `AI_ML_AUTOINSTALL=false`). Docker/Render builds bake the model into the image/build.

* **Network:** huggingface.co (model) and download.pytorch.org / pypi.org (packages) once. Offline hosts: run
  `download_models.py --save-to ./models/minilm` elsewhere and set `EMBEDDING_MODEL_PATH`.
* **Hosting size:** ~1 GB RAM. A 512 MB instance will be OOM-killed → use ≥ 2 GB, or accept non-semantic matching with
  `ALLOW_LEXICAL_FALLBACK=true` (clearly flagged).
* **Tuning:** thresholds in `.env` (`SEMANTIC_*`). Defaults suit all-MiniLM-L6-v2; re-check with `verify_semantic.py`
  if you switch model (e.g. `BAAI/bge-small-en-v1.5`).

## Tests
`cd ai-ml-service && pytest tests/` — matching logic runs against a deterministic test double (`tests/_semantic_stub.py`,
reported as engine `injected`, never used in production). `npm test` in `backend/` includes `semanticCareerFit.test.js`.
