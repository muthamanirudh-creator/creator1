"""Pass 4B - API / response-shape compatibility for the Hybrid RAG upgrade.

Run:  python3 -I tests/test_api_compat.py            (stdlib + numpy only; pytest also works)
      python3 -I tests/test_api_compat.py --update   rewrite tests/api_contract/*.golden.json after an INTENTIONAL change

FastAPI / pydantic / httpx are not needed: routes, request models and admin guards are read from the SOURCE with `ast`;
response shapes are produced by the REAL engines (hybrid pipeline and the legacy Career Fit RAG) with a stub LLM and the
deterministic embedding test double. What this does NOT prove: that the HTTP layer serialises these dicts (needs FastAPI).
"""
import ast
import asyncio
import json
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SVC = HERE.parent
sys.path.insert(0, str(SVC))
sys.path.insert(0, str(HERE))

GOLDEN = HERE / "api_contract" / "ai_ml_routes.golden.json"
UPDATE = "--update" in sys.argv
if UPDATE:
    sys.argv.remove("--update")

HTTP = {"get", "post", "put", "patch", "delete", "head", "options"}


# ------------------------------------------------------------------------------------------------ source readers
def _tree(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _const(node):
    return node.value if isinstance(node, ast.Constant) else None


def routes_in(path: Path) -> list[tuple[str, str, ast.AST]]:
    """[(METHOD, full_path, function_node)] for a router module (prefix from APIRouter(prefix=...)) or main.py (@app.*)."""
    tree, prefix = _tree(path), ""
    for n in tree.body:
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and getattr(n.value.func, "id", "") == "APIRouter":
            for kw in n.value.keywords:
                if kw.arg == "prefix":
                    prefix = _const(kw.value) or ""
    out = []
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for d in n.decorator_list:
                if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr in HTTP and d.args and _const(d.args[0]) is not None:
                    out.append((d.func.attr.upper(), prefix + _const(d.args[0]), n))
    return out


def all_routes() -> dict[str, list[str]]:
    table = {}
    for f in sorted((SVC / "app" / "routers").glob("*.py")):
        if f.name == "__init__.py":
            continue
        table[f"app/routers/{f.name}"] = sorted(f"{m} {p}" for m, p, _ in routes_in(f))
    table["app/main.py"] = sorted(f"{m} {p}" for m, p, _ in routes_in(SVC / "app" / "main.py"))
    return table


def model_fields(path: Path, cls: str) -> dict[str, dict]:
    """{field: {"required": bool, "default": repr|None}} read from a pydantic model's class body."""
    for n in _tree(path).body:
        if isinstance(n, ast.ClassDef) and n.name == cls:
            out = {}
            for s in n.body:
                if isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name):
                    v = s.value
                    if v is None:
                        out[s.target.id] = {"required": True, "default": None}
                    elif isinstance(v, ast.Call) and getattr(v.func, "id", "") == "Field":
                        first = v.args[0] if v.args else next((k.value for k in v.keywords if k.arg in ("default", "default_factory")), None)
                        required = isinstance(first, ast.Constant) and first.value is Ellipsis
                        out[s.target.id] = {"required": required, "default": None if required else ast.unparse(first) if first is not None else "None"}
                    else:
                        out[s.target.id] = {"required": False, "default": ast.unparse(v)}
            return out
    raise AssertionError(f"class {cls} not found in {path}")


