'use strict';
// GOLD DATASET FOR EXTRACTION EVALUATION.
//
// PROVENANCE: every case below is SYNTHETIC. The text was written by hand to imitate the layouts, wording and traps seen in
// SSC, UPSC, railway (RRB), banking (IBPS/SBI) and state recruitment notices, and each gold value was written down BEFORE the
// extractor was run on it. They are NOT copies of real notices, so results on them say nothing about real-notice accuracy.
//
// HOW TO ADD A REAL NOTICE (this is what turns the report into evidence):
//   1. Save the original PDF/page; record its sha256 and official URL.
//   2. Two people independently read it and fill `gold` from the document alone (not from the extractor's output).
//   3. Reconcile disagreements, then set provenance:'REAL', adjudicators:2, source_url, document_sha256.
//   4. Paste the page text (as extracted by lib/docpipeline) into `pages`. Run: npm run eval:extraction
// `gold` omits a field (or sets null) when the notice does NOT state it: the extractor must then abstain.

const P = (...pages) => pages.map((t, i) => ({ page_number: i + 1, text: t.trim() }));
const D = (o) => ({ provenance: 'SYNTHETIC', adjudicators: 1, ...o });
const SCOPE = ['dates.application_open', 'dates.application_close', 'dates.exam_date', 'vacancies.total', 'age.min', 'age.max', 'age.cutoff_date', 'education', 'domicile'];

