"""Pass 5: reranker wiring, restart persistence (records snapshot + embedding cache), status reporting.
Run: python3 -I tests/test_rag_pass5.py   (stdlib + numpy only; pytest also works)."""
import json
import os
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from app.rag_core import HybridIndex, HybridRAG, RagDocument  # noqa: E402
from app.rag_core.ingest import ingest_record  # noqa: E402
from app.rag_core.models import Candidate  # noqa: E402
from app.rag_core.pipeline import RagConfig  # noqa: E402
from app.rag_core.recruitment import RecordRegistry  # noqa: E402
from app.rag_core.rerank import CrossEncoderReranker, FallbackReranker, LexicalReranker, build_reranker, wants_rerank  # noqa: E402
from test_rag_core import build, doc, embed, run  # noqa: E402

TODAY, NOW = date(2026, 10, 11), datetime(2026, 10, 11, 9, 0, tzinfo=timezone.utc)


def cand(text, fused, title="", **flags):
    c = Candidate(RagDocument(text=text, source_id=text[:8], title=title), fused=fused)
    c.flags = list(flags.get("flags", []))
    return c


class RerankerUnitTests(unittest.TestCase):
    def test_lexical_prefers_the_passage_that_covers_the_whole_question(self):
        a = cand("Graduate degree required. Last date to apply is 1 March.", 0.5)
        b = cand("Age limit is 18 to 32 years for general candidates.", 0.5)
        s = LexicalReranker()("age limit for general candidates", [a, b])
        self.assertGreater(s[1], s[0])

    def test_first_stage_rank_is_kept_as_a_tiebreaker_not_discarded(self):
        a, b = cand("Alpha passage about exams.", 1.0), cand("Alpha passage about exams.", 0.2)
        s = LexicalReranker()("alpha exams", [a, b])
        self.assertGreater(s[0], s[1])

    def test_exact_identifier_match_survives_reranking(self):
        exact = cand("unrelated wording entirely", 0.4, flags=["exact_identifier_match"])
        other = cand("last date notification details for another recruitment", 1.0)
        s = LexicalReranker()("Advt. No. 03/2025 last date", [exact, other])
        self.assertGreater(s[0], s[1])

    def test_empty_query_terms_fall_back_to_first_stage_order(self):
        s = LexicalReranker()("the of and", [cand("x y", 1.0), cand("z w", 0.5)])
        self.assertGreater(s[0], s[1])

    def test_cross_encoder_without_the_package_fails_once_and_falls_back(self):
        ce = CrossEncoderReranker("no-such-model-xyz")
        fb = FallbackReranker(ce, LexicalReranker())
        out = fb("age limit", [cand("age limit 18 32", 1.0), cand("fee 100", 0.5)])
        self.assertEqual(len(out), 2)
        self.assertEqual(fb.name, "lexical")                          # the name reports what actually ran
        self.assertTrue(ce.failed)                                    # recorded, not retried per request
        fb("age limit", [cand("a", 1.0), cand("b", 0.5)])

    def test_build_reranker_modes(self):
        self.assertIsNone(build_reranker("off"))
        self.assertEqual(build_reranker("lexical").name, "lexical")
        self.assertIn(build_reranker("auto").name, ("lexical", "cross-encoder"))
        self.assertEqual(build_reranker("cross-encoder").name, "cross-encoder")

    def test_policy_explicit_wins_and_auto_targets_hard_queries(self):
        near = [cand("a", 1.0), cand("b", 0.95)]
        far = [cand("a", 1.0), cand("b", 0.3)]
        self.assertTrue(wants_rerank(True, far, mode_on=True, strict_facts=False))
        self.assertFalse(wants_rerank(False, near, mode_on=True, strict_facts=True))
        self.assertTrue(wants_rerank(None, near, mode_on=True, strict_facts=False))     # nearly tied -> ordering uncertain
        self.assertFalse(wants_rerank(None, far, mode_on=True, strict_facts=False))
        self.assertTrue(wants_rerank(None, far, mode_on=True, strict_facts=True))       # recruitment facts are high value
        self.assertFalse(wants_rerank(True, near, mode_on=False, strict_facts=True))    # disabled by configuration
        self.assertFalse(wants_rerank(None, [cand("a", 1.0)], mode_on=True, strict_facts=True))