def run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------------------------------------------ route inventory
class RouteInventoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.table = all_routes()
        if UPDATE:
            GOLDEN.write_text(json.dumps(cls.table, indent=2) + "\n")
        cls.golden = json.loads(GOLDEN.read_text())

    def test_no_route_in_the_snapshot_was_removed_or_renamed(self):
        lost = [f"{f}: {r}" for f, rs in self.golden.items() for r in rs if r not in self.table.get(f, [])]
        self.assertEqual(lost, [], "routes missing")

    def test_no_route_was_added_without_an_intentional_update(self):
        added = [f"{f}: {r}" for f, rs in self.table.items() for r in rs if r not in self.golden.get(f, [])]
        self.assertEqual(added, [], "new routes - re-run with --update after review")

    def test_legacy_career_fit_rag_routes_unchanged(self):
        self.assertEqual(self.table["app/routers/rag.py"], ["GET /rag/status", "POST /rag/query", "POST /rag/retrieve"])

    def test_hybrid_routes_are_exactly_the_documented_ten_and_all_under_a_new_prefix(self):
        want = {"POST /rag/hybrid/query", "POST /rag/hybrid/retrieve", "GET /rag/hybrid/status", "POST /rag/hybrid/eligibility", "GET /rag/hybrid/records",
                "POST /rag/hybrid/records", "POST /rag/hybrid/records/sweep", "POST /rag/hybrid/records/{record_id}/verified",
                "POST /rag/hybrid/records/{record_id}/unreachable", "DELETE /rag/hybrid/records/{record_id}"}
        self.assertEqual(set(self.table["app/routers/hybrid_rag.py"]), want)

    def test_no_method_and_path_is_declared_twice_anywhere(self):
        seen, dup = {}, []
        for f, rs in self.table.items():
            for r in rs:
                if r in seen:
                    dup.append((r, seen[r], f))
                seen[r] = f
        self.assertEqual(dup, [])

    def test_no_hybrid_route_can_shadow_a_legacy_route(self):
        legacy = {p for _, p in (r.split(" ", 1) for r in self.table["app/routers/rag.py"])}
        for r in self.table["app/routers/hybrid_rag.py"]:
            self.assertNotIn(r.split(" ", 1)[1], legacy)

    def test_every_router_module_is_still_mounted_by_main(self):
        main = (SVC / "app" / "main.py").read_text()
        mods = [f.stem for f in (SVC / "app" / "routers").glob("*.py") if f.stem != "__init__"]
        missing = [m for m in mods if not re.search(rf"include_router\(\s*{m}\.router", main)]
        self.assertEqual(missing, [], "router modules present but not mounted")

    def test_every_route_the_node_gateway_requires_still_exists_in_the_service(self):
        gw = (SVC.parent / "backend" / "server.js").read_text()
        block = re.search(r"const AI_ML_REQUIRED_ROUTES = \[([\s\S]*?)\];", gw).group(1)
        required = re.findall(r"'([^']+)'", block)
        have = {r.split(" ", 1)[1] for rs in self.table.values() for r in rs}
        self.assertEqual([p for p in required if p not in have], [])


# ------------------------------------------------------------------------------------------------ request models
class RequestModelTests(unittest.TestCase):
    ROUTERS = SVC / "app" / "routers"

    def test_legacy_rag_request_model_is_byte_for_byte_compatible(self):
        f = model_fields(self.ROUTERS / "rag.py", "RagRequest")
        self.assertEqual(list(f), ["question", "resume_text", "jd_text", "target_role", "scope", "top_k", "history", "provider"])
        self.assertEqual([k for k, v in f.items() if v["required"]], ["question"])
        self.assertEqual((f["resume_text"]["default"], f["scope"]["default"], f["top_k"]["default"], f["provider"]["default"]), ("''", "'all'", "None", "None"))

    def test_hybrid_query_needs_only_a_question(self):
        f = model_fields(self.ROUTERS / "hybrid_rag.py", "HybridRequest")
        self.assertEqual([k for k, v in f.items() if v["required"]], ["question"])
        self.assertEqual(set(f), {"question", "domain", "filters", "history", "include_stale", "rerank"})
        self.assertEqual((f["include_stale"]["default"], f["rerank"]["default"]), ("False", "None"))     # safe defaults: no stale evidence; rerank None = automatic since pass 5 (cross-check cost is bounded by wants_rerank)

    def test_no_request_model_accepts_a_caller_identity_in_the_body(self):
        forbidden = {"user_id", "user", "userid", "x_user_id", "requester", "owner_id"}
        for cls in ("HybridRequest", "EligibilityRequest", "RecordPayload", "Filters"):
            self.assertEqual(forbidden & set(model_fields(self.ROUTERS / "hybrid_rag.py", cls)), set(), cls)

    def test_eligibility_request_everything_optional_and_profile_defaults_empty(self):
        f = model_fields(self.ROUTERS / "hybrid_rag.py", "EligibilityRequest")
        self.assertEqual([k for k, v in f.items() if v["required"]], [])
        self.assertEqual(f["include_closed"]["default"], "False")

    def test_record_payload_requires_only_id_organization_and_role_and_fails_closed_on_authority(self):
        f = model_fields(self.ROUTERS / "hybrid_rag.py", "RecordPayload")
        self.assertEqual([k for k, v in f.items() if v["required"]], ["record_id", "organization", "role"])
        self.assertEqual(f["authority"]["default"], "'third_party'")          # unknown source => lowest authority, never "official"
        self.assertEqual(f["extraction_status"]["default"], "'auto_extracted'")  # unknown review state => not "reviewed"
        self.assertEqual(f["source_status"]["default"], "'never_checked'")

    def test_node_mapper_payload_fixture_only_uses_declared_fields(self):
        payload = json.loads((HERE / "eval" / "node_record_payload.json").read_text())
        undeclared = set(payload) - set(model_fields(self.ROUTERS / "hybrid_rag.py", "RecordPayload"))
        self.assertEqual(undeclared, set())


