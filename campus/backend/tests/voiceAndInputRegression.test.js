// Regression tests for: (1) dictated text re-pasting into an answer box after Send, (2) teacher voice cutting out.
// Plain Node, no network. Run: node tests/voiceAndInputRegression.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app-runtime.js'), 'utf8');

function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker); assert(a >= 0, 'marker missing: ' + startMarker);
  const b = src.indexOf(endMarker, a); assert(b > a, 'end marker missing: ' + endMarker);
  return src.slice(a, b);
}

// ---------- sentence chunker ----------
const chunkSrc = slice('const splitSpeechChunks', 'const TeacherVoice = (() => {');
const { splitSpeechChunks, SPEECH_LANG_TAGS } = new Function(chunkSrc + '\nreturn { splitSpeechChunks, SPEECH_LANG_TAGS };')();
const long = 'Polymorphism lets one interface represent many forms. '.repeat(12) + 'It is used everywhere, in Java and in C++; for example a Shape can be a Circle, a Square or a Triangle and every one of them answers area().';
const chunks = splitSpeechChunks(long);
assert(chunks.length > 4, 'long narration must be split into many utterances');
assert(chunks.every((c) => c.length <= 175), 'every chunk must stay well below the ~15 s engine cutoff: ' + Math.max(...chunks.map((c) => c.length)));
assert.strictEqual(chunks.join(' ').replace(/\s+/g, ' ').length >= long.replace(/\s+/g, ' ').length - 2, true, 'no text may be lost');
assert.deepStrictEqual(splitSpeechChunks('   '), []);
assert.strictEqual(splitSpeechChunks('నమస్కారం. ఇది ఒక పరీక్ష। మరొకటి॥ ముగింపు').length >= 1, true, 'Indic punctuation handled');
assert.strictEqual(SPEECH_LANG_TAGS.Telugu, 'te-IN');
assert.strictEqual(SPEECH_LANG_TAGS.Marathi, 'mr-IN');

// ---------- dictation: no re-paste after the box is cleared ----------
const dictSrc = slice('function startToggleSpeechRecognition', '// MIRRORMENTOR-X');
let rec;
class FakeSR { constructor() { rec = this; } start() {} stop() {} }
const ctx = new Function('getSpeechRecognitionCtor', 'SPEECH_RECOGNITION_LANG_CANDIDATES', 'describeSpeechRecognitionError',
  dictSrc + '\nreturn startToggleSpeechRecognition;')(() => FakeSR, ['en-US'], () => ({ message: '', fatal: false }));
let value = 'previous words';                       // what the answer box holds when the mic is started
const setText = (u) => { value = typeof u === 'function' ? u(value) : u; };
ctx({ getBaseText: () => value, setText, onStatus() {}, onEnd() {} });
const ev = (final, text, idx = 0) => { const results = []; results[idx] = Object.assign([{ transcript: text }], { isFinal: final }); return { resultIndex: idx, results }; };
rec.onresult(ev(true, 'hello world'));
assert.strictEqual(value, 'previous words hello world');
value = '';                                          // user presses Send -> answer box cleared
rec.onresult(ev(false, 'next', 1));
assert(!/previous words|hello world/.test(value), 'sent text must NOT reappear after Send, got: "' + value + '"');
assert.strictEqual(value, 'next');
rec.onresult(ev(true, 'next sentence', 1));
assert.strictEqual(value, 'next sentence');
value = 'typed by hand';                             // user edits manually while mic is on
rec.onresult(ev(true, 'and spoken', 2));
assert.strictEqual(value, 'typed by hand and spoken');

// ---------- structural guards ----------
assert(/chatSendLockRef/.test(src) && /setChatInputKey\(k => k \+ 1\)/.test(src), 'Ask AI chat must guard double submit and remount input');
assert(/audioElRef/.test(src) && /unlockAudio/.test(src), 'tutor must reuse one unlocked <audio> element');
assert(/prefetchSegments\(i \+ 1\)/.test(src), 'tutor must prefetch upcoming segments');
assert(!/u\.onerror = \(\) => setPlaying\(false\);/.test(src), 'a single utterance error must not stop the whole lesson');
console.log('voiceAndInputRegression: all assertions passed');
