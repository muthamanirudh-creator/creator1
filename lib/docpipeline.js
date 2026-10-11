// Document pipeline: validate -> scan -> text extraction -> OCR -> layout -> tables -> sections.
// Everything here is deterministic. No AI.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const MAX_BYTES = 25 * 1024 * 1024;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function detectType(buf) {
  const head = buf.slice(0, 8).toString('latin1');
  if (head.startsWith('%PDF')) return 'application/pdf';
  if (buf[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (head.startsWith('PK')) {
    const names = zipNames(buf);
    if (names.some((n) => n === 'word/document.xml')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return 'application/zip';
  }
  const s = buf.slice(0, 2000).toString('utf8').toLowerCase();
  if (s.includes('<html') || s.includes('<!doctype html') || s.includes('<body')) return 'text/html';
  return 'application/octet-stream';
}

function zipNames(buf) {
  const tmp = tmpFile('.zip', buf);
  try { return execFileSync('unzip', ['-Z1', tmp], { encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch { return []; } finally { fs.rmSync(tmp, { force: true }); }
}
function tmpFile(ext, buf) {
  const p = path.join(os.tmpdir(), `gc-${crypto.randomBytes(6).toString('hex')}${ext}`);
  if (buf) fs.writeFileSync(p, buf);
  return p;
}

const SUPPORTED = ['application/pdf', 'image/png', 'image/jpeg', 'text/html', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

function validateFile(buf) {
  const errors = [];
  if (!buf || !buf.length) errors.push('File is empty.');
  if (buf && buf.length > MAX_BYTES) errors.push('File is larger than 25 MB.');
  const mime = buf && buf.length ? detectType(buf) : 'application/octet-stream';
  if (!SUPPORTED.includes(mime)) errors.push(`Unsupported file type (${mime}).`);
  if (mime === 'application/pdf') {
    const s = buf.toString('latin1');
    if (!s.includes('%%EOF')) errors.push('PDF looks truncated (no end-of-file marker).');
    if (/\/Encrypt\b/.test(s)) errors.push('PDF is encrypted. Provide an unlocked copy.');
  }
  return { ok: errors.length === 0, errors, mime };
}

// Virus scan. Uses ClamAV when installed; otherwise a heuristic scanner that rejects active content.
function scan(buf, mime) {
  const clam = spawnSync('which', ['clamscan']);
  if (clam.status === 0) {
    const p = tmpFile('.bin', buf);
    const r = spawnSync('clamscan', ['--no-summary', p], { encoding: 'utf8' });
    fs.rmSync(p, { force: true });
    return r.status === 0 ? { status: 'CLEAN', method: 'clamav', findings: [] } : { status: 'REJECTED', method: 'clamav', findings: [r.stdout.trim()] };
  }
  const s = buf.toString('latin1');
  const findings = [];
  if (s.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) findings.push('EICAR test signature');
  if (mime === 'application/pdf') {
    if (/\/(JavaScript|JS)\b/.test(s)) findings.push('PDF contains JavaScript');
    if (/\/Launch\b/.test(s)) findings.push('PDF contains a Launch action');
    if (/\/EmbeddedFile\b/.test(s)) findings.push('PDF contains an embedded file');
  }
  if (mime.includes('wordprocessingml') && zipNames(buf).some((n) => /vbaProject\.bin$/.test(n))) findings.push('DOCX contains macros');
  if (mime === 'text/html' && /<script[\s>]/i.test(s)) findings.push('HTML contains scripts');
  return { status: findings.length ? 'REJECTED' : 'CLEAN', method: 'heuristic (ClamAV not installed)', findings };
}

// ---------- layout helpers ----------
function detectColumns(layoutText) {
  const lines = layoutText.split('\n').filter((l) => l.trim().length > 20);
  if (lines.length < 12) return 1;
  const width = Math.max(...lines.map((l) => l.length));
  const lo = Math.floor(width * 0.3), hi = Math.floor(width * 0.7);
  let run = 0, best = 0;
  for (let x = lo; x < hi; x++) {
    const blank = lines.filter((l) => (l[x] || ' ') === ' ').length / lines.length;
    if (blank >= 0.9) { run++; best = Math.max(best, run); } else run = 0;
  }
  return best >= 3 ? 2 : 1;
}

function detectTables(layoutText) {
  const tables = []; let cur = [];
  const flush = () => { if (cur.length >= 3 && new Set(cur.map((r) => r.length)).size === 1) tables.push(cur); cur = []; };
  for (const line of layoutText.split('\n')) {
    const cells = line.trim().split(/\s{3,}/).map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 2) cur.push(cells); else flush();
  }
  flush();
  return tables;
}

const SECTION_RX = /^[ \t]*(\d+(?:\.\d+)*)[.)]?[ \t]+([A-Za-z\u0900-\u0D7F][^\n]{2,90})$/gm;
function detectSections(pageText) {
  const out = []; let m;
  SECTION_RX.lastIndex = 0;
  while ((m = SECTION_RX.exec(pageText))) out.push({ section: m[1], heading: m[2].trim(), start: m.index, end: m.index + m[0].length });
  return out;
}
// Which section does a character offset on a page belong to? Falls back to the last section of earlier pages.
function sectionAt(sectionsByPage, page, offset) {
  for (let p = page; p >= 1; p--) {
    const list = (sectionsByPage[p] || []).filter((s) => p < page || s.start <= offset);
    if (list.length) return list[list.length - 1].section;
  }
  return null;
}

// ---------- OCR ----------
function installedOcrLangs() {
  const r = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').slice(1).map((s) => s.trim()).filter((l) => l && l !== 'osd');
}
function ocrImage(file, langs) {
  const have = installedOcrLangs();
  const use = (langs || ['eng']).filter((l) => have.includes(l));
  const lang = (use.length ? use : ['eng']).join('+');
  const tsv = spawnSync('tesseract', [file, 'stdout', '-l', lang, 'tsv'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (tsv.status !== 0) throw new Error(`OCR failed: ${tsv.stderr}`);
  const words = []; const lines = new Map(); const confs = [];
  for (const row of tsv.stdout.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || !c[11] || !c[11].trim()) continue;
    const conf = parseFloat(c[10]); if (conf >= 0) confs.push(conf);
    const key = `${c[2]}-${c[3]}-${c[4]}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(c[11]);
  }
  const text = [...lines.values()].map((w) => w.join(' ')).join('\n');
  return { text, confidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length)) / 100 : 0, lang };
}

function pdfPageCount(file) {
  const out = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  return parseInt(/Pages:\s+(\d+)/.exec(out)[1], 10);
}

function extractPdf(buf, opts) {
  const file = tmpFile('.pdf', buf);
  try {
    const n = pdfPageCount(file);
    const pages = [];
    for (let p = 1; p <= n; p++) {
      const layout = execFileSync('pdftotext', ['-layout', '-f', String(p), '-l', String(p), file, '-'], { encoding: 'utf8' }).replace(/\f/g, '');
      if (layout.replace(/\s/g, '').length >= 40) {
        const columns = detectColumns(layout);
        // Multi-column pages are read in logical order; single-column pages keep layout for tables.
        const text = columns > 1 ? execFileSync('pdftotext', ['-f', String(p), '-l', String(p), file, '-'], { encoding: 'utf8' }).replace(/\f/g, '') : layout;
        pages.push({ page_number: p, text: text.trim(), method: 'TEXT_LAYER', ocr_confidence: null, columns, tables: detectTables(layout) });
      } else {
        const prefix = tmpFile('');
        execFileSync('pdftoppm', ['-r', '200', '-f', String(p), '-l', String(p), '-png', '-singlefile', file, prefix]);
        const img = `${prefix}.png`;
        try {
          const o = ocrImage(img, opts.ocrLangs);
          pages.push({ page_number: p, text: o.text.trim(), method: 'OCR', ocr_confidence: o.confidence, columns: 1, tables: [] });
        } finally { fs.rmSync(img, { force: true }); }
      }
    }
    return pages;
  } finally { fs.rmSync(file, { force: true }); }
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x20B9;|&#8377;/g, '₹');
function extractHtml(buf) {
  let h = buf.toString('utf8').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<\/t[dh]>/gi, '   ').replace(/<\/(p|div|tr|li|h\d|br)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  const text = decode(h).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return [{ page_number: 1, text, method: 'HTML', ocr_confidence: null, columns: 1, tables: detectTables(text) }];
}
function extractDocx(buf) {
  const f = tmpFile('.docx', buf);
  try {
    const xml = execFileSync('unzip', ['-p', f, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const parts = xml.split(/<w:br w:type="page"\/>|<w:lastRenderedPageBreak\/>/);
    return parts.map((x, i) => {
      const t = decode(x.replace(/<\/w:tc>/g, '   ').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')).trim();
      return { page_number: i + 1, text: t, method: 'DOCX', ocr_confidence: null, columns: 1, tables: detectTables(t) };
    }).filter((p) => p.text);
  } finally { fs.rmSync(f, { force: true }); }
}
function extractImage(buf, opts) {
  const f = tmpFile('.img', buf);
  try { const o = ocrImage(f, opts.ocrLangs); return [{ page_number: 1, text: o.text.trim(), method: 'OCR', ocr_confidence: o.confidence, columns: 1, tables: [] }]; }
  finally { fs.rmSync(f, { force: true }); }
}

function extractPages(buf, mime, opts = {}) {
  if (mime === 'application/pdf') return extractPdf(buf, opts);
  if (mime === 'text/html') return extractHtml(buf);
  if (mime.includes('wordprocessingml')) return extractDocx(buf);
  if (mime.startsWith('image/')) return extractImage(buf, opts);
  throw new Error(`Cannot extract ${mime}`);
}

module.exports = { sha256, detectType, validateFile, scan, extractPages, detectSections, sectionAt, detectColumns, detectTables, installedOcrLangs, MAX_BYTES };
