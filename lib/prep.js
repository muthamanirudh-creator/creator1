'use strict';
// Prep hub: mock tests with rank + analysis, daily quiz, current affairs feed, study plans, job alerts.
// Zero-dependency; attempts are stored in data/runtime/prep.json. Ranks are among real attempts on this deployment only.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {deadlineInfo}=require('./dates');
const FILE=path.join(__dirname,'..','data','runtime','prep.json');
const Q=(s,q,o,a)=>({s,q,o,a});
const BANK=[
Q('Quant','What is 20% of 250?',['40','50','60','45'],1),
Q('Quant','A train running at 60 km/h travels for 3 hours. Distance covered?',['150 km','180 km','200 km','120 km'],1),
Q('Quant','Simple interest on ₹5000 at 8% per annum for 3 years?',['₹1000','₹1200','₹1500','₹1600'],1),
Q('Quant','Average of 12, 15, 18, 21, 24?',['16','17','18','20'],2),
Q('Quant','Two numbers are in ratio 3:5 and their sum is 64. The larger number is',['24','32','40','45'],2),
Q('Quant','Cost price ₹800, selling price ₹920. Profit percent?',['12%','15%','18%','20%'],1),
Q('Quant','A can finish a job in 10 days and B in 15 days. Together they finish in',['5 days','6 days','7.5 days','8 days'],1),
Q('Reasoning','Find the next term: 2, 6, 12, 20, 30, ?',['40','42','44','36'],1),
Q('Reasoning','Odd one out:',['Apple','Mango','Potato','Banana'],2),
Q('Reasoning','If CAT is coded 3120 (position of letters), DOG is coded',['4157','4156','3157','4167'],0),
Q('Reasoning','Ravi walks 5 km north, 5 km east, then 5 km south. Where is he from the start?',['5 km east','5 km west','10 km east','At the start'],0),
Q('Reasoning','B is the brother of A’s mother. B is A’s',['Paternal uncle','Maternal uncle','Cousin','Father'],1),
Q('Reasoning','Next letter: A, C, F, J, O, ?',['T','U','V','S'],1),
Q('English','Synonym of ABUNDANT',['Scarce','Plentiful','Rare','Meagre'],1),
Q('English','Antonym of ANCIENT',['Old','Modern','Historic','Antique'],1),
Q('English','One who loves books',['Bibliophile','Philatelist','Numismatist','Misanthrope'],0),
Q('English','Correct spelling:',['Acommodate','Accomodate','Accommodate','Acomodate'],2),
Q('English','Choose the correct sentence:',['She don’t like tea.','She doesn’t like tea.','She not like tea.','She didn’t likes tea.'],1),
Q('English','“A piece of cake” means',['Very easy','Very tasty','Very costly','Very small'],0),
Q('GK','Article 21 of the Constitution of India protects',['Right to equality','Life and personal liberty','Freedom of religion','Right to education'],1),
Q('GK','The Rajya Sabha is presided over by the',['Prime Minister','Speaker','Vice-President','President'],2),
Q('GK','Longest river of peninsular India',['Godavari','Krishna','Kaveri','Narmada'],0),
Q('GK','Battle of Plassey was fought in',['1757','1764','1857','1717'],0),
Q('GK','Fundamental Duties were added by the',['42nd Amendment','44th Amendment','52nd Amendment','61st Amendment'],0),
Q('GK','The Reserve Bank of India was established in',['1935','1947','1949','1905'],0),
Q('GK','ISRO headquarters is in',['Hyderabad','Bengaluru','Chennai','Thiruvananthapuram'],1),
Q('GK','Article 356 deals with',['National emergency','President’s Rule in a State','Financial emergency','Impeachment of the President'],1),
Q('GK','The Tropic of Cancer passes through how many Indian states?',['6','7','8','9'],2)
].map((x,i)=>({id:'q'+(i+1),...x}));
const SECS=['Quant','Reasoning','English','GK'];
const bySec=s=>BANK.filter(x=>x.s===s);
const TESTS=[{id:'full-1',title:'Full mock 1 (all sections)',minutes:20,ids:SECS.flatMap(s=>bySec(s).slice(0,5).map(x=>x.id))},
 ...SECS.map(s=>({id:'sec-'+s.toLowerCase(),title:s+' sectional',minutes:10,ids:bySec(s).map(x=>x.id)}))];
