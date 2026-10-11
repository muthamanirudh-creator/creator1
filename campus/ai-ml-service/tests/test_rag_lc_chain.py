"""Pass 3: LangChain (LCEL) orchestration wiring. stdlib `unittest` (pytest also works).

IMPORTANT: the build sandbox could not install langchain_core. `StubLangChainTests` therefore exercises OUR wiring and
failure rules against a minimal stand-in that mimics the small interface we use (ChatPromptTemplate.from_messages,
RunnableLambda, `|`, ainvoke). It proves nothing about the real package. `RealLangChainTests` runs the same
expectations against the real package and is skipped unless it is installed.
"""
import asyncio
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.rag_core import HybridIndex, HybridRAG, RagDocument  # noqa: E402
from app.rag_core import lc_chain  # noqa: E402
from app.rag_core.metrics import METRICS  # noqa: E402
from test_rag_core import embed  # noqa: E402


def run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------------------------------- minimal stand-in (NOT LangChain)
def make_stub_modules(prompt_raises=None):
    class _Msg:
        def __init__(self, content):
            self.content = content

    class _PromptValue:
        def __init__(self, msgs):
            self._m = msgs

        def to_messages(self):
            return self._m

    class _Runnable:
        def __or__(self, other):
            return _Seq(self, other)

    class _Seq(_Runnable):
        def __init__(self, *steps):
            self.steps = steps

        def __or__(self, other):
            return _Seq(*self.steps, other)

        async def ainvoke(self, x):
            for s in self.steps:
                x = await s.ainvoke(x)
            return x

    class ChatPromptTemplate(_Runnable):
        def __init__(self, tpl):
            self.tpl = tpl

        @classmethod
        def from_messages(cls, tpl):
            return cls(tpl)

        async def ainvoke(self, vars_):
            if prompt_raises:
                raise prompt_raises
            return _PromptValue([_Msg(vars_[t.strip("{}")] if t.startswith("{") else t) for _role, t in self.tpl])

    class RunnableLambda(_Runnable):
        def __init__(self, fn):
            self.fn = fn

        async def ainvoke(self, x):
            r = self.fn(x)
            return await r if asyncio.iscoroutine(r) else r

    core = types.ModuleType("langchain_core")
    prompts = types.ModuleType("langchain_core.prompts")
    prompts.ChatPromptTemplate = ChatPromptTemplate
    runnables = types.ModuleType("langchain_core.runnables")
    runnables.RunnableLambda = RunnableLambda
    core.prompts, core.runnables = prompts, runnables
    return {"langchain_core": core, "langchain_core.prompts": prompts, "langchain_core.runnables": runnables}


class _Provider:
    def __init__(self, fail=None):
        self.calls, self.fail = [], fail

    async def __call__(self, system, user):
        self.calls.append((system, user))
        if self.fail:
            raise self.fail
        return {"text": "ok [1]", "provider": "fake"}


class ModeTests(unittest.TestCase):
    def test_off_never_wraps(self):
        p = _Provider()
        g, label = lc_chain.wrap_generator(p, mode="off")
        self.assertIs(g, p)
        self.assertEqual(label, "native")

    def test_unknown_mode_is_auto(self):
        self.assertEqual(lc_chain.normalise_mode("banana"), "auto")
        self.assertEqual(lc_chain.normalise_mode(None), "auto")
        self.assertEqual(lc_chain.normalise_mode(" ON "), "on")

    @unittest.skipIf(lc_chain.langchain_importable(), "langchain_core is installed here")
    def test_auto_without_package_is_native_and_on_fails_fast(self):
        p = _Provider()
        g, label = lc_chain.wrap_generator(p, mode="auto")
        self.assertEqual((g, label), (p, "native"))
        with self.assertRaises(lc_chain.LangChainRequired):
            lc_chain.wrap_generator(p, mode="on")