module.exports = [
  D({ id: 'ssc-cgl-labelled', family: 'SSC', fields_in_scope: SCOPE, notes: 'clean labelled lines', pages: P(`
STAFF SELECTION COMMISSION
Notice of Combined Graduate Level Examination
Recruitment of Assistant Section Officer
Department: Various Ministries
Application opens: 05 October 2026 (10:00 IST)
Last date to apply: 24 October 2026 (23:59 IST)
Written examination: tentatively 20 December 2026
Total vacancies: 14,582
Education: Bachelor's degree in any discipline from a recognised university
Age limit: 18 to 32 years as on 01 January 2026
Domicile: not required, open to all India`),
    gold: { title: 'Assistant Section Officer', 'dates.application_open': '2026-10-05', 'dates.application_close': '2026-10-24', 'dates.exam_date': '2026-12-20', 'vacancies.total': 14582, 'age.min': 18, 'age.max': 32, 'age.cutoff_date': '2026-01-01', education: { accepted: ['bachelor'], or_higher: false, fields: ['any'] }, domicile: { type: 'ALL_INDIA' } } }),

  D({ id: 'ssc-chsl-slash-dates', family: 'SSC', fields_in_scope: SCOPE, notes: 'dd/mm/yyyy dates', pages: P(`
STAFF SELECTION COMMISSION
Recruitment of Lower Division Clerk
Application opens: 12/09/2026
Last date to apply: 11/10/2026
Examination date: 15/12/2026
Total vacancies: 3,712
Education: 12th pass or higher from a recognised board
Age limit: 18 to 27 years as on 01/08/2026`),
    gold: { title: 'Lower Division Clerk', 'dates.application_open': '2026-09-12', 'dates.application_close': '2026-10-11', 'dates.exam_date': '2026-12-15', 'vacancies.total': 3712, 'age.min': 18, 'age.max': 27, 'age.cutoff_date': '2026-08-01', education: { accepted: ['12th'], or_higher: true, fields: [] } } }),

  D({ id: 'upsc-prose-dates', family: 'UPSC', fields_in_scope: [...SCOPE, 'age.max_kind'], derived_fields: ['age.max_kind'], notes: 'prose sentences, ordinal days, no colon labels: stresses recall; "must not have attained 32" means max_kind MUST_NOT_HAVE_ATTAINED', pages: P(`
UNION PUBLIC SERVICE COMMISSION
Civil Services (Preliminary) Examination 2026
The online application will start on 4th November, 2026 and the last date for receipt of applications is 24th November, 2026.
The Preliminary Examination will be held on 24 May 2027.
The number of vacancies to be filled is 979.
A candidate must hold a Bachelor's degree from a recognised university.
A candidate must have attained the age of 21 years and must not have attained the age of 32 years on 1st August, 2026.`),
    gold: { 'dates.application_open': '2026-11-04', 'dates.application_close': '2026-11-24', 'dates.exam_date': '2027-05-24', 'vacancies.total': 979, 'age.min': 21, 'age.max': 32, 'age.max_kind': 'MUST_NOT_HAVE_ATTAINED', 'age.cutoff_date': '2026-08-01', education: { accepted: ['bachelor'], or_higher: false, fields: ['any'] } } }),

  D({ id: 'rrb-group-d-tabular', family: 'RRB', fields_in_scope: SCOPE, notes: 'colon labels, comma vacancies, ITI', pages: P(`
RAILWAY RECRUITMENT BOARD
Centralised Employment Notice
Recruitment of Track Maintainer Grade IV
Applications open: 23 January 2027 (10:00 IST)
Application closes: 22 February 2027 (23:59 IST)
Total vacancies: 32,438
Education: 10th pass or ITI from a recognised institute
Age limit: 18 to 33 years as on 01 July 2027`, `
Physical standards: lift and carry 35 kg, run 1000 m in 4 minutes 15 seconds
Domicile: All India, no domicile requirement`),
    gold: { title: 'Track Maintainer Grade IV', 'dates.application_open': '2027-01-23', 'dates.application_close': '2027-02-22', 'vacancies.total': 32438, 'age.min': 18, 'age.max': 33, 'age.cutoff_date': '2027-07-01', education: { accepted: ['10th', 'iti'], or_higher: false, fields: [] }, domicile: { type: 'ALL_INDIA' } } }),

  D({ id: 'rrb-ntpc-posts-wording', family: 'RRB', fields_in_scope: SCOPE, notes: '"posts" instead of "vacancies"', pages: P(`
RAILWAY RECRUITMENT BOARD
Recruitment of Goods Guard
Application opens: 14 September 2026
Closing date: 13 October 2026
Number of posts: 5,810
Education: Bachelor's degree in any discipline
Age limit: 18 to 36 years as on 01 January 2027`),
    gold: { title: 'Goods Guard', 'dates.application_open': '2026-09-14', 'dates.application_close': '2026-10-13', 'vacancies.total': 5810, 'age.min': 18, 'age.max': 36, 'age.cutoff_date': '2027-01-01', education: { accepted: ['bachelor'], or_higher: false, fields: ['any'] } } }),

  D({ id: 'ibps-po-banking', family: 'BANKING', fields_in_scope: SCOPE, notes: 'banking layout, degree, dd-Mon-yyyy', pages: P(`
INSTITUTE OF BANKING PERSONNEL SELECTION
Common Recruitment Process for Probationary Officers
Recruitment of Probationary Officer
Start date: 01-Aug-2026
Last date to apply: 21-Aug-2026
Online exam: tentatively 05 October 2026
Total vacancies: 4,455
Education: Graduation in any discipline from a recognised university
Age limit: 20 to 30 years as on 01 August 2026`),
    gold: { title: 'Probationary Officer', 'dates.application_open': '2026-08-01', 'dates.application_close': '2026-08-21', 'dates.exam_date': '2026-10-05', 'vacancies.total': 4455, 'age.min': 20, 'age.max': 30, 'age.cutoff_date': '2026-08-01', education: { accepted: ['bachelor'], or_higher: false, fields: ['any'] } } }),

  D({ id: 'sbi-clerk-final-year', family: 'BANKING', fields_in_scope: SCOPE, notes: 'final-year clause', pages: P(`
STATE BANK OF INDIA
Recruitment of Junior Associate (Customer Support & Sales)
Application opens: 17 December 2026
Last date to apply: 07 January 2027
Total vacancies: 8,773
Education: Graduation in any discipline. Final-year candidates may apply provided they complete the degree by 31 January 2027.
Age limit: 20 to 28 years as on 01 April 2026`),
    gold: { title: 'Junior Associate (Customer Support & Sales)', 'dates.application_open': '2026-12-17', 'dates.application_close': '2027-01-07', 'vacancies.total': 8773, 'age.min': 20, 'age.max': 28, 'age.cutoff_date': '2026-04-01', education: { accepted: ['bachelor'], or_higher: false, fields: ['any'], allow_final_year: true } } }),

  D({ id: 'tspsc-state-domicile', family: 'STATE_PSC', fields_in_scope: SCOPE, notes: 'state domicile', pages: P(`
TELANGANA STATE PUBLIC SERVICE COMMISSION
Notification No. 12/2026
Recruitment of Group II Services
State: Telangana
Application opens: 05 November 2026 (10:00 IST)
Last date to apply: 04 December 2026 (23:59 IST)
Total vacancies: 783
Education: Bachelor's degree in any discipline
Age limit: 18 to 44 years as on 01 July 2026
Domicile: Candidates must hold Telangana domicile`),
    gold: { title: 'Group II Services', 'dates.application_open': '2026-11-05', 'dates.application_close': '2026-12-04', 'vacancies.total': 783, 'age.min': 18, 'age.max': 44, 'age.cutoff_date': '2026-07-01', education: { accepted: ['bachelor'], or_higher: false, fields: ['any'] }, domicile: { type: 'STATE', state: 'Telangana' } } }),

  D({ id: 'up-police-constable', family: 'POLICE', fields_in_scope: SCOPE, notes: '12th pass, domicile', pages: P(`
UTTAR PRADESH POLICE RECRUITMENT AND PROMOTION BOARD
Recruitment of Constable (Civil Police)
State: Uttar Pradesh
Application opens: 20 October 2026
Last date to apply: 19 November 2026
Total vacancies: 60,244
Education: 12th pass from a recognised board
Age limit: 18 to 22 years as on 01 July 2026
Domicile: Candidates must hold Uttar Pradesh domicile`),
    gold: { title: 'Constable (Civil Police)', 'dates.application_open': '2026-10-20', 'dates.application_close': '2026-11-19', 'vacancies.total': 60244, 'age.min': 18, 'age.max': 22, 'age.cutoff_date': '2026-07-01', education: { accepted: ['12th'], or_higher: false, fields: [] }, domicile: { type: 'STATE', state: 'Uttar Pradesh' } } }),

  D({ id: 'defence-agniveer-range', family: 'DEFENCE', fields_in_scope: SCOPE, notes: 'age expressed as a date-of-birth window: extractor must abstain on min/max/cutoff', pages: P(`
INDIAN ARMY
Recruitment of Agniveer General Duty
Application opens: 10 March 2027
Last date to apply: 10 April 2027
Education: 10th pass with 45 percent marks
Eligibility: candidates born between 01 October 2005 and 01 April 2009 (both days inclusive) may apply.`),
    gold: { title: 'Agniveer General Duty', 'dates.application_open': '2027-03-10', 'dates.application_close': '2027-04-10', education: { accepted: ['10th'], or_higher: false, fields: [] } } }),

  D({ id: 'no-vacancy-stated', family: 'STATE_PSC', fields_in_scope: SCOPE, notes: 'vacancies not stated: must abstain, never invent', pages: P(`
KERALA PUBLIC SERVICE COMMISSION
Recruitment of Village Field Assistant
State: Kerala
Application opens: 01 February 2027
Last date to apply: 28 February 2027
Education: 10th pass
Age limit: 18 to 36 years as on 01 January 2027
The number of vacancies will be notified later as they are reported.`),
    gold: { title: 'Village Field Assistant', 'dates.application_open': '2027-02-01', 'dates.application_close': '2027-02-28', 'age.min': 18, 'age.max': 36, 'age.cutoff_date': '2027-01-01', education: { accepted: ['10th'], or_higher: false, fields: [] } } }),

  D({ id: 'corrigendum-extension', family: 'SSC', fields_in_scope: SCOPE, notes: 'corrigendum: the NEW date is the gold value; the old date is quoted for context', pages: P(`
STAFF SELECTION COMMISSION
CORRIGENDUM
Recruitment of Multi Tasking Staff
In partial modification of the earlier notice, the last date to apply, earlier 30 September 2026, is extended.
Last date to apply: 14 October 2026 (23:59 IST)
Total vacancies: 9,000`),
    gold: { title: 'Multi Tasking Staff', 'dates.application_close': '2026-10-14', 'vacancies.total': 9000 } }),

  D({ id: 'two-dates-same-line', family: 'RRB', fields_in_scope: SCOPE, notes: 'a fee-payment date shares the line with the closing date', pages: P(`
RAILWAY RECRUITMENT BOARD
Recruitment of Assistant Loco Pilot
Application opens: 05 June 2027
Last date to apply: 04 July 2027 (fee payment up to 06 July 2027)
Total vacancies: 18,799
Education: ITI or Diploma in engineering
Age limit: 18 to 30 years as on 01 July 2027`),
    gold: { title: 'Assistant Loco Pilot', 'dates.application_open': '2027-06-05', 'dates.application_close': '2027-07-04', 'vacancies.total': 18799, 'age.min': 18, 'age.max': 30, 'age.cutoff_date': '2027-07-01', education: { accepted: ['iti', 'diploma'], or_higher: false, fields: ['engineering'] } } }),

  D({ id: 'age-by-category-only', family: 'UPSC', fields_in_scope: SCOPE, notes: 'age limits given per category, no single range: abstain', pages: P(`
UNION PUBLIC SERVICE COMMISSION
Recruitment of Assistant Commandant
Application opens: 01 December 2026
Last date to apply: 21 December 2026
Total vacancies: 506
Education: Bachelor's degree
Age: General 20-25 years, OBC 20-28 years, SC/ST 20-30 years, as on 01 August 2026.`),
    gold: { title: 'Assistant Commandant', 'dates.application_open': '2026-12-01', 'dates.application_close': '2026-12-21', 'vacancies.total': 506, education: { accepted: ['bachelor'], or_higher: false, fields: [] } } }),

  D({ id: 'vacancy-tentative-note', family: 'STATE_PSC', fields_in_scope: SCOPE, notes: 'vacancy flagged tentative', pages: P(`
ANDHRA PRADESH PUBLIC SERVICE COMMISSION
Recruitment of Junior Lecturer
State: Andhra Pradesh
Application opens: 15 August 2026
Last date to apply: 14 September 2026
Total vacancies: 1,392 (tentative, subject to change)
Education: Master's degree in the concerned subject
Age limit: 18 to 42 years as on 01 July 2026`),
    gold: { title: 'Junior Lecturer', 'dates.application_open': '2026-08-15', 'dates.application_close': '2026-09-14', 'vacancies.total': 1392, 'age.min': 18, 'age.max': 42, 'age.cutoff_date': '2026-07-01', education: { accepted: ['master'], or_higher: false, fields: [] } } }),

  D({ id: 'postal-gds-no-exam', family: 'STATE_PSC', fields_in_scope: SCOPE, notes: 'no exam date at all (merit based): must abstain on exam_date', pages: P(`
DEPARTMENT OF POSTS
Recruitment of Gramin Dak Sevak
Application opens: 03 February 2027
Last date to apply: 05 March 2027
Total vacancies: 21,413
Education: 10th pass with Mathematics and English
Age limit: 18 to 40 years as on 03 March 2027
Selection is by merit based on 10th marks; there is no written examination.`),
    gold: { title: 'Gramin Dak Sevak', 'dates.application_open': '2027-02-03', 'dates.application_close': '2027-03-05', 'vacancies.total': 21413, 'age.min': 18, 'age.max': 40, 'age.cutoff_date': '2027-03-03', education: { accepted: ['10th'], or_higher: false, fields: [] } } }),

  D({ id: 'hindi-english-mixed-dates', family: 'STATE_PSC', fields_in_scope: SCOPE, notes: 'month names in full, comma-separated, "to" ranges', pages: P(`
RAJASTHAN PUBLIC SERVICE COMMISSION
Recruitment of Patwari
State: Rajasthan
Application opens: October 05, 2026
Last date to apply: November 04, 2026
Examination date: January 17, 2027
Total vacancies: 2,020
Education: Bachelor's degree
Age limit: 18 to 40 years as on 01 January 2027
Domicile: Candidates must hold Rajasthan domicile`),
    gold: { title: 'Patwari', 'dates.application_open': '2026-10-05', 'dates.application_close': '2026-11-04', 'dates.exam_date': '2027-01-17', 'vacancies.total': 2020, 'age.min': 18, 'age.max': 40, 'age.cutoff_date': '2027-01-01', education: { accepted: ['bachelor'], or_higher: false, fields: [] }, domicile: { type: 'STATE', state: 'Rajasthan' } } }),

  D({ id: 'distractor-numbers', family: 'RRB', fields_in_scope: SCOPE, notes: 'other numbers near labels: a fee line and an old notice number must not be taken as vacancies or age', pages: P(`
RAILWAY RECRUITMENT BOARD
Notice No. 2026/45 (supersedes Notice No. 2019/12)
Recruitment of Junior Engineer
Application opens: 01 March 2027
Last date to apply: 31 March 2027
Total vacancies: 7,951
Fee: General Rs. 500, SC/ST Rs. 250
Education: Diploma or Degree in engineering
Age limit: 18 to 33 years as on 01 January 2027`),
    gold: { title: 'Junior Engineer', 'dates.application_open': '2027-03-01', 'dates.application_close': '2027-03-31', 'vacancies.total': 7951, 'age.min': 18, 'age.max': 33, 'age.cutoff_date': '2027-01-01', education: { accepted: ['diploma', 'bachelor'], or_higher: false, fields: ['engineering'] } } }),
];