# ------------------------------------------------------------------------------------------------ authorization
class AuthorizationContractTests(unittest.TestCase):
    ROUTES = {(m, p): fn for m, p, fn in routes_in(SVC / "app" / "routers" / "hybrid_rag.py")}

    @staticmethod
    def _calls_admin_first(fn) -> bool:
        body = [s for s in fn.body if not (isinstance(s, ast.Expr) and isinstance(_const(s.value), str))]       # skip docstring
        # the guard may sit directly in the handler, or in a helper called as the first statement
        return bool(body) and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Call) and getattr(body[0].value.func, "id", "") == "_admin"

    def test_every_record_mutation_is_admin_gated_before_any_work(self):
        mutating = [(k, fn) for k, fn in self.ROUTES.items() if "/records" in k[1] and k[0] in ("POST", "DELETE")]
        self.assertEqual(len(mutating), 5)
        for (m, p), fn in mutating:
            self.assertTrue(self._calls_admin_first(fn), f"{m} {p} must call _admin(x_user_role) as its first statement")

    def test_read_and_user_routes_do_not_require_admin(self):
        for key in [("POST", "/rag/hybrid/query"), ("POST", "/rag/hybrid/retrieve"), ("GET", "/rag/hybrid/status"), ("POST", "/rag/hybrid/eligibility"),
                    ("GET", "/rag/hybrid/records")]:
            self.assertFalse(self._calls_admin_first(self.ROUTES[key]), key)

    def test_admin_guard_fails_closed(self):
        src = (SVC / "app" / "routers" / "hybrid_rag.py").read_text()
        guard = src[src.index("def _admin"):src.index("class EligibilityRequest")]
        self.assertIn('!= "admin"', guard)
        self.assertIn("403", guard)

    def test_user_identity_is_read_only_from_the_x_user_id_header(self):
        r = (SVC / "app" / "routers" / "hybrid_rag.py").read_text()
        self.assertIn("x_user_id: Optional[str] = Header(None)", r)
        self.assertNotIn("req.user_id", r)
        self.assertNotIn("body.user", r)

    def test_status_route_keeps_its_original_keys_and_adds_records(self):
        fn = self_fn = AuthorizationContractTests.ROUTES[("GET", "/rag/hybrid/status")]
        ret = next(n for n in ast.walk(fn) if isinstance(n, ast.Return) and isinstance(n.value, ast.Dict))
        keys = {_const(k) for k in ret.value.keys}
        self.assertTrue({"index", "metrics", "orchestration", "langchain_installed", "cache"} <= keys, keys)
        self.assertIn("records", keys)                                          # pass 4A additive key


# ------------------------------------------------------------------------------------------------ response shapes (real engines)
HYBRID_BASE_KEYS = {"mode", "answer", "sources", "citations_used", "citation_coverage", "unsupported_removed", "conflicts", "warnings", "confidence",
                    "verification", "route", "retrieval", "provider", "cache_hit", "trace_id"}
SOURCE_PRE_4A = {"n", "id", "source_id", "title", "organization", "url", "published_at", "last_verified_at", "authority", "status", "section", "excerpt",
                 "relevance", "flags"}
