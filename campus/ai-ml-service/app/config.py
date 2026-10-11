"""
Central configuration for the AI/ML Intelligence Service.

Every value has a safe default so the service boots even with an empty
.env, but AI-backed endpoints will clearly report which provider key is
missing rather than failing silently.
"""
import os
from contextvars import ContextVar
from functools import lru_cache

try:
    from dotenv import load_dotenv
    load_dotenv()
    _DOTENV_LOADED = True
except ImportError:
    # python-dotenv is a dev convenience; the service still works if the
    # real environment variables are injected by the host (Docker, Render, etc).
    # BUGFIX: this used to fail silently, which meant a developer with keys sitting
    # in .env but no dotenv package installed would see the startup warning claim
    # "no LLM provider key configured" with no clue why. main.py now surfaces this
    # explicitly via settings.DOTENV_LOADED.
    _DOTENV_LOADED = False


def _bool(name: str, default: bool) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(str(os.getenv(name, default)).strip())
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    # FIX: `float(os.getenv(...))` raised ValueError at import time on a typo'd value and the whole
    # service refused to boot. Fall back to the default instead.
    try:
        return float(str(os.getenv(name, default)).strip())
    except (TypeError, ValueError):
        return default


class Settings:
    # --- Service ---
    DOTENV_LOADED: bool = _DOTENV_LOADED
    SERVICE_NAME: str = "campus-ai-ml-service"
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = _int("PORT", 8000)
    ENV: str = os.getenv("ENV", "development")
    CORS_ORIGINS: list = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

    # --- LLM providers (mirrors backend/server.js so the same keys can be reused) ---
    # Groq is tried first; if it fails (missing key, error, timeout, rate limit, etc.) the
    # request automatically shifts to Gemini. Override via env.
    AI_PROVIDER_ORDER: list = [p.strip() for p in os.getenv("AI_PROVIDER_ORDER", "groq,gemini").split(",") if p.strip()]
    # .strip() guards against copy-pasted keys picking up stray quotes/whitespace from .env,
    # which otherwise surfaces as a confusing "invalid authentication credentials" error.
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "").strip()
    # llama-3.3-70b-versatile was decommissioned by Groq (Aug 16, 2026).
    # Recommended replacement: openai/gpt-oss-120b. https://console.groq.com/docs/deprecations
    GROQ_MODEL: str = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "").strip()
    GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-flash-latest")

    AI_REQUEST_TIMEOUT_S: int = _int("AI_REQUEST_TIMEOUT_S", 30)
    AI_MAX_RETRIES: int = _int("AI_MAX_RETRIES", 2)
    # FIX: the Express gateway (and Vercel's 60 s function limit) gives one AI/ML call ~45-55 s in total, but a
    # single call_llm() could previously run 30 s x 3 attempts x 2 providers = 180 s, so the portal showed
    # "AI/ML service unavailable" instead of receiving the offline fallback. call_llm() now stops at this
    # overall deadline (seconds) and lets every caller fall back gracefully.
    AI_TOTAL_DEADLINE_S: int = _int("AI_TOTAL_DEADLINE_S", 38)
    LLM_CACHE_MAX_ENTRIES: int = _int("LLM_CACHE_MAX_ENTRIES", 256)
    # User-facing AI/ML results must be live model generations, not previously stored prompt responses.
    # Set AI_DISABLE_RESPONSE_CACHE=false only if an operator explicitly wants response caching.
    AI_DISABLE_RESPONSE_CACHE: bool = _bool("AI_DISABLE_RESPONSE_CACHE", True)

    # --- Whisper (speech-to-text for mock interviews) ---
    WHISPER_PROVIDER: str = os.getenv("WHISPER_PROVIDER", "groq")  # groq | local
    WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "whisper-large-v3")  # Groq-hosted Whisper model id
    LOCAL_WHISPER_MODEL_SIZE: str = os.getenv("LOCAL_WHISPER_MODEL_SIZE", "base")

    # --- Vector store / semantic matching ---
    VECTOR_BACKEND: str = os.getenv("VECTOR_BACKEND", "faiss")  # faiss | qdrant | pinecone
    EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    # Optional local folder that already contains the model (air-gapped / pre-baked deployments). Wins over the hub name.
    EMBEDDING_MODEL_PATH: str = os.getenv("EMBEDDING_MODEL_PATH", "").strip()
    # Only used to size the emergency lexical vectors (see ALLOW_LEXICAL_FALLBACK); the real model reports its own size.
    EMBEDDING_DIM: int = _int("EMBEDDING_DIM", 384)
    EMBEDDING_DEVICE: str = os.getenv("EMBEDDING_DEVICE", "auto").strip().lower()    # auto | cpu | cuda | mps
    EMBEDDING_BATCH_SIZE: int = _int("EMBEDDING_BATCH_SIZE", 32)
    EMBEDDING_CACHE_SIZE: int = _int("EMBEDDING_CACHE_SIZE", 8192)                   # vectors kept in the LRU
    EMBEDDING_THREADS: int = _int("EMBEDDING_THREADS", 0)                            # 0 = torch default
    EMBEDDING_LOAD_TIMEOUT_S: int = _int("EMBEDDING_LOAD_TIMEOUT_S", 300)            # how long a request waits for the first load
    # Load the model at start-up (in the background) so the first student request never pays the load cost.
    EMBEDDING_WARMUP: bool = _bool("EMBEDDING_WARMUP", True)
    # STRICT by default: if the transformer model cannot be loaded, semantic endpoints answer 503
    # EMBEDDING_MODEL_UNAVAILABLE instead of silently degrading to a hashed bag-of-words score.
    # Set ALLOW_LEXICAL_FALLBACK=true ONLY on hosts too small for torch (every response is then flagged fallback_mode).
    ALLOW_LEXICAL_FALLBACK: bool = _bool("ALLOW_LEXICAL_FALLBACK", False)
    # Calibration of the semantic skill matcher (cosine similarity of normalised sentence embeddings).
    SEMANTIC_STRONG_THRESHOLD: float = _float("SEMANTIC_STRONG_THRESHOLD", 0.75)     # skill label ~ skill label: "has it"
    SEMANTIC_PARTIAL_THRESHOLD: float = _float("SEMANTIC_PARTIAL_THRESHOLD", 0.55)   # related / transferable
    SEMANTIC_PASSAGE_MATCH: float = _float("SEMANTIC_PASSAGE_MATCH", 0.55)           # "experience with X" ~ resume sentence
    SEMANTIC_PASSAGE_PARTIAL: float = _float("SEMANTIC_PASSAGE_PARTIAL", 0.40)
    SEMANTIC_ROLE_THRESHOLD: float = _float("SEMANTIC_ROLE_THRESHOLD", 0.60)         # free-text role -> known role
    # --- Career Fit RAG (retrieval-augmented answers grounded in the resume + the curated career knowledge base) ---
    RAG_TOP_K: int = _int("RAG_TOP_K", 6)                                            # passages handed to the LLM
    RAG_MIN_SIMILARITY: float = _float("RAG_MIN_SIMILARITY", 0.22)                   # below this cosine a passage is not evidence
    RAG_MAX_CONTEXT_CHARS: int = _int("RAG_MAX_CONTEXT_CHARS", 6500)                 # budget for the retrieved context block
    RAG_RRF_K: int = _int("RAG_RRF_K", 60)                                           # reciprocal-rank-fusion constant
    RAG_DENSE_WEIGHT: float = _float("RAG_DENSE_WEIGHT", 1.0)                        # weight of the embedding ranking in the fusion
    RAG_LEXICAL_WEIGHT: float = _float("RAG_LEXICAL_WEIGHT", 0.6)                    # weight of the keyword (BM25) ranking in the fusion
    RAG_KB_DIR: str = os.getenv("RAG_KB_DIR", "").strip()                            # extra .md/.txt/.json knowledge files (default: data/rag_kb)
    # --- Shared Hybrid RAG core (app/rag_core) ---
    HYBRID_RAG_MIN_RELEVANCE: float = _float("HYBRID_RAG_MIN_RELEVANCE", 0.30)       # best-candidate cosine below this -> abstain (exact-ID/keyword hits exempt)
    HYBRID_RAG_CACHE_TTL_SECONDS: float = _float("HYBRID_RAG_CACHE_TTL_SECONDS", 300.0)   # per-user answer cache lifetime
    HYBRID_RAG_LLM_TIMEOUT_SECONDS: float = _float("HYBRID_RAG_LLM_TIMEOUT_SECONDS", 30.0)
    HYBRID_RAG_ALLOW_UNVERIFIED_FACTS: bool = _bool("HYBRID_RAG_ALLOW_UNVERIFIED_FACTS", False)   # allow recruitment answers with no official source (not recommended)
    HYBRID_RAG_MAX_VERIFICATION_AGE_DAYS: int = int(_float("HYBRID_RAG_MAX_VERIFICATION_AGE_DAYS", 7))   # older verification => drive shown as 'unverified', never 'active'
    HYBRID_RAG_OFFICIAL_DOMAINS: str = os.getenv("HYBRID_RAG_OFFICIAL_DOMAINS", "")                   # extra official suffixes, comma separated (gov.in / nic.in are built in)
    HYBRID_RAG_USE_LANGCHAIN: str = os.getenv("HYBRID_RAG_USE_LANGCHAIN", "auto").strip().lower()      # off | auto | on  (LCEL orchestration of the generation step)
    HYBRID_RAG_RECORDS_PATH: str = os.getenv("HYBRID_RAG_RECORDS_PATH", "")                           # JSON snapshot of PUBLIC recruitment records; blank = ./data/hybrid_rag/records.json (only durable if that folder is on persistent storage)
    HYBRID_RAG_VECTORS_PATH: str = os.getenv("HYBRID_RAG_VECTORS_PATH", "")                           # .npz cache of chunk embeddings (avoids re-embedding after restart); blank = next to the records snapshot
    HYBRID_RAG_KNOWLEDGE_PATH: str = os.getenv("HYBRID_RAG_KNOWLEDGE_PATH", "")                     # Pass B: JSON snapshot of PUBLIC private/exam/learning/career documents; blank = next to the records snapshot
    HYBRID_RAG_ANSWER_KEYS_PATH: str = os.getenv("HYBRID_RAG_ANSWER_KEYS_PATH", "")                 # Pass B: answer-key vault file (kept OUT of the shared index, mode 0600); blank = next to the knowledge snapshot
    HYBRID_RAG_KNOWLEDGE_DIR: str = os.getenv("HYBRID_RAG_KNOWLEDGE_DIR", "")                       # Pass B: optional folder of *.json knowledge items loaded at start-up
    HYBRID_RAG_HIRING_WINDOW_DAYS: int = int(_float("HYBRID_RAG_HIRING_WINDOW_DAYS", 365))           # Pass B: private-sector hiring info older than this is labelled "historical"
    HYBRID_RAG_EXAM_WINDOW_DAYS: int = int(_float("HYBRID_RAG_EXAM_WINDOW_DAYS", 730))              # Pass B: exam pattern/syllabus/cutoff info older than this is labelled "historical"
    HYBRID_RAG_RERANKER: str = os.getenv("HYBRID_RAG_RERANKER", "auto").strip().lower()                # off | lexical | cross-encoder | auto (cross-encoder if sentence-transformers is installed, else lexical)
    HYBRID_RAG_RERANKER_MODEL: str = os.getenv("HYBRID_RAG_RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
    FAISS_INDEX_PATH: str = os.getenv("FAISS_INDEX_PATH", "./data/faiss_index")
    QDRANT_URL: str = os.getenv("QDRANT_URL", "http://localhost:6333")
    QDRANT_API_KEY: str = os.getenv("QDRANT_API_KEY", "")
    QDRANT_COLLECTION: str = os.getenv("QDRANT_COLLECTION", "campus_skills")
    PINECONE_API_KEY: str = os.getenv("PINECONE_API_KEY", "")
    PINECONE_ENV: str = os.getenv("PINECONE_ENV", "")
    PINECONE_INDEX: str = os.getenv("PINECONE_INDEX", "campus-skills")

    # --- Caching / limits ---
    CACHE_TTL_S: int = _int("CACHE_TTL_S", 600)
    MAX_UPLOAD_MB: int = _int("MAX_UPLOAD_MB", 10)
    MAX_PROMPT_CHARS: int = _int("MAX_PROMPT_CHARS", 24000)

    # --- Postgres (optional persistence for parsed profiles / roadmaps) ---
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")  # e.g. postgresql://user:pass@host/db — leave blank to run in-memory only

    # --- Privacy ---
    PII_REDACTION: bool = _bool("PII_REDACTION_ENABLED", True)
    DATA_RETENTION_DAYS: int = _int("DATA_RETENTION_DAYS", 30)

    # --- Adaptive Skill Diagnostic Engine ---
    ADAPTIVE_MAX_QUESTIONS: int = _int("ADAPTIVE_MAX_QUESTIONS", 12)
    ADAPTIVE_MIN_QUESTIONS: int = _int("ADAPTIVE_MIN_QUESTIONS", 5)
    ADAPTIVE_SE_THRESHOLD: float = _float("ADAPTIVE_SE_THRESHOLD", 0.45)  # stop early once this precise
    ADAPTIVE_SESSION_TTL_S: int = _int("ADAPTIVE_SESSION_TTL_S", 3600)
    # Upper bound on live in-memory sessions (adaptive + interview each) so a 512 MB free-tier host can't be
    # exhausted; the oldest sessions are evicted first.
    SESSION_MAX_ENTRIES: int = _int("SESSION_MAX_ENTRIES", 500)

    # --- AI Mock Interviewer — NLP / speech analysis ---
    INTERVIEW_SESSION_TTL_S: int = _int("INTERVIEW_SESSION_TTL_S", 3600)
    INTERVIEW_MAX_FOLLOWUPS: int = _int("INTERVIEW_MAX_FOLLOWUPS", 4)
    # Bounds for the optional audio/video analysis (keeps CPU + RAM predictable on small hosts).
    ANALYSIS_MAX_AUDIO_S: int = _int("ANALYSIS_MAX_AUDIO_S", 180)
    ANALYSIS_MAX_VIDEO_FRAMES: int = _int("ANALYSIS_MAX_VIDEO_FRAMES", 240)

    # --- Skill Gap & Market Intelligence Radar ---
    # Live job-market data is optional. Without keys, the radar runs entirely off the curated
    # dataset in data/market_skills.json (refreshed by hand / by a scheduled job you control),
    # so the feature always works offline/in a judging room with zero external calls.
    # BUGFIX: this used to require BOTH the provider name AND its key(s) to be set
    # separately (MARKET_LIVE_PROVIDER=adzuna *and* ADZUNA_APP_ID/KEY), so a developer
    # who only added API keys — the natural thing to do — still got the offline/cached
    # radar with no indication why, i.e. "not truly live by default". MARKET_LIVE_PROVIDER
    # can still be set explicitly to force/override a choice, but now defaults to
    # auto-detecting from whichever keys are actually present (Adzuna preferred, since it
    # has a free tier with no per-request cost).
    ADZUNA_APP_ID: str = os.getenv("ADZUNA_APP_ID", "")
    ADZUNA_APP_KEY: str = os.getenv("ADZUNA_APP_KEY", "")
    ADZUNA_COUNTRY: str = os.getenv("ADZUNA_COUNTRY", "in")
    JSEARCH_RAPIDAPI_KEY: str = os.getenv("JSEARCH_RAPIDAPI_KEY", "")

    @property
    def MARKET_LIVE_PROVIDER(self) -> str:  # "" | "adzuna" | "jsearch"
        explicit = os.getenv("MARKET_LIVE_PROVIDER", "").strip().lower()
        if explicit:
            return explicit
        if self.ADZUNA_APP_ID and self.ADZUNA_APP_KEY:
            return "adzuna"
        if self.JSEARCH_RAPIDAPI_KEY:
            return "jsearch"
        return ""
    MARKET_CACHE_TTL_S: int = _int("MARKET_CACHE_TTL_S", 21600)  # 6h — live results cached this long
    MARKET_DATA_PATH: str = os.getenv("MARKET_DATA_PATH", "./data/market_skills.json")

    # --- Trusted backend gateway ---
    # BUGFIX: this was previously a *module-level* variable declared outside the Settings
    # class, so `settings.AI_SERVICE_TOKEN` (settings = get_settings() = a Settings
    # instance) raised AttributeError on every single request that went through the
    # `trusted_backend_only` middleware in main.py (i.e. every route except /health,
    # /docs, /openapi.json, /redoc) — which the global exception handler turned into a
    # generic {"error": "Internal server error"} on literally every AI/ML call. Moved
    # inside the class so it's a real attribute of the Settings instance main.py reads.
    AI_SERVICE_TOKEN: str = os.getenv("AI_ML_SERVICE_TOKEN", "").strip()


@lru_cache
def get_settings() -> "Settings":
    return Settings()


# ---------------------------------------------------------------------------
# Request-scoped provider overrides.
# The Express gateway forwards the keys an Admin pasted into the portal
# (Admin -> Settings -> AI Keys & Services) as x-groq-key / x-gemini-key headers on every call, so the
# keys work immediately without editing ai-ml-service/.env or restarting this service.
# These only ever apply to the request that carried them (ContextVar) and are only read AFTER the
# shared service token has been verified in main.py.
# ---------------------------------------------------------------------------
_KEY_OVERRIDES: ContextVar[dict] = ContextVar("llm_key_overrides", default={})


def set_key_overrides(overrides: dict):
    clean = {k: str(v).strip() for k, v in (overrides or {}).items() if v and str(v).strip()}
    return _KEY_OVERRIDES.set(clean)


def get_key(provider: str) -> str:
    """Effective API key for `provider` ('groq' | 'gemini'): request override first, then .env."""
    settings = get_settings()
    override = _KEY_OVERRIDES.get().get(f"{provider}_key")
    if override:
        return override
    return {"groq": settings.GROQ_API_KEY, "gemini": settings.GEMINI_API_KEY}.get(provider, "")


def get_model(provider: str) -> str:
    settings = get_settings()
    override = _KEY_OVERRIDES.get().get(f"{provider}_model")
    if override:
        return override
    return {"groq": settings.GROQ_MODEL, "gemini": settings.GEMINI_MODEL}.get(provider, "")
