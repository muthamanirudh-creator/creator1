"""Installs the deterministic embedding TEST DOUBLE before every test (no model download / network needed).

Tests that exercise strict mode or an unavailable model reset the engine themselves and call
``_semantic_stub.install()`` again in a ``finally`` block.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _semantic_stub  # noqa: E402

_semantic_stub.install()

try:                                     # real pytest: re-install around every test so a reset can never leak
    import pytest

    @pytest.fixture(autouse=True)
    def _embedding_test_double():
        _semantic_stub.install()
        yield
        _semantic_stub.install()
except Exception:                         # pragma: no cover - plain runners import this module for its side effect
    pass
