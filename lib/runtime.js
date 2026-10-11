// Runtime resilience layer. Public intelligence can run without PostgreSQL (e.g. hackathon laptop/demo),
// while production deployments can still use PostgreSQL for persistence and ingestion.
const { buildJobs } = require('../data/jobs');
const crypto = require('crypto');

let demo = false;
const state = {
  started_at: new Date().toISOString(),
  live_checks: [],
  audits: [],
};

const examSeeds = [
  { id: 101, code: 'SSC-CGL', name: 'Combined Graduate Level', organization: 'Staff Selection Commission', recruitment_year: new Date().getFullYear(), syllabus_version: 'CGL-VERIFIED-DEMO', pattern: { stages: ['Tier-I','Tier-II'], negative_marking: 0.5 }, nodes: [
    ['CGL-GEN','General Intelligence & Reasoning','Analogy, classification, series and logical reasoning'],
    ['CGL-GA','General Awareness','Current events, history, geography, polity and science'],
    ['CGL-QA','Quantitative Aptitude','Arithmetic, algebra, geometry and data interpretation'],
    ['CGL-ENG','English Comprehension','Vocabulary, grammar, comprehension and usage'],
  ]},
  { id: 102, code: 'SSC-CHSL', name: 'Combined Higher Secondary Level', organization: 'Staff Selection Commission', recruitment_year: new Date().getFullYear(), syllabus_version: 'CHSL-VERIFIED-DEMO', pattern: { stages: ['Tier-I','Tier-II'], negative_marking: 0.5 }, nodes: [
    ['CHSL-ENG','English Language','Grammar, vocabulary and comprehension'],
    ['CHSL-QA','Quantitative Aptitude','Number systems, arithmetic and data interpretation'],
    ['CHSL-REASON','General Intelligence','Verbal and non-verbal reasoning'],
    ['CHSL-GA','General Awareness','India and the world, science and current events'],
  ]},
  { id: 103, code: 'BANK-PO', name: 'Probationary Officer', organization: 'Public Sector Banking', recruitment_year: new Date().getFullYear(), syllabus_version: 'PO-VERIFIED-DEMO', pattern: { stages: ['Prelims','Mains','Interview'], negative_marking: 0.25 }, nodes: [
    ['PO-EN','English Language','Reading comprehension, grammar and vocabulary'],
    ['PO-QA','Quantitative Aptitude','Data interpretation, arithmetic and number systems'],
    ['PO-RS','Reasoning Ability','Logical reasoning, puzzles and analytical reasoning'],
    ['PO-GA','General/Economy Awareness','Banking, economy and current affairs'],
  ]},
];

const paths = [
  { id: 1, code: 'ENTRY-10', title: '10th → Government Career', description: 'A practical path from secondary education into verified entry-level opportunities.', steps: ['Build a 10th-pass profile','Track postal, support and technical-entry notifications','Prepare aptitude, language and domain basics','Apply only through the verified notification'] },
  { id: 2, code: 'ENTRY-12', title: '12th → Public Service', description: 'Explore clerical, police, defence and higher-secondary opportunities.', steps: ['Complete 12th eligibility','Build a state-aware opportunity watchlist','Prepare reasoning, quantitative aptitude and language','Track physical/skill requirements where applicable'] },
  { id: 3, code: 'GRAD-01', title: 'Graduate → Central Services', description: 'Move from graduation to central-government and banking examinations.', steps: ['Verify degree and age cutoff','Select an exam family','Follow the current verified syllabus','Use mock tests and deadline alerts'] },
];

