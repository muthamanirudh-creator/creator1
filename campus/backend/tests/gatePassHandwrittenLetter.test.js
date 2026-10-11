'use strict';
// Regression: the instant handwritten-style gate-pass letter is present in BOTH frontend bundles,
// is generated on submit, and the previous letter / pass / QR features are all still wired in.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,p),'utf8');
const bundles={ 'mainapp.js':read('../../mainapp.js'), 'frontend/app-runtime.js':read('../../frontend/app-runtime.js') };
const index=read('../../frontend/index.html');

for(const [name,src] of Object.entries(bundles)){
  const m=(re,msg)=>assert.match(src,re,`${name}: ${msg}`);
  m(/const \[gpHandwritten, setGpHandwritten\] = useState\(null\)/,'handwritten state');
  m(/const renderHandwrittenGatePassLetter = async \(p\)/,'canvas renderer');
  m(/buildGatePassLetterText\(p\)\.split\('\\n'\)/,'renderer uses the official letter text');
  m(/p\.studentSignature/,'student signature drawn on the letter');
  m(/showHandwrittenGatePassLetter\(persistedEntry\)/,'generated immediately after a successful submit');
  m(/handleDownloadHandwrittenLetter/,'download handler');
  m(/Your gate pass letter is ready/,'result modal');
  m(/" Gate Pass Letter"/,'request-card button');
  m(/" Letter"\)/,'letter-modal button');
  assert.doesNotMatch(src,/renderOfficialGatePassLetter/,`${name}: only ONE letter format may exist`);
  m(/ctx\.fillStyle = '#ffffff';\n        ctx\.fillRect\(0, 0, W, H\);/,'letter is on plain white paper');
  m(/From,\n\$\{p\.studentName\}/,'official From block in the letter text');
  m(/Yours faithfully,/,'official closing');
  m(/gpLetterCache/,'single letter shown in the formatted-letter views');
  m(/const gpTimeExpired = /,'time-based QR expiry helper');
  m(/filter: 'blur\(7px\)'/,'expired QR is blurred');
  m(/<video>|React\.createElement\("video", \{ ref: videoRef, muted: true, autoPlay: true, playsInline: true/,'scanner video always mounted');
  m(/const \[gpCollegeName, setGpCollegeName\]/,'college name state');
  m(/collegeName: sanitizeInput\(gpCollegeName\.trim\(\)\)/,'college name saved with the request');
  m(/College Name \(required/,'college name asked on the form');
  m(/const gpCollegeOf = /,'college name helper with legacy default');
  m(/handlePrintGatePassLetter/,'print handler');
  // nothing that existed before may be lost
  for(const keep of ['handleDownloadLetterImage','handleDownloadPassImage','GatePassLetterFormatted','gatePassVerifyUrl','gatePassShortCode','triggerGuardianNotification','buildGatePassLetterText','gatepass_request'])
    assert.ok(src.includes(keep),`${name}: existing feature "${keep}" must remain`);
}
assert.match(index,/family=Caveat/,'handwriting font link');
assert.match(index,/app-runtime\.js\?v=gc-officialletter2/,'cache-busting version');
console.log('gatePassHandwrittenLetter.test.js passed');
