'use strict';
// Resume text -> structured claims. Deterministic and offline: it works with no AI key and the text
// never leaves the server process (Bridge does not store it).
//
// Safety rules mirrored from the eligibility engine:
//   * Skills found in a resume are CLAIMS (unverified), never tested evidence.
//   * Education found in a resume is a SUGGESTION that the person must confirm; it is never fed to the
//     eligibility engine automatically.
//   * Date of birth, category, domicile and state are never extracted or inferred.
const T = require('./taxonomy');

const MAX_CHARS = 100000;

function skillMentions(text) {
  const out = [];
  for (const id of T.IDS) {
    const terms = new Map();
    let mentions = 0;
    for (const { alias, re } of T.COMPILED[id]) {
      const g = new RegExp(re.source, 'gi');
      let m; let n = 0;
      while ((m = g.exec(text)) && n < 50) { n++; if (m.index === g.lastIndex) g.lastIndex++; }
      if (n) { terms.set(alias, n); mentions += n; }
    }
    if (mentions) {
      out.push({
        skill: id, label: T.label(id), group: T.SKILLS[id].group, mentions,
        terms: [...terms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t),
        // A claim, so deliberately modest: more mentions = a bit more confidence, never "expert".
        level_hint: mentions >= 4 ? 0.65 : mentions >= 2 ? 0.55 : 0.45,
      });
    }
  }
  return out.sort((a, b) => b.mentions - a.mentions);
}

// Short forms such as "BE" / "MA" collide with ordinary English words, so they are matched
// case-sensitively (as they are normally written) in `cs`; the rest are case-insensitive.
const EDU_RULES = [
  { level: 'phd', re: /\b(ph\.?\s?d\.?|doctorate|doctor of philosophy)\b/i },
  { level: 'master', re: /\b(m\.?\s?tech|m\.?\s?sc\.?|m\.?\s?com\.?|m\.?\s?c\.?a\.?|mba|master'?s?(?: of| degree)?|post[- ]?graduate|llm|m\.?\s?pharm)\b/i, cs: /\b(M\.\s?E\.?|ME|M\.\s?A\.?|MA)(?=[\s,.)]|$)/ },
  { level: 'bachelor', re: /\b(b\.?\s?tech|b\.?\s?sc\.?|b\.?\s?com\.?|b\.?\s?c\.?a\.?|bba|bachelor'?s?(?: of| degree)?|b\.?\s?ed\.?|llb|mbbs|b\.?\s?pharm|graduat(?:e|ion))\b/i, cs: /\b(B\.\s?E\.?|BE|B\.\s?A\.?|BA)(?=[\s,.)]|$)/ },
  { level: 'diploma', re: /\b(diploma|polytechnic)\b/i },
  { level: 'iti', re: /\b(i\.?t\.?i\.?)(?=[\s,.)]|$)/ },
  { level: '12th', re: /\b(12th|xii|higher secondary|intermediate|hsc|class 12)\b/i },
  { level: '10th', re: /\b(10th|tenth|matriculation|class 10|secondary school certificate)\b/i },
];
const FIELD_RULES = [
  ['computer_applications', /\b(b\.?\s?c\.?a\.?|m\.?\s?c\.?a\.?|computer applications?)\b/i],
  ['engineering', /\b(b\.?\s?tech|m\.?\s?tech|engineering|polytechnic)\b|\b(B\.\s?E\.?|BE|M\.\s?E\.?|ME)(?=[\s,.)]|$)/i],
  ['medical', /\b(mbbs|b\.?\s?pharm|m\.?\s?pharm|nursing|bds|bams)\b/i],
  ['law', /\b(llb|llm|law)\b/i],
  ['education', /\bb\.?\s?ed\.?\b/i],
  ['commerce', /\b(b\.?\s?com\.?|m\.?\s?com\.?|bba|mba|commerce|accountancy)\b/i],
  ['science', /\b(b\.?\s?sc\.?|m\.?\s?sc\.?|science|physics|chemistry|zoology|botany)\b/i],
  ['arts', /\b(humanities|arts|history|political science)\b|\b(B\.\s?A\.?|BA|M\.\s?A\.?|MA)(?=[\s,.)]|$)/i],
];

function educationSuggestion(text) {
  const lines = text.split(/\r?\n/);
  let best = null;
  for (const line of lines) {
    for (const rule of EDU_RULES) {
      if (rule.re.test(line) || (rule.cs && rule.cs.test(line))) {
        const rank = { phd: 8, master: 7, bachelor: 6, diploma: 5, iti: 4, '12th': 3, '10th': 2 }[rule.level];
        if (!best || rank > best.rank) best = { rank, level: rule.level, line: line.trim().slice(0, 160) };
        break;
      }
    }
  }
  if (!best) return null;
  const adv = ['diploma', 'iti', 'bachelor', 'master', 'phd'].includes(best.level);
  let field = null;
  if (adv) { const hit = FIELD_RULES.find(([, re]) => re.test(best.line)); field = hit ? hit[0] : null; }
  const status = adv && /(pursuing|final year|expected|ongoing|present|appearing)/i.test(best.line) ? 'final_year' : 'completed';
  return { level: best.level, field, status, evidence: best.line, needs_confirmation: true };
}

function experienceYears(text) {
  const re = /(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+|professional\s+|work\s+)?experience/gi;
  let m; let best = null;
  while ((m = re.exec(text))) { const n = Number(m[1]); if (n >= 0 && n <= 50 && (best === null || n > best)) best = n; }
  return best;
}

function typingSpeed(text) {
  let m = /(\d{2,3})\s*(?:wpm|words\s*(?:per|\/)\s*min(?:ute)?)/i.exec(text);
  if (!m) m = /typing[^\n.]{0,40}?(\d{2,3})\b/i.exec(text);
  const n = m ? Number(m[1]) : null;
  return n && n >= 10 && n <= 150 ? n : null;
}

function parseResume(raw) {
  const warnings = [];
  let text = String(raw || '');
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); warnings.push(`Only the first ${MAX_CHARS.toLocaleString('en-IN')} characters were read.`); }
  if (text.trim().length < 40) return { ok: false, error: 'Paste at least a few lines of your resume.', skills: [], warnings };
  const skills = skillMentions(text);
  const wpm = typingSpeed(text);
  if (wpm && !skills.some((s) => s.skill === 'typing')) skills.push({ skill: 'typing', label: T.label('typing'), group: 'SOFT', mentions: 1, terms: [`${wpm} wpm`], level_hint: T.typingLevel(wpm) });
  const edu = educationSuggestion(text);
  const exp = experienceYears(text);
  if (!skills.length) warnings.push('No recognisable skills were found. Government exams rely on aptitude more than listed tools, so this is not a problem by itself — add your aptitude self-assessment instead.');
  return {
    ok: true, skills, typing_wpm: wpm, experience_years: exp, education_suggestion: edu,
    stats: { characters: text.length, skills_found: skills.length },
    warnings,
    privacy: 'The resume text was analysed in memory and not stored. Skills found here are unverified claims.',
  };
}

module.exports = { parseResume, skillMentions, educationSuggestion, experienceYears, typingSpeed };