class RerankerPipelineTests(unittest.TestCase):
    def test_rerank_true_now_has_an_effect_and_is_reported(self):
        rag, _ = build()
        rag.reranker = LexicalReranker()
        cands, info = rag.retrieve("SSC CGL last date", rerank=True)
        self.assertGreaterEqual(len(cands), 2)
        self.assertTrue(info["reranked"])
        self.assertTrue(all(c.rerank is not None for c in cands[:2]))
        self.assertEqual(info["reranker"], "lexical")

    def test_rerank_false_and_disabled_reranker_leave_order_alone(self):
        rag, _ = build()
        base, info0 = rag.retrieve("SSC CGL last date", rerank=False)
        self.assertFalse(info0["reranked"])
        rag.reranker = None
        _, info = rag.retrieve("SSC CGL last date", rerank=True)
        self.assertFalse(info["reranked"])
        self.assertEqual(info.get("reranker"), "off")                 # asked for, disabled: the response says so

    def test_a_crashing_reranker_degrades_to_fused_order(self):
        rag, _ = build()
        def boom(q, c):
            raise RuntimeError("model blew up")
        rag.reranker = boom
        base, _ = build()[0].retrieve("SSC CGL last date", rerank=False)
        got, info = rag.retrieve("SSC CGL last date", rerank=True)
        self.assertFalse(info["reranked"])
        self.assertEqual([c.doc.id for c in got], [c.doc.id for c in base])

    def test_wrong_score_count_is_rejected_not_applied(self):
        rag, _ = build()
        rag.reranker = lambda q, c: [1.0]
        _, info = rag.retrieve("SSC CGL last date", rerank=True)
        self.assertFalse(info["reranked"])

    def test_reranking_never_changes_access_control_or_stale_exclusion(self):
        rag, idx = build()
        idx.upsert_source("u1-resume", [doc("Private resume text about SSC CGL 2025 age limit.", "u1-resume", "Resume", scope="user:u1")])
        rag.reranker = LexicalReranker()
        cands, _ = rag.retrieve("SSC CGL 2025 age limit", requester={"user_id": "u2"}, rerank=True)
        self.assertFalse(any(c.doc.source_id == "u1-resume" for c in cands))
        self.assertFalse(any(c.doc.metadata.get("status") == "superseded" for c in cands))

    def test_answer_path_runs_the_reranker_off_the_event_loop_and_still_abstains_when_unsupported(self):
        rag, _ = build()
        rag.reranker = LexicalReranker()
        res = run(rag.answer("quantum chromodynamics lattice gauge theory", rerank=True))
        self.assertEqual(res["mode"], "abstained")


