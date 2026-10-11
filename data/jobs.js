// DEMO DATA ONLY. These are fictional recruitments used to exercise the platform.
// Real data must come through the verified ingestion pipeline (Phase 2). Dates are generated
// relative to today (IST) so the demo always has open, closing-soon, upcoming and closed items.
const { addDaysIST, toISTISO } = require('../lib/dates');

function buildJobs(now = new Date()) {
  const D = (off, time) => toISTISO(addDaysIST(now, off), time);
  const Y = (off) => addDaysIST(now, off);
  const year = Y(0).slice(0, 4);
  const cutoff = `${year}-01-01`;
  const rel = (sc, st, obc, pwbd, ex) => ({ SC: sc, ST: st, OBC: obc, EWS: 0, PwBD: pwbd, ExServicemen: ex });
  const src = (id, name, org) => ({ id, name, type: 'OFFICIAL_NOTIFICATION', url: `https://example.gov.in/demo/${id}`, issuer: org });
  const fs = (doc, a, b, c, d) => ({
    education: { doc, page: a, section: '3.1' }, field: { doc, page: a, section: '3.2' }, subjects: { doc, page: a, section: '3.3' },
    age: { doc, page: b, section: '4.2' }, experience: { doc, page: b, section: '4.4' }, domicile: { doc, page: c, section: '5.1' },
    physical: { doc, page: d, section: '6' }, vacancies: { doc, page: 2, section: '2' }, dates: { doc, page: 1, section: '1' },
  });
  const verified = { status: 'VERIFIED', verified_at: D(-6, '11:00:00'), method: 'Rule check and human review (demo)' };
  const base = { lifecycle: 'PUBLISHED', verification: verified, sample: true };

  return [
    {
      ...base, id: 'rrb-group-d', title: 'Group D Track Maintainer', organization: 'Demo Railway Recruitment Board', department: 'Railways', domain: 'railway', state: 'All India',
      summary: 'Track maintenance and allied posts across zones.',
      dates: { application_open: D(-17, '10:00:00'), application_close: D(22), exam_date: Y(75) },
      education: { accepted: ['10th', 'iti'], or_higher: false, label: '10th pass or ITI', fields: ['any'] },
      age: { min: 18, max: 33, cutoff_date: cutoff, relaxation: rel(5, 5, 3, 10, 3) },
      domicile: { type: 'ALL_INDIA' }, physical: 'Physical Efficiency Test: lift and carry 35 kg, run 1,000 m',
      fee: { general: '₹500', reserved: '₹250' },
      vacancies: { total: 32000, breakdown: { UR: 13200, SC: 4800, ST: 2400, OBC: 8650, EWS: 2950 }, pwbd: 1280, ex_servicemen: 3200 },
      selection: ['Computer-based test', 'Physical Efficiency Test', 'Document verification', 'Medical examination'],
      sources: [src('rrb-gd-notice', 'Notification_GroupD.pdf', 'Demo RRB'), src('rrb-gd-corr1', 'Corrigendum_1.pdf', 'Demo RRB')],
      field_sources: fs('rrb-gd-notice', 6, 14, 14, 18),
      history: [{ date: Y(-9), field: 'Total vacancies', from: '31,875', to: '32,000', delta: '+125', source: 'Corrigendum_1.pdf, page 1' }],
    },
    {
      ...base, id: 'rrb-technician', title: 'Technician Grade III', organization: 'Demo Railway Recruitment Board', department: 'Railways', domain: 'railway', state: 'All India',
      summary: 'Workshop and signal technician posts.',
      dates: { application_open: D(-28, '10:00:00'), application_close: D(3), exam_date: Y(60) },
      education: { accepted: ['iti', 'diploma'], or_higher: false, label: 'ITI or Diploma', fields: ['engineering'], allow_final_year: false },
      age: { min: 18, max: 33, cutoff_date: cutoff, relaxation: rel(5, 5, 3, 10, 3) },
      domicile: { type: 'ALL_INDIA' }, physical: null, fee: { general: '₹500', reserved: '₹250' },
      vacancies: { total: 5500, breakdown: { UR: 2250, SC: 825, ST: 412, OBC: 1485, EWS: 528 }, pwbd: 220, ex_servicemen: 550 },
      selection: ['Computer-based test', 'Document verification'],
      sources: [src('rrb-tech-notice', 'Notification_Technician.pdf', 'Demo RRB')],
      field_sources: fs('rrb-tech-notice', 5, 9, 9, 12),
      history: [{ date: Y(-2), field: 'Application deadline', from: Y(1) ? D(1).slice(0, 10) : '', to: D(3).slice(0, 10), delta: 'Extended by 2 days', source: 'Notice_Extension.pdf, page 1' }],
    },
    {
      ...base, id: 'ssc-mts', title: 'Multi-Tasking Staff (Non-Technical)', organization: 'Demo Staff Selection Commission', department: 'Various ministries', domain: 'ssc', state: 'All India',
      summary: 'Support staff posts in central government offices.',
      dates: { application_open: D(-10, '10:00:00'), application_close: D(29), exam_date: Y(95) },
      education: { accepted: ['10th'], or_higher: true, label: '10th pass or higher', fields: ['any'] },
      age: { min: 18, max: 25, cutoff_date: cutoff, relaxation: rel(5, 5, 3, 10, 3) },
      domicile: { type: 'ALL_INDIA' }, physical: null, fee: { general: '₹100', reserved: 'No fee' },
      vacancies: { total: 8000, breakdown: { UR: 3300, SC: 1200, ST: 600, OBC: 2160, EWS: 740 }, pwbd: 320, ex_servicemen: 800 },
      selection: ['Computer-based test (two sessions)', 'Document verification'],
      sources: [src('ssc-mts-notice', 'MTS_Notice.pdf', 'Demo SSC')],
      field_sources: fs('ssc-mts-notice', 4, 8, 8, 8),
      history: [],
    },
    {
      ...base, id: 'ssc-combined-graduate', title: 'Combined Graduate Level Examination', organization: 'Demo Staff Selection Commission', department: 'Various ministries', domain: 'ssc', state: 'All India',
      summary: 'Group B and C posts for graduates.',
      dates: { application_open: D(-5, '10:00:00'), application_close: D(49), exam_date: Y(120) },
      education: { accepted: ['bachelor'], or_higher: true, label: 'Bachelor’s degree in any discipline', fields: ['any'], allow_final_year: true },
      age: { min: 18, max: 32, cutoff_date: cutoff, relaxation: rel(5, 5, 3, 10, 3) },
      domicile: { type: 'ALL_INDIA' }, physical: null, fee: { general: '₹100', reserved: 'No fee' },
      vacancies: { total: 14500, breakdown: { UR: 5800, SC: 2175, ST: 1088, OBC: 3915, EWS: 1522 }, pwbd: 580, ex_servicemen: 1450 },
      selection: ['Tier I computer-based test', 'Tier II computer-based test', 'Document verification'],
      sources: [src('ssc-cgl-notice', 'CGL_Notice.pdf', 'Demo SSC')],
      field_sources: fs('ssc-cgl-notice', 7, 11, 11, 11),
      history: [],
    },
    {
      ...base, id: 'ts-police-constable', title: 'Police Constable (Civil)', organization: 'Demo Telangana State Police Recruitment Board', department: 'Home', domain: 'police', state: 'Telangana',
      summary: 'Civil constable posts across districts.',
      dates: { application_open: D(-12, '10:00:00'), application_close: D(18), exam_date: Y(70) },
      education: { accepted: ['12th'], or_higher: true, label: '12th pass or higher', fields: ['any'] },
      age: { min: 18, max: 30, cutoff_date: cutoff, relaxation: rel(5, 5, 5, 10, 3) },
      domicile: { type: 'STATE', state: 'Telangana' }, physical: 'Height and chest standards, 1,600 m run, long jump, shot put',
      fee: { general: '₹800', reserved: '₹400' },
      vacancies: { total: 6000, breakdown: { UR: 2400, SC: 900, ST: 450, OBC: 1650, EWS: 600 }, pwbd: 240, ex_servicemen: 600 },
      selection: ['Preliminary written test', 'Physical measurement and efficiency tests', 'Final written test'],
      sources: [src('ts-pc-notice', 'Constable_Notification.pdf', 'Demo TSPRB')],
      field_sources: fs('ts-pc-notice', 3, 5, 5, 7),
      history: [],
    },
    {
      ...base, id: 'ts-junior-assistant', title: 'Junior Assistant', organization: 'Demo Telangana Public Service Commission', department: 'General Administration', domain: 'state-services', state: 'Telangana',
      summary: 'Clerical posts in state departments.',
      dates: { application_open: D(-6, '10:00:00'), application_close: D(26), exam_date: Y(90) },
      education: { accepted: ['12th'], or_higher: true, label: '12th pass (Intermediate) or higher', fields: ['any'] },
      age: { min: 18, max: 34, cutoff_date: cutoff, relaxation: rel(5, 5, 5, 10, 3) },
      domicile: { type: 'STATE', state: 'Telangana' }, physical: null, fee: { general: '₹200', reserved: '₹100' },
      vacancies: { total: 1200, breakdown: { UR: 480, SC: 180, ST: 90, OBC: 330, EWS: 120 }, pwbd: 48, ex_servicemen: 120 },
      selection: ['Written examination', 'Typing test', 'Document verification'],
      sources: [src('ts-ja-notice', 'JA_Notification.pdf', 'Demo TGPSC')],
      field_sources: fs('ts-ja-notice', 4, 6, 6, 6),
      history: [],
    },
    {
      ...base, id: 'bank-po', title: 'Probationary Officer', organization: 'Demo Public Sector Banks Consortium', department: 'Banking', domain: 'banking', state: 'All India',
      summary: 'Entry-level officer role in public sector banks.',
      dates: { application_open: D(-3, '10:00:00'), application_close: D(34), exam_date: Y(80) },
      education: { accepted: ['bachelor'], or_higher: true, label: 'Bachelor’s degree in any discipline', fields: ['any'], allow_final_year: true },
      age: { min: 20, max: 30, cutoff_date: cutoff, relaxation: rel(5, 5, 3, 10, 5) },
      domicile: { type: 'ALL_INDIA' }, physical: null, fee: { general: '₹850', reserved: '₹175' },
      vacancies: { total: 4500, breakdown: { UR: 1830, SC: 675, ST: 337, OBC: 1215, EWS: 443 }, pwbd: 180, ex_servicemen: 450 },
      selection: ['Preliminary exam', 'Main exam', 'Interview'],
      sources: [src('bank-po-notice', 'PO_Notice.pdf', 'Demo Banks Consortium')],
      field_sources: fs('bank-po-notice', 5, 8, 8, 8),
      history: [],
    },
    {
      ...base, id: 'defence-tech-officer', title: 'Technical Graduate Officer', organization: 'Demo Defence Services Selection Board', department: 'Defence', domain: 'defence', state: 'All India',
      summary: 'Short-service commission for engineering graduates.',
      dates: { application_open: D(-8, '10:00:00'), application_close: D(44), exam_date: null },
      education: { accepted: ['bachelor'], or_higher: true, label: 'Engineering degree (final-year candidates may apply)', fields: ['engineering'], allow_final_year: true },
      age: { min: 21, max: 27, cutoff_date: cutoff, relaxation: rel(0, 0, 0, 0, 0) },
      domicile: { type: 'ALL_INDIA' }, physical: 'Medical and physical fitness standards as per service rules',
      fee: { general: 'No fee', reserved: 'No fee' },
      vacancies: { total: 380, breakdown: { UR: 150, SC: 57, ST: 28, OBC: 103, EWS: 42 }, pwbd: 0, ex_servicemen: 0 },
      selection: ['Shortlisting', 'Selection board interview', 'Medical examination'],
      sources: [src('def-tgo-notice', 'TGO_Notice.pdf', 'Demo DSSB')],
      field_sources: fs('def-tgo-notice', 3, 4, 4, 9),
      history: [],
    },
    {
      ...base, id: 'research-associate', title: 'Research Associate', organization: 'Demo National Science Laboratory', department: 'Science and Technology', domain: 'research', state: 'All India',
      summary: 'Fixed-term research posts in laboratory projects.',
      dates: { application_open: D(-14, '10:00:00'), application_close: D(60), exam_date: null },
      education: { accepted: ['phd'], or_higher: false, label: 'PhD in a relevant science or engineering discipline', fields: ['science', 'engineering'], allow_final_year: true },
      age: { min: 21, max: 35, cutoff_date: cutoff, relaxation: rel(5, 5, 3, 10, 0) },
      experience_years: 2,
      domicile: { type: 'ALL_INDIA' }, physical: null, fee: { general: 'No fee', reserved: 'No fee' },
      vacancies: { total: 60, breakdown: { UR: 24, SC: 9, ST: 4, OBC: 17, EWS: 6 }, pwbd: 3, ex_servicemen: 0 },
      selection: ['Shortlisting', 'Presentation and interview'],
      sources: [src('nsl-ra-notice', 'RA_Advertisement.pdf', 'Demo NSL')],
      field_sources: fs('nsl-ra-notice', 2, 3, 3, 3),
      history: [],
    },
    {
      ...base, id: 'postal-gds', title: 'Gramin Dak Sevak', organization: 'Demo Postal Circle', department: 'Posts', domain: 'postal', state: 'All India',
      summary: 'Village post office staff roles.',
      dates: { application_open: D(8, '10:00:00'), application_close: D(38), exam_date: null },
      education: { accepted: ['10th'], or_higher: true, label: '10th pass with Mathematics and English', fields: ['any'], subjects: ['Mathematics', 'English'], subjects_stage: '10th' },
      age: { min: 18, max: 40, cutoff_date: cutoff, relaxation: rel(5, 5, 3, 10, 3) },
      domicile: { type: 'ALL_INDIA' }, physical: null, fee: { general: '₹100', reserved: 'No fee' },
      vacancies: { total: 21000, breakdown: { UR: 8600, SC: 3150, ST: 1575, OBC: 5670, EWS: 2005 }, pwbd: 840, ex_servicemen: 2100 },
      selection: ['Merit list based on 10th marks', 'Document verification'],
      sources: [src('postal-gds-notice', 'GDS_Notification.pdf', 'Demo Postal Circle')],
      field_sources: fs('postal-gds-notice', 3, 5, 5, 5),
      history: [],
    },
    {
      ...base, id: 'ssc-stenographer', title: 'Stenographer Grade C and D', organization: 'Demo Staff Selection Commission', department: 'Various ministries', domain: 'ssc', state: 'All India',
      summary: 'Stenographer posts in central offices.',
      dates: { application_open: D(-45, '10:00:00'), application_close: D(-8), exam_date: Y(40) },
      education: { accepted: ['12th'], or_higher: true, label: '12th pass or higher', fields: ['any'] },
      age: { min: 18, max: 27, cutoff_date: cutoff, relaxation: rel(5, 5, 3, 10, 3) },
      domicile: { type: 'ALL_INDIA' }, physical: null, fee: { general: '₹100', reserved: 'No fee' },
      vacancies: { total: 1500, breakdown: { UR: 600, SC: 225, ST: 112, OBC: 405, EWS: 158 }, pwbd: 60, ex_servicemen: 150 },
      selection: ['Computer-based test', 'Skill test'],
      sources: [src('ssc-steno-notice', 'Steno_Notice.pdf', 'Demo SSC')],
      field_sources: fs('ssc-steno-notice', 4, 7, 7, 7),
      history: [],
    },
    // Not published: extracted by the pipeline but still awaiting human verification. Must never be shown to users.
    {
      ...base, id: 'draft-unverified', lifecycle: 'REVIEW_REQUIRED', verification: { status: 'PENDING', method: 'Low extraction confidence' },
      title: 'Unverified Draft Recruitment', organization: 'Unknown source', department: '', domain: 'other', state: 'All India', summary: '',
      dates: { application_open: D(-1), application_close: D(10) }, education: { accepted: ['10th'], label: '10th pass' },
      age: { min: 18, max: 30, cutoff_date: cutoff }, domicile: { type: 'ALL_INDIA' }, vacancies: { total: 0, breakdown: {} }, sources: [], field_sources: {}, history: [],
    },
  ];
}

const PUBLIC_LIFECYCLE = new Set(['PUBLISHED', 'UPDATED', 'APPLICATION_CLOSED', 'EXAM_PHASE']);
function publishedJobs(now) {
  return buildJobs(now).filter((j) => PUBLIC_LIFECYCLE.has(j.lifecycle) && j.verification.status === 'VERIFIED');
}

module.exports = { buildJobs, publishedJobs };