function enableDemo(reason) { demo = true; state.demo_reason = reason || 'PostgreSQL unavailable'; state.started_at = new Date().toISOString(); return state; }
function isDemo() { return demo; }
function jobs() { return buildJobs(new Date()).filter(j => j.lifecycle !== 'REVIEW_REQUIRED' && j.verification?.status === 'VERIFIED'); }
function exams() { return examSeeds.map(e => ({ id:e.id, code:e.code, name:e.name, organization:e.organization, version_id:e.id, recruitment_year:e.recruitment_year, syllabus_version:e.syllabus_version, pattern:e.pattern })); }
function syllabus(id) { const e=examSeeds.find(x=>x.id===Number(id)); if(!e)return null; return e.nodes.map((n,i)=>({id:Number(`${e.id}${i+1}`),parent_id:null,code:n[0],title:n[1],description:n[2],sort_order:i,source_page:i+1,source_ref:`${e.code} verified syllabus` })); }
function careerPaths() { return paths; }
const mockBank={
  101:{id:9001,title:'SSC CGL Foundation Mock',source_ref:'CGL verified syllabus demo',questions:[
    {id:'q1',text:'Which section primarily tests numerical calculation and data interpretation?',options:['Quantitative Aptitude','English Comprehension','General Awareness','Reasoning'],answer:0,origin:'Verified syllabus: CGL-QA'},
    {id:'q2',text:'Which topic belongs to General Intelligence and Reasoning?',options:['Analogy','Accounting standards','Organic synthesis','Fluid mechanics'],answer:0,origin:'Verified syllabus: CGL-GEN'},
    {id:'q3',text:'Which area is explicitly included in English Comprehension?',options:['Vocabulary','Circuit theory','Botany practicals','Surveying'],answer:0,origin:'Verified syllabus: CGL-ENG'}
  ]},
  102:{id:9002,title:'SSC CHSL Foundation Mock',source_ref:'CHSL verified syllabus demo',questions:[
    {id:'q1',text:'Which area is part of the CHSL English syllabus?',options:['Grammar','Thermodynamics','Geology mapping','Clinical pathology'],answer:0,origin:'Verified syllabus: CHSL-ENG'},
    {id:'q2',text:'Which area is part of CHSL Quantitative Aptitude?',options:['Arithmetic','Constitutional law only','Microbiology','Machine design'],answer:0,origin:'Verified syllabus: CHSL-QA'},
    {id:'q3',text:'Which section covers India and the world, science and current events?',options:['General Awareness','English Language','Quantitative Aptitude','Typing'],answer:0,origin:'Verified syllabus: CHSL-GA'}
  ]},
  103:{id:9003,title:'Bank PO Foundation Mock',source_ref:'PO verified syllabus demo',questions:[
    {id:'q1',text:'Which area belongs to Banking PO reasoning preparation?',options:['Puzzles','Surveying','Organic chemistry','Mechanical drawing'],answer:0,origin:'Verified syllabus: PO-RS'},
    {id:'q2',text:'Which area is included in PO quantitative preparation?',options:['Data interpretation','Geology','Pharmacology','Architecture history'],answer:0,origin:'Verified syllabus: PO-QA'},
    {id:'q3',text:'Which area is part of General/Economy Awareness?',options:['Banking awareness','Thermal engineering','Zoology practical','Literary criticism'],answer:0,origin:'Verified syllabus: PO-GA'}
  ]}
};
function mockTests(versionId){const t=mockBank[Number(versionId)]; if(!t)return []; return [{id:t.id,title:t.title,source_ref:t.source_ref,questions:t.questions.map(({answer,...q})=>q)}];}
function mockTestWithAnswers(id){for(const t of Object.values(mockBank))if(t.id===Number(id))return t;return null;}

function mapStates() { const counts={}; for(const j of jobs()) counts[j.state]=(counts[j.state]||0)+1; return Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([state,jobs])=>({state,jobs})); }
function audit(payload) { const id=crypto.randomUUID(); state.audits.unshift({id,...payload,created_at:new Date().toISOString()}); state.audits=state.audits.slice(0,500); return id; }
function metrics() { return { ...state, mode: demo?'RESILIENT_DEMO':'POSTGRES', public_jobs:jobs().length, verified_exam_versions:exams().length, audits:state.audits.length, uptime_seconds:Math.floor((Date.now()-Date.parse(state.started_at))/1000) }; }
function liveStatus() { return { mode:demo?'RESILIENT_DEMO':'POSTGRES', checked_at:new Date().toISOString(), sources:state.live_checks }; }
function recordLive(x) { state.live_checks=[x,...state.live_checks.filter(y=>y.source_id!==x.source_id)].slice(0,20); return x; }
module.exports={enableDemo,isDemo,jobs,exams,syllabus,careerPaths,mockTests,mockTestWithAnswers,mapStates,audit,metrics,liveStatus,recordLive};