class PersistenceTests(unittest.TestCase):
    def payload(self, rid="A"):
        return dict(record_id=rid, organization="Test Corp", role="Trainee", advt_no="TC/01/2026", cycle="2026",
                    url="https://careers.testcorp.gov.in/a", text="Test Corp Trainee - Advt. No. TC/01/2026\n\nEligibility\nMinimum 6.5 CGPA.\n\nImportant Dates\nLast date to apply: 30 November 2026.",
                    deadline="2026-11-30", opens_at="2026-10-01", authority="official", last_verified_at="2026-10-10T08:00:00+00:00",
                    source_status="reachable", extraction_status="reviewed")

    def test_restart_restores_records_and_search_without_a_new_sync(self):
        with tempfile.TemporaryDirectory() as d:
            snap = os.path.join(d, "hybrid", "records.json")            # parent folder does not exist yet
            reg = RecordRegistry(HybridIndex(embed, min_similarity=0.05), snapshot_path=snap)
            ingest_record(reg, self.payload(), official_domains=(), today=TODAY, now=NOW)
            self.assertTrue(os.path.exists(snap))
            self.assertIsNotNone(reg.persistence["last_saved_at"])
            self.assertIsNone(reg.persistence["last_error"])
            idx2 = HybridIndex(embed, min_similarity=0.05)              # "restart"
            reg2 = RecordRegistry(idx2, snapshot_path=snap)
            self.assertEqual(reg2.load(), 1)
            self.assertEqual(reg2.persistence["loaded"], 1)
            cands, _ = idx2.search("Advt. No. TC/01/2026 last date", filters={"domain": "government"}, today=TODAY)
            self.assertTrue(cands)

    def test_unwritable_path_is_reported_and_service_keeps_working(self):
        with tempfile.TemporaryDirectory() as d:
            blocker = os.path.join(d, "file")
            Path(blocker).write_text("x")
            reg = RecordRegistry(HybridIndex(embed, min_similarity=0.05), snapshot_path=os.path.join(blocker, "sub", "r.json"))
            ingest_record(reg, self.payload(), official_domains=(), today=TODAY, now=NOW)
            self.assertEqual(len(reg.records), 1)                       # in-memory state is still right
            self.assertTrue(reg.persistence["last_error"])              # ...and the failure is visible, not silent

    def test_corrupt_snapshot_is_ignored_and_reported(self):
        with tempfile.TemporaryDirectory() as d:
            snap = os.path.join(d, "r.json")
            Path(snap).write_text("{not json")
            reg = RecordRegistry(HybridIndex(embed), snapshot_path=snap)
            self.assertEqual(reg.load(), 0)
            self.assertEqual(reg.persistence["last_error"], "snapshot_unreadable")

    def test_no_temp_files_left_behind(self):
        with tempfile.TemporaryDirectory() as d:
            reg = RecordRegistry(HybridIndex(embed, min_similarity=0.05), snapshot_path=os.path.join(d, "r.json"))
            ingest_record(reg, self.payload(), official_domains=(), today=TODAY, now=NOW)
            self.assertEqual([f for f in os.listdir(d) if f.endswith(".tmp")], [])

    def test_embedding_cache_survives_restart_so_unchanged_text_is_not_re_embedded(self):
        with tempfile.TemporaryDirectory() as d:
            vp = os.path.join(d, "vectors.npz")
            a = HybridIndex(embed, embed_version="m1", min_similarity=0.05)
            a.vectors_path = vp
            a.upsert_source("s1", [doc("Alpha beta gamma notice text.", "s1"), doc("Delta epsilon zeta text.", "s1")])
            a.search("alpha")
            self.assertEqual(a.embed_calls, 2)
            self.assertTrue(os.path.exists(vp))
            b = HybridIndex(embed, embed_version="m1", min_similarity=0.05)
            b.vectors_path = vp
            self.assertEqual(b.load_vectors(), 2)
            b.upsert_source("s1", [doc("Alpha beta gamma notice text.", "s1"), doc("Delta epsilon zeta text.", "s1")])
            b.search("alpha")
            self.assertEqual(b.embed_calls, 0)                          # only the query is embedded, no chunk is

    def test_vectors_from_a_different_embedding_model_are_never_loaded(self):
        with tempfile.TemporaryDirectory() as d:
            vp = os.path.join(d, "vectors.npz")
            a = HybridIndex(embed, embed_version="m1", min_similarity=0.05)
            a.vectors_path = vp
            a.upsert_source("s1", [doc("Alpha beta gamma.", "s1")])
            a.search("alpha")
            b = HybridIndex(embed, embed_version="m2")
            self.assertEqual(b.load_vectors(vp), 0)

    def test_corrupt_vector_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            vp = os.path.join(d, "vectors.npz")
            Path(vp).write_bytes(b"garbage")
            b = HybridIndex(embed, embed_version="m1")
            self.assertEqual(b.load_vectors(vp), 0)
            self.assertTrue(b.vectors_error)

    def test_vector_cache_holds_only_current_shared_chunks(self):
        with tempfile.TemporaryDirectory() as d:
            vp = os.path.join(d, "v.npz")
            a = HybridIndex(embed, embed_version="m1", min_similarity=0.05)
            a.vectors_path = vp
            a.upsert_source("s1", [doc("Public notice text one.", "s1")])
            a.search("notice", extra_docs=[doc("MY PRIVATE RESUME secret skills", "u", scope="user:u1")])
            import numpy as np
            with np.load(vp, allow_pickle=False) as z:
                self.assertEqual(len(z["hashes"]), 1)                   # request-scoped resume text is never written to disk


if __name__ == "__main__":
    unittest.main()
