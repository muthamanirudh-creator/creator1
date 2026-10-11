"""Pass 3 regressions: router false-positive, contextual chunk headers, Node->Python record contract, evaluation harness.
Run: python3 -I tests/test_rag_pass3.py   (stdlib only; pytest also works)."""
import asyncio
import json
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from app.rag_core import HybridIndex  # noqa: E402
from app.rag_core.ingest import ingest_record  # noqa: E402
from app.rag_core.recruitment import RecordRegistry, record_from_payload, to_documents  # noqa: E402
from app.rag_core.router import classify  # noqa: E402
from test_rag_core import embed  # noqa: E402

TODAY, NOW = date(2026, 10, 11), datetime(2026, 10, 11, 9, 0, tzinfo=timezone.utc)


class RouterRegressionTests(unittest.TestCase):
    def test_generic_government_word_in_an_advice_question_is_career_advice(self):
        r = classify("can I move from private sector prep to government exams")
        self.assertEqual((r.kind, r.domain, r.strict_facts), ("rag", "career", False))

    def test_specific_recruitment_signals_still_route_to_government(self):
        for q in ("SSC CGL notification last date", "How many vacancies in RRB NTPC?", "Advt. No. 03/2025 recruitment", "government job vacancy list"):
            self.assertEqual(classify(q).domain, "government", q)
        self.assertTrue(classify("UPSC notification how to prepare").strict_facts)      # a named body keeps strict mode even in an advice-style question

    def test_explicit_domain_hint_is_never_overridden(self):
        self.assertEqual(classify("how should I prepare for government exams", "government").domain, "government")


class ChunkHeaderTests(unittest.TestCase):
    NOTICE = "Test Corp Trainee - Advt. No. TC/01/2026\n\nEligibility\nMinimum 6.5 CGPA.\n\nImportant Dates\nLast date to apply: 30 November 2026."

    def rec(self, **kw):
        p = dict(record_id="A", organization="Test Corp", role="Trainee", advt_no="TC/01/2026", cycle="2026", url="https://careers.testcorp.gov.in/a",
                 text=self.NOTICE, deadline="2026-11-30", opens_at="2026-10-01", authority="official", last_verified_at="2026-10-10T08:00:00+00:00",
                 source_status="reachable", extraction_status="reviewed")
        p.update(kw)
        return record_from_payload(p)

    def test_every_chunk_names_its_drive_and_stored_notice_text_is_unchanged(self):
        r = self.rec()
        docs = to_documents(r, {"status": "active"})
        self.assertGreaterEqual(len(docs), 2)
        for d in docs:
            self.assertTrue(d.text.startswith("[Test Corp | Trainee | Advt. No. TC/01/2026 | 2026]"), d.text[:60])
        self.assertEqual(r.text, self.NOTICE)                         # eligibility quotes are validated against the untouched notice

    def test_header_omits_unknown_parts_instead_of_inventing_them(self):
        d = to_documents(self.rec(advt_no="", cycle=""), {"status": "active"})[0]
        self.assertTrue(d.text.startswith("[Test Corp | Trainee]"))

    def test_similar_sections_of_two_drives_are_told_apart(self):
        idx = HybridIndex(embed, min_similarity=0.05)
        reg = RecordRegistry(idx)
        ingest_record(reg, dict(record_id="A", organization="Test Corp", role="Trainee", advt_no="TC/01/2026", url="https://careers.testcorp.gov.in/a",
                                text=self.NOTICE, deadline="2026-11-30", opens_at="2026-10-01", authority="official", last_verified_at="2026-10-10T08:00:00+00:00",
                                source_status="reachable", extraction_status="reviewed"), today=TODAY, now=NOW)
        ingest_record(reg, dict(record_id="Z", organization="Zed Board", role="Clerk", advt_no="ZB/09/2026", url="https://www.zedboard.gov.in/z",
                                text="Zed Board Clerk - Advt. No. ZB/09/2026\n\nImportant Dates\nLast date to apply: 20 December 2026.", deadline="2026-12-20",
                                opens_at="2026-10-01", authority="official", last_verified_at="2026-10-10T08:00:00+00:00", source_status="reachable",
                                extraction_status="reviewed"), today=TODAY, now=NOW)
        cands, _ = idx.search("Advt. No. TC/01/2026 last date to apply", filters={"domain": "government"}, today=TODAY)
        self.assertEqual(cands[0].doc.metadata["record_id"], "A")
        self.assertIn("30 November 2026", " ".join(c.doc.text for c in cands if c.doc.metadata["record_id"] == "A"))


class NodeContractTests(unittest.TestCase):
    def test_payload_built_by_the_node_mapper_ingests_and_is_active(self):
        payload = json.loads((HERE / "eval" / "node_record_payload.json").read_text())
        reg = RecordRegistry(HybridIndex(embed, min_similarity=0.05))
        out = ingest_record(reg, payload, official_domains=(), today=TODAY, now=NOW)
        d = reg.describe(payload["record_id"], today=TODAY, now=NOW)
        self.assertEqual(d["authority"], "official")                 # testboard.gov.in is on the built-in gov.in policy
        self.assertEqual(d["drive_status"], "active")
        self.assertEqual(d["last_verified_at"], payload["last_verified_at"])      # freshness is preserved, not refreshed
        self.assertGreaterEqual(out["criteria_extracted"], 1)


class EvaluationHarnessTests(unittest.TestCase):
    def test_recruitment_behaviour_checks_all_pass(self):
        import eval_hybrid_rag as E
        res = asyncio.run(E.part_b())
        failed = [c for c in res["checks"] if not c["ok"]]
        self.assertEqual(failed, [], failed)
        self.assertEqual(res["eligibility_accuracy"], 1.0)

    def test_career_dataset_is_labelled_against_real_passage_ids(self):
        from unittest.mock import MagicMock
        try:
            import httpx  # noqa: F401
        except Exception:                                             # noqa: BLE001
            sys.modules["httpx"] = MagicMock()
        from app.services import rag as legacy
        ids = {c.id for c in legacy.build_kb_chunks()}
        cases = json.loads((HERE / "eval" / "career_cases.json").read_text())["cases"]
        for c in cases:
            self.assertTrue(set(c["relevant"]) <= ids, c)


if __name__ == "__main__":
    unittest.main(verbosity=1)
