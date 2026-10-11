// Generates fictional sample notifications (original + amendment) for demos and tests.
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const SCENARIOS = {
  original: { total: 1000, breakdown: 'UR 400, SC 150, ST 75, OBC 275, EWS 100', pwbd: 40, close: '24 October 2026', exam: '20 December 2026', age: '18 to 30 years as on 01 January 2026' },
  amendment: { total: 1125, breakdown: 'UR 450, SC 169, ST 84, OBC 309, EWS 113', pwbd: 45, close: '07 November 2026', exam: '20 December 2026', age: '18 to 32 years as on 01 January 2026' },
};

function pagesFor(s, opts = {}) {
  const host = opts.host || 'psc.example.gov.in';
  return [
    ['DEMO STATE PUBLIC SERVICE COMMISSION', 'Notification No. 05/2026' + (opts.amend ? ' (Amendment 1)' : ''), 'Recruitment of Junior Technical Assistant', 'Department: Technical Education',
      '1. Important Dates', 'Application opens: 05 October 2026 (10:00 IST)', `Last date to apply: ${s.close} (23:59 IST)`, `Written examination: tentatively ${s.exam}`, `Online application: https://${host}/apply`],
    ['2. Vacancies', `Total vacancies: ${s.total.toLocaleString('en-US')}`, s.breakdown, `PwBD vacancies included above: ${s.pwbd}`, 'Ex-servicemen vacancies included above: 50'],
    ['3. Eligibility', '3.1 Education: B.Tech / B.E. in any discipline. Final-year candidates are not eligible.', `3.2 Age limit: ${s.age}.`,
      '3.3 Age relaxation: SC/ST 5 years, OBC 3 years, PwBD 10 years, Ex-servicemen 5 years.', '3.4 Domicile: Candidates must hold Telangana domicile.'],
    ['4. Fee', 'Fee: General Rs. 500, SC/ST Rs. 250. Pay only through the official online portal.', '5. Selection process', 'Selection process: Written examination; Document verification; Medical examination'],
  ].concat(opts.extraPage ? [opts.extraPage] : []);
}

function build(file, pages) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 56 });
    const out = fs.createWriteStream(file); doc.pipe(out);
    pages.forEach((lines, i) => { if (i) doc.addPage(); doc.font('Helvetica').fontSize(12); lines.forEach((l) => doc.text(l, { paragraphGap: 8 })); });
    doc.end(); out.on('finish', resolve);
  });
}

async function main(dir = path.join(__dirname, '..', 'samples')) {
  fs.mkdirSync(dir, { recursive: true });
  await build(path.join(dir, 'notification-original.pdf'), pagesFor(SCENARIOS.original));
  await build(path.join(dir, 'notification-amendment1.pdf'), pagesFor(SCENARIOS.amendment, { amend: true }));
  await build(path.join(dir, 'notification-suspicious.pdf'), pagesFor(SCENARIOS.original, { host: 'psc-example-gov.in', extraPage: ['Pay a processing fee to UPI id recruit.fees@okaxis to confirm your application.'] }));
  return dir;
}
if (require.main === module) main().then((d) => console.log('Sample PDFs written to', d));
module.exports = { main, pagesFor, SCENARIOS, build };
