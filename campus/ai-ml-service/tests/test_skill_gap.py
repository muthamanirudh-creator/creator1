import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import skill_gap


def test_skill_gap_fallback_is_valid_for_unknown_role(monkeypatch):
    async def fail(*args, **kwargs):
        raise RuntimeError('provider unavailable')
    monkeypatch.setattr(skill_gap, 'call_llm', fail)
    result = asyncio.run(skill_gap.analyze('Quantum Product Engineer', ['Python'], 'built a prototype'))
    assert result['target_role'] == 'Quantum Product Engineer'
    assert result['need']
    assert 'pct' in result
    assert result['llm_unavailable'] is True


def test_skill_gap_llm_result_is_normalised(monkeypatch):
    async def fake(*args, **kwargs):
        return {'text': '{"need":["Python","SQL"],"matched":["Python","Not A Need"],"missing":["SQL"],"notes":"Learn SQL next."}', 'provider': 'groq'}
    monkeypatch.setattr(skill_gap, 'call_llm', fake)
    result = asyncio.run(skill_gap.analyze('Data Analyst', ['Python'], ''))
    assert result['ai_enriched'] is True
    assert result['matched'] == ['Python']
    assert result['missing'] == ['SQL']
    assert result['pct'] == 50
