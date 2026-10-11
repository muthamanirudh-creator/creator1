"""LangChain Expression Language (LCEL) orchestration for the grounded-generation step (pass 3).

Where LangChain genuinely helps here, it is used: the system/human messages are built by `ChatPromptTemplate` and run
through a `RunnableSequence` (prompt | to-text | provider call). Everything that makes the answer *safe* stays in this
project's own code and is NOT delegated: retrieval + RRF + filters, context assembly, injection stripping, citation
validation, abstention, drive status and eligibility. The existing provider layer (`call_llm`: Groq/Gemini fallback,
retries, deadline, cache bypass) is reused unchanged as the chain's last step, so no provider was replaced.

Modes (`HYBRID_RAG_USE_LANGCHAIN`):
  off   never use LangChain; the native path runs.
  auto  (default) use it when `langchain_core` imports and builds, else native. Fully transparent in the result
        (`orchestration` = "langchain-lcel" | "native").
  on    require it: raise at start-up if `langchain_core` is missing (so a deployment cannot silently lose it).

Failure rule: an error raised BY the provider call is re-raised unchanged (the pipeline's retry/extractive fallback
handles it exactly as before, and the provider is never called twice for one attempt). An error raised by LangChain
itself (interface drift, template error) falls back to calling the provider directly, and is counted in
`langchain_fallback`. LangChain can therefore never turn a working answer into a failure, and never hides one.

NOT EXECUTED against the real package in the build sandbox (no package index access). `tests/test_rag_lc_chain.py`
checks this wiring with a minimal stand-in, and runs `LangChainRealTests` automatically when langchain_core is installed.
"""
from __future__ import annotations

import logging
from typing import Awaitable, Callable

from .metrics import METRICS

logger = logging.getLogger("ai_ml_service.rag_lc")

Generator = Callable[[str, str], Awaitable[dict]]
MODES = ("off", "auto", "on")


class LangChainRequired(RuntimeError):
    """HYBRID_RAG_USE_LANGCHAIN=on but langchain_core is not importable."""


def langchain_importable() -> bool:
    try:
        import langchain_core  # noqa: F401
        return True
    except Exception:                                   # noqa: BLE001
        return False


def normalise_mode(value: str | None) -> str:
    v = (value or "auto").strip().lower()
    return v if v in MODES else "auto"


def build_chain(call_provider: Generator, holder: dict):
    """prompt | messages->(system,user) | provider.  Raises if langchain_core cannot build it."""
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.runnables import RunnableLambda

    # Variables are substituted AFTER template parsing, so braces inside sources/questions are plain text.
    prompt = ChatPromptTemplate.from_messages([("system", "{system}"), ("human", "{user}")])

    def to_texts(prompt_value) -> tuple[str, str]:
        msgs = prompt_value.to_messages()
        return str(msgs[0].content), str(msgs[1].content)

    async def provider_step(pair: tuple[str, str]) -> dict:
        try:
            return await call_provider(pair[0], pair[1])
        except BaseException as exc:                    # noqa: BLE001 - remember it so the wrapper can tell provider errors from LangChain errors
            holder["provider_error"] = exc
            raise

    return prompt | RunnableLambda(to_texts) | RunnableLambda(provider_step)


def wrap_generator(call_provider: Generator, *, mode: str = "auto") -> tuple[Generator, str]:
    """Returns (generator, orchestration_label). The returned generator has the same (system, user) -> dict contract."""
    mode = normalise_mode(mode)
    if mode == "off":
        return call_provider, "native"
    if not langchain_importable():
        if mode == "on":
            raise LangChainRequired("HYBRID_RAG_USE_LANGCHAIN=on but langchain_core is not installed (pip install -r requirements-rag.txt).")
        return call_provider, "native"

    state: dict = {"chain": None, "broken": False}

    async def generate(system: str, user: str) -> dict:
        if state["broken"]:
            return await call_provider(system, user)
        try:
            if state["chain"] is None:
                holder: dict = {}
                state["chain"] = build_chain(call_provider, holder)
                state["holder"] = holder
            state["holder"].clear()                     # the chain's provider step reports into this dict; reset per call
            out = await state["chain"].ainvoke({"system": system, "user": user})
            METRICS.inc("langchain_calls")
            return out
        except BaseException as exc:                    # noqa: BLE001
            inner = (state.get("holder") or {}).get("provider_error")
            if inner is not None:
                raise inner                             # the provider ran and failed (LangChain may have re-wrapped it): handle exactly as before
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            METRICS.inc("langchain_fallback")
            logger.warning("LangChain step failed (%s); using the direct provider call", type(exc).__name__)
            if isinstance(exc, (ImportError, AttributeError, TypeError, ValueError)):
                state["broken"] = True                  # interface drift: stop trying on every request
            return await call_provider(system, user)

    return generate, "langchain-lcel"