class StubLangChainTests(unittest.TestCase):
    def setUp(self):
        self.p = mock.patch.dict(sys.modules, make_stub_modules())
        self.p.start()
        self.addCleanup(self.p.stop)

    def test_chain_is_used_and_passes_text_through_unchanged(self):
        prov = _Provider()
        g, label = lc_chain.wrap_generator(prov, mode="auto")
        self.assertEqual(label, "langchain-lcel")
        sysmsg, user = "SYS {braces} stay", "SOURCES <<< {x} >>> {not_a_var}"
        out = run(g(sysmsg, user))
        self.assertEqual(out["provider"], "fake")
        self.assertEqual(prov.calls, [(sysmsg, user)])                 # exact text reached the provider, exactly once

    def test_provider_error_propagates_and_provider_is_called_once(self):
        boom = RuntimeError("provider down")
        prov = _Provider(fail=boom)
        g, _ = lc_chain.wrap_generator(prov, mode="auto")
        with self.assertRaises(RuntimeError) as cm:
            run(g("s", "u"))
        self.assertIs(cm.exception, boom)
        self.assertEqual(len(prov.calls), 1)                           # never retried behind the pipeline's back

    def test_langchain_internal_failure_falls_back_to_direct_call_and_is_counted(self):
        with mock.patch.dict(sys.modules, make_stub_modules(prompt_raises=TypeError("interface drift"))):
            prov = _Provider()
            g, _ = lc_chain.wrap_generator(prov, mode="auto")
            before = METRICS.counters["langchain_fallback"]
            out = run(g("s", "u"))
            self.assertEqual(out["text"], "ok [1]")
            self.assertEqual(METRICS.counters["langchain_fallback"], before + 1)
            run(g("s2", "u2"))                                         # drift is remembered: no repeated failing attempts
            self.assertEqual(METRICS.counters["langchain_fallback"], before + 1)
            self.assertEqual(len(prov.calls), 2)

    def test_hybrid_rag_reports_orchestration_and_still_validates_citations(self):
        idx = HybridIndex(embed, embed_version="t")
        idx.upsert_source("a", [RagDocument(text="The Junior Clerk post has 120 vacancies per Advt. 03/2026.", source_id="a", title="Notice",
                                           metadata={"authority": "official", "domain": "government", "scope": "public", "status": "active"})])

        async def provider(system, user):
            return {"text": "There are 120 vacancies [1]. The salary is 99999 [1].", "provider": "fake"}

        g, label = lc_chain.wrap_generator(provider, mode="auto")
        rag = HybridRAG(idx, g, orchestration=label)
        res = run(rag.answer("How many vacancies for Junior Clerk?", domain="government", use_cache=False))
        self.assertEqual(res["mode"], "llm")
        self.assertEqual(res["orchestration"], "langchain-lcel")
        self.assertNotIn("99999", res["answer"])                        # our citation/support check still runs after LangChain
        self.assertTrue(res["unsupported_removed"])

    def test_non_llm_modes_report_native(self):
        idx = HybridIndex(embed, embed_version="t")
        rag = HybridRAG(idx, None, orchestration="langchain-lcel")
        res = run(rag.answer("Anything about the unknown ministry?", use_cache=False))
        self.assertEqual(res["mode"], "abstained")
        self.assertEqual(res.get("orchestration", "native"), "native")


@unittest.skipUnless(lc_chain.langchain_importable(), "langchain_core not installed in this environment")
class RealLangChainTests(unittest.TestCase):
    def test_real_chain_roundtrip_with_braces_in_text(self):
        prov = _Provider()
        g, label = lc_chain.wrap_generator(prov, mode="auto")
        self.assertEqual(label, "langchain-lcel")
        out = run(g("SYS {a}", "USER {b} <<<>>>"))
        self.assertEqual(out["provider"], "fake")
        self.assertEqual(prov.calls, [("SYS {a}", "USER {b} <<<>>>")])

    def test_real_chain_provider_error_propagates_once(self):
        boom = RuntimeError("x")
        prov = _Provider(fail=boom)
        g, _ = lc_chain.wrap_generator(prov, mode="auto")
        with self.assertRaises(RuntimeError):
            run(g("s", "u"))
        self.assertEqual(len(prov.calls), 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