SOURCE_4A_ADDED = {"drive_status", "advt_no", "record_id"}
SOURCE_PASS_B_ADDED = {"freshness", "freshness_reasons", "content_origin", "practice_label", "doc_type", "cycle", "batch"}   # Pass B: additive, None for non-knowledge sources


class HybridResponseShapeTests(unittest.TestCase):
    def setUp(self):
        from datetime import date
        from test_rag_core import Gen, build
        self.Gen, self.build, self.today = Gen, build, date(2025, 2, 1)

    def ask(self, gen, q="SSC CGL 2025 last date Advt. No. 03/2025", **kw):
        rag, _ = self.build(gen)
        return run(rag.answer(q, today=self.today, **kw)), gen

    def test_llm_mode_keeps_every_documented_key_and_types(self):
        r, _ = self.ask(self.Gen("The SSC CGL 2025 last date to apply is 2025-03-01 [1]."))
        self.assertEqual(r["mode"], "llm")
        self.assertTrue(HYBRID_BASE_KEYS <= set(r), HYBRID_BASE_KEYS - set(r))
        self.assertIsInstance(r["sources"], list)
        self.assertEqual(set(r["confidence"]) >= {"level", "relevance_signal", "not_a_probability"}, True)
        self.assertIs(r["confidence"]["not_a_probability"], True)
        self.assertIn(r["orchestration"], ("native", "langchain-lcel"))

    def test_source_view_is_a_superset_of_the_pre_4a_keys_and_adds_only_the_three_new_ones(self):
        r, _ = self.ask(self.Gen("The SSC CGL 2025 last date to apply is 2025-03-01 [1]."))
        s = r["sources"][0]
        self.assertEqual(set(s), SOURCE_PRE_4A | SOURCE_4A_ADDED | SOURCE_PASS_B_ADDED)
        self.assertEqual(s["status"], "active")                      # `status` still means the index status, unchanged

    def test_extractive_mode_when_the_llm_is_down_is_honest_and_keeps_the_shape(self):
        r, gen = self.ask(self.Gen(fail=True))
        self.assertEqual(r["mode"], "extractive")
        self.assertTrue(HYBRID_BASE_KEYS <= set(r))
        self.assertTrue(r["sources"])

    def test_abstained_mode_never_calls_the_llm_and_has_no_sources(self):
        r, gen = self.ask(self.Gen("should never be used"), q="quantum chromodynamics lattice gauge")
        self.assertEqual((r["mode"], gen.calls), ("abstained", 0))
        self.assertTrue(HYBRID_BASE_KEYS <= set(r))
        self.assertEqual(r["sources"], [])

    def test_deterministic_operations_are_redirected_not_answered_by_the_llm(self):
        r, gen = self.ask(self.Gen("never"), q="reset my password")
        self.assertEqual((r["mode"], gen.calls), ("deterministic_redirect", 0))
        self.assertEqual(r["route"]["kind"], "deterministic")

    def test_invalid_question_is_rejected_without_work(self):
        r, gen = self.ask(self.Gen("never"), q="x")
        self.assertEqual((r["mode"], gen.calls), ("rejected", 0))

    def test_unknown_filter_keys_do_not_crash_and_default_flags_exclude_stale_evidence(self):
        r, _ = self.ask(self.Gen("The SSC CGL 2025 last date to apply is 2025-03-01 [1]."), filters={"organization": "SSC"})
        ids = {s["id"] for s in r["sources"]}
        self.assertFalse(any("2024" in (s["title"] or "") for s in r["sources"]), ids)       # superseded 2024 notice is hidden by default

    def test_retrieve_only_view_matches_the_answer_view(self):
        from app.rag_core.pipeline import source_view
        rag, _ = self.build(self.Gen(""))
        cands, info = rag.retrieve("SSC CGL 2025 last date Advt. No. 03/2025", today=self.today)
        for i, c in enumerate(cands, 1):
            c.n = i
        self.assertTrue(cands)
        self.assertEqual(set(source_view(cands[0])), SOURCE_PRE_4A | SOURCE_4A_ADDED | SOURCE_PASS_B_ADDED)
        self.assertIsInstance(info, dict)


