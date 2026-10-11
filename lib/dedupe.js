// Duplicate detection across sources and re-posted notifications.
const { jaccard } = require('./fraud');
const norm = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t && !['demo', 'the', 'of', 'for', 'recruitment'].includes(t)));

function similarity(a, b) {
  return 0.5 * jaccard(norm(a.title), norm(b.title)) + 0.3 * jaccard(norm(a.organization), norm(b.organization))
    + 0.2 * (a.vacancies && b.vacancies && a.vacancies.total === b.vacancies.total ? 1 : 0);
}

// existing: [{ id, data }]. Returns candidates at or above threshold, best first.
function findDuplicates(record, existing, { threshold = 0.75, ignoreId } = {}) {
  return existing.filter((e) => e.id !== ignoreId && e.data)
    .map((e) => ({ id: e.id, score: Math.round(similarity(record, e.data) * 100) / 100, title: e.data.title }))
    .filter((c) => c.score >= threshold).sort((a, b) => b.score - a.score);
}

module.exports = { similarity, findDuplicates };
