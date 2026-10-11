'use strict';
// Regression checks for the AI evidence audit / review-purpose / project-ZIP import upgrade.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const rt = fs.readFileSync(path.join(__dirname, '../../frontend/app-runtime.js'), 'utf8');
const verifier = fs.readFileSync(path.join(__dirname, '../../frontend/gate-pass-verify.html'), 'utf8');

// 1. Examiner simulation must never be stranded when the AI audit is unavailable.
const liveStart = rt.indexOf('const startLive = async () => {');
assert.ok(liveStart > 0, 'startLive not found');
const live = rt.slice(liveStart, rt.indexOf('const restart = () =>', liveStart));
assert.match(live, /if \(!d && hasAiKey\) d = await runDesk\(\)/);
assert.match(live, /d = await runOfflineDesk\(\)/, 'startLive must fall back to the offline evidence review');
assert.match(live, /setStep\(1\)/, 'startLive must return to the profile step if no review could be produced');

// 2. Review purpose reaches every AI prompt and the report.
assert.ok((rt.match(/prPurposeOf\(profile\.reviewPurpose\)/g) || []).length >= 4);
assert.match(rt, /reviewPurposeLabel: prPurposeOf\(profile\.reviewPurpose\)\.label/);

// 3. First valid scan must not look like a rejection (guard needs a positive signal).
assert.match(verifier, /ACCEPTED — QR NOW EXPIRED/);
assert.doesNotMatch(verifier, /state invalid">⛔ QR EXPIRED/);
assert.match(verifier, /ALREADY USED — EXPIRED/, 'a second scan must still be rejected');

// 4. Behavioural: the ZIP reader ignores node_modules and reads deflated + stored members.
const src = rt.slice(rt.indexOf('async function prReadZipBundle'), rt.indexOf('async function prReadProjectImport'));
const prReadZipBundle = new Function(`${src}; return prReadZipBundle;`)();
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function buildZip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content, deflate] of files) {
    const nameB = Buffer.from(name), data = Buffer.from(content), comp = deflate ? zlib.deflateRawSync(data) : data;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameB, comp); centrals.push(ch, nameB); offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
(async () => {
  const files = [];
  for (let i = 0; i < 200; i++) files.push([`node_modules/pkg${i}/index.js`, 'module.exports = 1;', true]);
  files.push(['README.md', '# Demo\nAbstract: A project that does something useful for students.', true]);
  files.push(['src/app.js', 'console.log("hello");', false]);
  const buf = buildZip(files);
  const out = await prReadZipBundle({ size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
  assert.equal(out.fileCount, 2, 'node_modules entries must be ignored');
  assert.deepEqual(out.files.sort(), ['README.md', 'src/app.js']);
  assert.ok(out.textEntries.some(t => t.name === 'README.md' && /Abstract/.test(t.text)), 'deflated README must be read');
  assert.ok(out.textEntries.some(t => t.name === 'src/app.js' && /hello/.test(t.text)), 'stored member must be read');
  console.log('Project-review AI audit / purpose / ZIP import regression checks passed.');
})().catch(e => { console.error(e); process.exit(1); });
