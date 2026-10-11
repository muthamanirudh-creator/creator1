# Python 3.12: torch, faiss-cpu and spaCy all publish wheels for it (3.14 wheels for the ML stack are not reliable yet).
FROM python:3.12-slim

WORKDIR /app

# Unbuffered logs show up immediately in the dashboard; no .pyc clutter in the image.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/app/.cache/huggingface \
    TOKENIZERS_PARALLELISM=false \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    MALLOC_ARENA_MAX=2

# ffmpeg: audio-prosody decoding. build-essential: any package that must compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first (cached layer): core + the transformer/embedding stack (CPU torch).
COPY requirements.txt requirements-core.txt requirements-ml.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Bake the embedding model INTO the image so a student's first request never waits for (or depends on) a download.
# The build fails if the model cannot be loaded or fails its sanity check - there is no silent fallback.
RUN python scripts/download_models.py --spacy

# Semantic matching is strict by default: no hashed bag-of-words substitute (see ALLOW_LEXICAL_FALLBACK).
ENV ALLOW_LEXICAL_FALLBACK=false \
    EMBEDDING_WARMUP=true

# Render (and most PaaS hosts) inject a PORT env var and expect the container to bind to it.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