class LegacyRagUnchangedTests(unittest.TestCase):
    """The pre-existing Career Fit RAG (`/rag/query`) must answer exactly as before, in the same process as the hybrid core."""
    LEGACY_KEYS = {"question", "sources", "retrieval", "warnings", "provider", "llm_used", "citations_used", "citation_coverage", "mode", "grounded", "answer"}

    @classmethod
    def setUpClass(cls):
        try:
            import httpx  # noqa: F401
        except Exception:                                                  # noqa: BLE001
            from unittest.mock import MagicMock
            sys.modules["httpx"] = MagicMock()
        import _semantic_stub
        cls.stub = _semantic_stub
        _semantic_stub.install()
        from app.services import rag
        cls.rag = rag

    def setUp(self):
        self.stub.install()
        self._orig = self.rag.call_llm

    def tearDown(self):
        self.rag.call_llm = self._orig
        self.stub.install()

    def _llm(self, text):
        async def fake(system, user, opts=None):
            return {"text": text, "provider": "groq"}
        self.rag.call_llm = fake

    def test_no_evidence_path_keeps_its_shape_and_never_calls_the_llm(self):
        calls = []

        async def spy(*a, **k):
            calls.append(1)
            return {"text": "x", "provider": "groq"}
        self.rag.call_llm = spy
        r = run(self.rag.answer_question("zzzz qqqq xxxx vvvv", scope="resume"))
        self.assertEqual(set(r), self.LEGACY_KEYS)
        self.assertEqual(r["mode"], "no-evidence")
        self.assertEqual(calls, [])

    def test_llm_path_keeps_its_shape(self):
        self._llm("Containerise services with Docker and orchestrate with Kubernetes [1].")
        r = run(self.rag.answer_question("How do I learn Docker and Kubernetes for a DevOps role?", resume_text="PROJECTS\n- Shipped Docker images to AWS ECS.\nSKILLS\nPython, Docker", target_role="DevOps Engineer"))
        self.assertTrue(self.LEGACY_KEYS <= set(r), self.LEGACY_KEYS - set(r))
        self.assertIn(r["mode"], ("llm", "no-evidence", "extractive"))

    def test_status_keeps_its_keys(self):
        s = self.rag.status()
        self.assertTrue({"knowledge_base", "engine", "settings"} <= set(s))
        self.assertTrue({"top_k", "min_similarity", "max_context_chars", "dense_weight", "lexical_weight"} <= set(s["settings"]))

    def test_legacy_router_still_forwards_the_same_arguments_to_the_service(self):
        src = (SVC / "app" / "routers" / "rag.py").read_text()
        for frag in ("rag.answer_question(", "req.question.strip()", "resume_text=req.resume_text", "jd_text=req.jd_text", "target_role=req.target_role.strip()",
                     "scope=req.scope", "top_k=req.top_k", "provider=req.provider"):
            self.assertIn(frag, src, frag)
        self.assertNotIn("hybrid", src.lower().replace("career fit rag endpoints", ""), "legacy router must not depend on the hybrid core")

    def test_legacy_service_does_not_import_the_hybrid_core(self):
        src = (SVC / "app" / "services" / "rag.py").read_text()
        self.assertNotIn("rag_core", src)
        self.assertNotIn("hybrid_rag", src)


class ConfigurationDefaultsTests(unittest.TestCase):
    def test_new_settings_default_to_safe_values_in_code(self):
        src = (SVC / "app" / "config.py").read_text()
        for pat in (r'HYBRID_RAG_ALLOW_UNVERIFIED_FACTS[^\n]*(False|false)', r'HYBRID_RAG_USE_LANGCHAIN[^\n]*auto'):
            self.assertRegex(src, pat)

    def test_env_template_documents_every_hybrid_setting_the_code_reads(self):
        cfg = (SVC / "app" / "config.py").read_text()
        used = set(re.findall(r"\bHYBRID_RAG_[A-Z_]+", cfg))
        env = (SVC / ".env.example").read_text()
        self.assertEqual(sorted(u for u in used if u not in env), [])
        self.assertNotRegex(env, r"(gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{20,})")


if __name__ == "__main__":
    unittest.main(verbosity=1)