const MARK=2,NEG=0.5;
const load=()=>{try{return JSON.parse(fs.readFileSync(FILE,'utf8'))}catch{return{attempts:[]}}};
const save=d=>{fs.mkdirSync(path.dirname(FILE),{recursive:true});fs.writeFileSync(FILE,JSON.stringify(d))};
const pub=({a,...r})=>r;
const testView=t=>({id:t.id,title:t.title,minutes:t.minutes,total:t.ids.length,max_marks:t.ids.length*MARK,marking:`+${MARK} / -${NEG}`,questions:t.ids.map(i=>pub(BANK.find(x=>x.id===i)))});
function submit(testId,answers,secs){
  const t=TESTS.find(x=>x.id===testId); if(!t)throw Object.assign(new Error('Unknown test'),{status:404});
  answers=answers&&typeof answers==='object'?answers:{};
  const sec={},review=[]; let score=0,right=0,wrong=0,skip=0;
  for(const id of t.ids){const q=BANK.find(x=>x.id===id),g=answers[id],s=sec[q.s]=sec[q.s]||{section:q.s,total:0,right:0,wrong:0,skipped:0,marks:0};s.total++;
    let r='skipped'; if(Number.isInteger(g)&&g>=0&&g<4){r=g===q.a?'right':'wrong'}
    if(r==='right'){score+=MARK;s.marks+=MARK;s.right++;right++}else if(r==='wrong'){score-=NEG;s.marks-=NEG;s.wrong++;wrong++}else{s.skipped++;skip++}
    review.push({id,section:q.s,question:q.q,options:q.o,your:Number.isInteger(g)?g:null,correct:q.a,result:r});}
  const d=load();const prior=d.attempts.filter(a=>a.test===testId);
  const att={id:crypto.randomUUID(),test:testId,score,at:new Date().toISOString(),secs:Math.max(0,Math.min(86400,Number(secs)||0))};
  d.attempts.push(att);d.attempts=d.attempts.slice(-5000);save(d);
  const n=prior.length+1,rank=1+prior.filter(a=>a.score>score).length,below=prior.filter(a=>a.score<score).length;
  const sections=Object.values(sec).map(s=>({...s,accuracy:s.right+s.wrong?Math.round(100*s.right/(s.right+s.wrong)):null}));
  const weak=sections.filter(s=>s.accuracy!==null&&s.accuracy<60||s.right===0).map(s=>s.section);
  return {attempt_id:att.id,score,max:t.ids.length*MARK,right,wrong,skipped:skip,accuracy:right+wrong?Math.round(100*right/(right+wrong)):0,time_seconds:att.secs,
    rank,attempts_in_pool:n,percentile:n>1?Math.round(100*below/(n-1)):null,
    rank_note:n<10?`Rank is among ${n} attempt(s) recorded on this deployment; it becomes meaningful as more aspirants attempt.`:`Rank among ${n} recorded attempts.`,
    sections,focus_next:weak.length?weak:['Keep practising mixed sets'],review};
}
const dailyQuiz=(now=new Date())=>{const day=Math.floor(now/864e5);const qs=[...Array(5)].map((_,i)=>BANK[(day*5+i)%BANK.length]);return{date:now.toISOString().slice(0,10),questions:qs.map(pub),_ids:qs.map(x=>x.id)}};
const gradeDaily=(answers,now)=>{const dq=dailyQuiz(now);return dq._ids.map((id,i)=>{const q=BANK.find(x=>x.id===id);return{id,correct:q.a,your:Number.isInteger((answers||{})[id])?answers[id]:null}})};
// Current affairs: pulled live from official feeds (PIB by default). Nothing is invented; failures are reported.
let caCache={at:0,data:null};
const FEEDS=(process.env.CA_FEEDS||'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3').split(',').map(s=>s.trim()).filter(Boolean);
const tag=(x,t)=>{const m=x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`,'i'));return m?m[1].replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim():''};
async function currentAffairs(){
  if(caCache.data&&Date.now()-caCache.at<30*60e3)return caCache.data;
  const items=[],errors=[];
  for(const f of FEEDS){try{const c=new AbortController(),t=setTimeout(()=>c.abort(),7000);const r=await fetch(f,{signal:c.signal,headers:{'user-agent':'GovCareerAI/1.0'}});clearTimeout(t);if(!r.ok)throw new Error('HTTP '+r.status);
    const xml=await r.text();for(const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi))items.push({title:tag(m[0],'title'),link:tag(m[0],'link'),published:tag(m[0],'pubDate'),source:new URL(f).hostname});}catch(e){errors.push({feed:f,error:e.message})}}
  const data={checked_at:new Date().toISOString(),count:items.length,items:items.slice(0,40),errors,note:items.length?'Headlines from official feeds; open the source for the full release.':'Live feed unreachable from this server right now. Nothing is shown rather than guessing news.'};
  if(items.length)caCache={at:Date.now(),data};return data;
}
function flatten(nodes,out=[]){for(const n of nodes||[]){if(n.children&&n.children.length)flatten(n.children,out);else out.push(n.title||n.name)}return out}
function plan({topics,days,hours,weak=[]}){
  days=Math.max(7,Math.min(365,+days||30));hours=Math.max(1,Math.min(14,+hours||4));
  topics=[...new Set((topics||[]).filter(Boolean))];if(!topics.length)topics=SECS;
  topics.sort((a,b)=>(weak.includes(b)?1:0)-(weak.includes(a)?1:0));
  const out=[];let k=0;
  for(let d=1;d<=days;d++){
    if(d%7===0)out.push({day:d,focus:'Full mock test + error analysis',hours,type:'MOCK',test:'full-1'});
    else if(d%7===6)out.push({day:d,focus:'Revise the week’s topics + daily quiz',hours:Math.ceil(hours/2),type:'REVISION'});
    else{const t=topics[k%topics.length];k++;out.push({day:d,focus:t,hours,type:'STUDY'})}}
  return {days,hours_per_day:hours,topics:topics.length,plan:out};
}
function alerts(jobs,now=new Date()){
  return jobs.map(j=>{const dl=deadlineInfo(j.dates,now);return{id:j.id,title:j.title,state:j.state,status:dl.status,closes:dl.closes_exact||null}})
    .filter(a=>a.status!=='CLOSED').sort((a,b)=>(a.status==='CLOSING_SOON'?0:1)-(b.status==='CLOSING_SOON'?0:1)||String(a.closes).localeCompare(String(b.closes))).slice(0,50);
}
const send=(res,s,b)=>{res.writeHead(s,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(b))};
const readBody=req=>req.body&&typeof req.body==='object'?Promise.resolve(req.body):new Promise((ok,no)=>{let b='';req.on('data',c=>{b+=c;if(b.length>100000)req.destroy()});req.on('end',()=>{try{ok(b?JSON.parse(b):{})}catch{no(Object.assign(new Error('Invalid JSON'),{status:400}))}});req.on('error',no)});
// handle(req,res,pathname,{jobs,runtime}) -> true if the request was served
async function handle(req,res,p,ctx){
  if(!p.startsWith('/api/prep/'))return false;
  try{
    const m=req.method,r=p.slice(10);
    if(m==='GET'&&r==='tests')return send(res,200,{tests:TESTS.map(t=>({id:t.id,title:t.title,minutes:t.minutes,total:t.ids.length,marking:`+${MARK} / -${NEG}`})),pool:'Practice questions authored for this app; not official previous-year papers.'}),true;
    if(m==='GET'&&r.startsWith('tests/')){const t=TESTS.find(x=>x.id===r.slice(6));return t?send(res,200,testView(t)):send(res,404,{error:'Unknown test'}),true}
    if(m==='POST'&&r==='submit'){const b=await readBody(req);return send(res,200,submit(b.test,b.answers,b.seconds)),true}
    if(m==='GET'&&r==='daily'){const {_ids,...d}=dailyQuiz();return send(res,200,d),true}
    if(m==='POST'&&r==='daily'){const b=await readBody(req);const g=gradeDaily(b.answers,new Date());return send(res,200,{score:g.filter(x=>x.correct===x.your).length,total:g.length,answers:g}),true}
    if(m==='GET'&&r==='current-affairs')return send(res,200,await currentAffairs()),true;
    if(m==='GET'&&r==='alerts')return send(res,200,{checked_at:new Date().toISOString(),alerts:alerts(await ctx.jobs())}),true;
    if(m==='GET'&&r==='pyq')return send(res,200,{note:'Official previous-year papers are published by the conducting bodies. Open the official portals below; this app does not reproduce or invent papers.',links:[['UPSC','https://upsc.gov.in/examinations/previous-question-papers'],['SSC','https://ssc.gov.in/'],['IBPS','https://www.ibps.in/'],['SBI Careers','https://sbi.co.in/web/careers']].map(([name,url])=>({name,url}))}),true;
    if(m==='POST'&&r==='plan'){const b=await readBody(req);let topics=b.topics;if(b.exam_version_id&&ctx.runtime){const s=ctx.runtime.syllabus(Number(b.exam_version_id));topics=flatten(s)}return send(res,200,plan({topics,days:b.days,hours:b.hours,weak:b.weak||[]})),true}
    send(res,404,{error:'Not found'});return true;
  }catch(e){send(res,e.status||500,{error:e.message||'Prep failed'});return true}
}
module.exports={handle,BANK,TESTS,submit,dailyQuiz,plan,alerts,currentAffairs};
