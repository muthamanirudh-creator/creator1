// Phase 3 LLM-assisted search. The LLM proposes only a filter object; the server
// validates every key/value before the same runSearch() executes it.
const { parseQuery, STATES } = require('./search');
const ALLOWED = new Set(['education','age','state','domain','status','closing_this_month','closing_days']);
const DOMAINS = new Set(['railway','banking','police','defence','ssc','postal','research','state-services']);
function validateFilters(f={}) {
  const out={};
  for (const [k,v] of Object.entries(f||{})) {
    if (!ALLOWED.has(k)) continue;
    if (k==='education' && !['8th','10th','12th','iti','diploma','bachelor','master','phd'].includes(v)) continue;
    if (k==='age' && (!Number.isInteger(v)||v<14||v>70)) continue;
    if (k==='state' && !STATES.includes(v)) continue;
    if (k==='domain' && !DOMAINS.has(v)) continue;
    if (k==='status' && !['OPEN','UPCOMING','CLOSED'].includes(v)) continue;
    if (k==='closing_this_month' && v !== true) continue;
    if (k==='closing_days' && (!Number.isInteger(v)||v<1||v>365)) continue;
    out[k]=v;
  }
  return out;
}
function prompt(query,context){return `Convert the user's government-job search into JSON only. Allowed keys: education (8th|10th|12th|iti|diploma|bachelor|master|phd), age (integer 14-70), state, domain (railway|banking|police|defence|ssc|postal|research|state-services), status (OPEN|UPCOMING|CLOSED), closing_this_month (true), closing_days (integer 1-365). Never invent values. Context: ${JSON.stringify(context||{})}. Query: ${query}`;}
async function groq(query,context){
  if(!process.env.GROQ_API_KEY)return null;
  const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.GROQ_API_KEY}`},body:JSON.stringify({model:process.env.GROQ_MODEL||'llama-3.3-70b-versatile',temperature:0,response_format:{type:'json_object'},messages:[{role:'user',content:prompt(query,context)}]})});
  if(!r.ok)throw new Error(`Groq HTTP ${r.status}`); const j=await r.json(); return JSON.parse(j.choices[0].message.content);
}
async function gemini(query,context){
  if(!process.env.GEMINI_API_KEY)return null;
  const model=process.env.GEMINI_MODEL||'gemini-2.5-flash'; const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt(query,context)}]}],generationConfig:{temperature:0,responseMimeType:'application/json'}})});
  if(!r.ok)throw new Error(`Gemini HTTP ${r.status}`); const j=await r.json(); return JSON.parse(j.candidates[0].content.parts.map(p=>p.text).join(''));
}
async function llmFilters(query, context={}, providers=null) {
  const list = providers || [['groq',groq],['gemini',gemini]];
  for (const [name,fn] of list) { try { const proposed=await fn(query,context); if(proposed) return {filters:validateFilters(proposed),provider:name}; } catch (_) {} }
  return { filters:validateFilters(parseQuery(query,context).filters), provider:'deterministic-fallback' };
}
module.exports={validateFilters,llmFilters};
