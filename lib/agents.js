// Controlled agent architecture.
// Each agent is a separate module-level unit with an explicit tool allowlist. It can only act through its toolbox.
// No agent has a publish tool, and lifecycle.advance refuses VERIFIED/PUBLISHED for agents.
// NOTE: agents run in-process behind this permission boundary. Moving each to its own service is a deployment
// change; the tool contract below is the interface that would become the service API.
class PermissionError extends Error { constructor(agent, tool) { super(`${agent} agent is not allowed to use ${tool}`); this.code = 'AGENT_PERMISSION'; } }

const TOOLS = {
  SourceDiscovery: ['registry.get', 'crawler.crawl', 'queue.enqueue', 'audit.log'],
  Document: ['pipeline.validate', 'pipeline.scan', 'pipeline.extract', 'pipeline.sections', 'store.findDocBySha', 'store.findRecruitmentByUrl', 'store.getRecruitment', 'store.latestDocumentId', 'store.saveFile', 'store.createRecruitment', 'store.insertDocument', 'lifecycle.advance', 'audit.log'],
  Extraction: ['extract.run', 'store.saveExtractionRun', 'lifecycle.advance'],
  Citation: ['extract.lineage'],
  Verification: ['registry.domains', 'fraud.analyze', 'store.dedupeCorpus', 'store.latestApproved', 'store.documentsFor', 'dedupe.find', 'conflict.find', 'diff.detect', 'link.check'],
  Quality: ['store.getRecruitment', 'store.createVersion', 'store.createReviewItem', 'store.saveChanges', 'store.saveConflicts', 'lifecycle.advance', 'audit.log'],
};

function toolbox(agent, impl) {
  return { agent, call(name, ...args) { if (!TOOLS[agent].includes(name)) throw new PermissionError(agent, name); if (!impl[name]) throw new Error(`Tool ${name} is not implemented`); return impl[name](...args); } };
}

// Orchestrator routing: only the agents a task needs.
const ROUTES = {
  DISCOVER: ['SourceDiscovery'],
  PROCESS_DOCUMENT: ['Document', 'Extraction', 'Citation', 'Verification', 'Quality'],
  RECHECK: ['Verification', 'Quality'],
  CITE: ['Citation'],
};
function route(task) { if (!ROUTES[task]) throw new Error(`Unknown task ${task}`); return ROUTES[task]; }

module.exports = { TOOLS, ROUTES, route, toolbox, PermissionError };
