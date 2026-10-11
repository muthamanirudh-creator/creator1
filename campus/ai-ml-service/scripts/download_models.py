#!/usr/bin/env python
"""Download (once) and verify the embedding model so the service never has to fetch it while serving a student.

    python scripts/download_models.py                 # default model from EMBEDDING_MODEL / .env
    python scripts/download_models.py --model sentence-transformers/all-mpnet-base-v2
    python scripts/download_models.py --save-to ./models/minilm    # then set EMBEDDING_MODEL_PATH=./models/minilm

Exit code 0 only when the model loaded AND passed the paraphrase-vs-unrelated sanity check.
Needs network access to huggingface.co the FIRST time only (or a pre-populated HF cache / --save-to folder).
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=None, help="hub id or local path (default: EMBEDDING_MODEL_PATH or EMBEDDING_MODEL)")
    ap.add_argument("--save-to", default=None, help="also save a self-contained copy of the model to this folder")
    ap.add_argument("--spacy", action="store_true", help="also verify the spaCy en_core_web_sm pipeline is installed")
    args = ap.parse_args()
    if args.model:
        os.environ["EMBEDDING_MODEL"] = args.model
        os.environ.pop("EMBEDDING_MODEL_PATH", None)
    os.environ["ALLOW_LEXICAL_FALLBACK"] = "false"      # this script must fail loudly, never pass on a substitute

    try:
        import torch  # noqa: F401
        import transformers
        import sentence_transformers
    except ImportError as exc:
        print(f"FAIL  missing package: {exc.name}.  Run:  pip install -r requirements.txt", file=sys.stderr)
        return 2
    print(f"torch {torch.__version__} | transformers {transformers.__version__} | sentence-transformers {sentence_transformers.__version__}")

    from app.config import get_settings
    from app.services.embeddings import EmbeddingUnavailable, get_engine

    s = get_settings()
    print(f"Model: {s.EMBEDDING_MODEL_PATH or s.EMBEDDING_MODEL}   (downloads ~90 MB the first time)")
    started = time.time()
    engine = get_engine()
    try:
        engine.ensure_ready(timeout=1800)
    except EmbeddingUnavailable as exc:
        print(f"FAIL  {exc}", file=sys.stderr)
        return 1
    # Drop null fields (e.g. error: null) so build logs are not highlighted as errors by log viewers.
    print(json.dumps({k: v for k, v in engine.status().items() if v is not None}, indent=2, default=str))
    print(f"OK    model ready in {time.time() - started:.1f}s")

    if args.save_to:
        from sentence_transformers import SentenceTransformer
        dest = Path(args.save_to).resolve()
        SentenceTransformer(s.EMBEDDING_MODEL_PATH or s.EMBEDDING_MODEL, device="cpu").save(str(dest))
        print(f"OK    saved a local copy to {dest}   ->   EMBEDDING_MODEL_PATH={dest}")

    if args.spacy:
        try:
            import spacy
            spacy.load("en_core_web_sm")
            print("OK    spaCy en_core_web_sm is installed")
        except Exception as exc:  # noqa: BLE001
            print(f"WARN  spaCy pipeline missing ({exc}). Run: python -m spacy download en_core_web_sm", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
