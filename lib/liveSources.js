// Database-independent official-source monitor used by the public UI and hackathon mode.
// It discovers links only; publishing a structured recruitment still requires the verified ingestion/review pipeline.
const SOURCES = [
  { source_id:'upsc', name:'UPSC', domain:'upsc.gov.in', url:'https://upsc.gov.in/' },
  { source_id:'ssc', name:'SSC', domain:'ssc.gov.in', url:'https://ssc.gov.in/' },
  { source_id:'ibps', name:'IBPS', domain:'ibps.in', url:'https://www.ibps.in/' },
  { source_id:'sbi-careers', name:'SBI Careers', domain:'sbi.co.in', url:'https://sbi.co.in/web/careers' },
  { source_id:'tgpsc', name:'Telangana PSC', domain:'tgpsc.gov.in', url:'https://www.tgpsc.gov.in/' },
];
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function extract(html, base, domain) {
  const out=[]; const seen=new Set();
  for(const m of String(html).matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u=new URL(m[1],base); if(u.hostname!==domain && !u.hostname.endsWith(`.${domain}`))continue;
      const title=m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      if(!/recruit|vacan|career|notification|advertis|exam|result|apply|job|post/i.test(`${title} ${u.pathname}`))continue;
      if(seen.has(u.href))continue; seen.add(u.href); out.push({title:title||u.pathname,url:u.href});
    } catch {}
  }
  return out.slice(0,25);
}
async function checkOne(source) {
  const started=Date.now(); const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),8000);
  try {
    const r=await fetch(source.url,{signal:ctl.signal,redirect:'follow',headers:{'user-agent':'GovCareerAI/1.0 (+official-source-monitor)'}});
    const text=r.ok?await r.text():'';
    return {source_id:source.source_id,name:source.name,status:r.ok?'ONLINE':'HTTP_ERROR',http_status:r.status,latency_ms:Date.now()-started,checked_at:new Date().toISOString(),links:extract(text,new URL(r.url||source.url).href,new URL(r.url||source.url).hostname)};
  } catch(e) { return {source_id:source.source_id,name:source.name,status:e.name==='AbortError'?'TIMEOUT':'UNAVAILABLE',latency_ms:Date.now()-started,checked_at:new Date().toISOString(),links:[],error:e.message}; }
  finally { clearTimeout(timer); }
}
async function checkAll() { const out=[]; for(const s of SOURCES){out.push(await checkOne(s)); await sleep(150);} return out; }
module.exports={SOURCES,checkOne,checkAll};
