'use strict';
// GovCareer AI — zero-dependency demonstration/runtime server.
// Purpose: make the complete public intelligence experience runnable with only Node.js.
// PostgreSQL/Express remains the production persistence runtime in server.js.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),url=require('url');
const {buildJobs}=require('./data/jobs');
const {parseQuery,describe,runSearch,STATES}=require('./lib/search');
const {evaluate,LEVEL_LABEL,FIELD_LABEL}=require('./lib/eligibility');
const {deadlineInfo}=require('./lib/dates');
const {ask}=require('./lib/answer');
const {buildGraph,queryGraph,answerGraphQuestion}=require('./lib/knowledgeGraph');
const runtime=require('./lib/runtime');
const {createApi:createBridgeApi}=require('./lib/bridge/api');
const PORT=Number(process.env.PORT||3000), ROOT=path.join(__dirname,'public');
const jobs=()=>buildJobs(new Date()).filter(j=>j.lifecycle!=='REVIEW_REQUIRED'&&j.verification?.status==='VERIFIED');
const META={states:STATES,levels:LEVEL_LABEL,fields:FIELD_LABEL,categories:['General','EWS','OBC','SC','ST']};
const json=(res,status,data)=>{const b=Buffer.from(JSON.stringify(data));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(b)};
const body=req=>new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>300000)req.destroy();});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(Object.assign(new Error('Invalid JSON'),{status:400}))}});req.on('error',reject)});
const audit=[];
// Bridge in the zero-dependency runtime: resume parsing, self-assessment and matching work; accounts and Campus linking do not.
const bridgeApi=createBridgeApi({jobs:()=>jobs(),exams:()=>runtime.exams(),syllabus:id=>runtime.syllabus(id)||[],store:null,campus:null,consentVersion:()=>'standalone',audit:null,privacyEvent:null});
const {createAdvancedApi}=require('./lib/advanced');
const advancedApi=createAdvancedApi({jobs:()=>jobs(),exams:async()=>runtime.exams(),syllabus:async id=>runtime.syllabus(id)||[]});
const sendAdv=(res,name,b)=>advancedApi[name](b||{}).then(o=>json(res,o.status,o.body)).catch(e=>json(res,e.status||500,{error:e.message||'Advanced module failed'}));
const sendBridge=(res,p)=>p.then(o=>json(res,o.status,o.body)).catch(e=>json(res,e.status||500,{error:e.message||'Bridge failed'}));
const localApplications=[];
const preferences={language:'en',voice_enabled:false};

const realtime=require('./lib/realtime');
realtime.start({getJobs:async()=>jobs()});
const prep=require('./lib/prep');
function route(req,res){
 const u=url.parse(req.url,true),p=u.pathname;
 if(p.startsWith('/api/prep/'))return prep.handle(req,res,p,{jobs:async()=>jobs(),runtime});
 if(req.method==='GET'&&p==='/api/stream'){req.query=u.query;return realtime.subscribe(req,res,{});}
 if(req.method==='GET'&&p==='/api/health')return json(res,200,{ok:true,database:false,runtime_mode:'STANDALONE_DEMO',time:new Date().toISOString()});
 if(req.method==='GET'&&p==='/api/meta')return json(res,200,META);
 if(req.method==='GET'&&p==='/api/languages')return json(res,200,{languages:['en','hi','bn','te','mr','ta','gu','kn','ml','pa','or'],labels:{en:'English',hi:'हिन्दी',bn:'বাংলা',te:'తెలుగు',mr:'मराठी',ta:'தமிழ்',gu:'ગુજરાતી',kn:'ಕನ್ನಡ',ml:'മലയാളം',pa:'ਪੰਜਾਬੀ',or:'ଓଡ଼ିଆ'},supported_voice_locales:['en-IN','hi-IN','te-IN']});
 if(req.method==='GET'&&p==='/api/operations/metrics')return json(res,200,{mode:'STANDALONE_DEMO',public_jobs:jobs().length,verified_exam_versions:runtime.exams().length,audits:audit.length,uptime_seconds:Math.floor(process.uptime())});
 if(req.method==='GET'&&p==='/api/live/status')return json(res,200,{mode:'STANDALONE_DEMO',checked_at:new Date().toISOString(),sources:[]});
 if(req.method==='GET'&&p==='/api/live/opportunities')return json(res,200,{checked_at:new Date().toISOString(),sources:[{source_id:'upsc',name:'UPSC official portal',status:'DEMO_LIVE_READY',latency_ms:0,links:[{title:'UPSC recruitment / examinations',url:'https://upsc.gov.in/'}]},{source_id:'ssc',name:'SSC official portal',status:'DEMO_LIVE_READY',latency_ms:0,links:[{title:'SSC official portal',url:'https://ssc.gov.in/'}]},{source_id:'sbi',name:'SBI Careers',status:'DEMO_LIVE_READY',latency_ms:0,links:[{title:'SBI Careers',url:'https://sbi.co.in/web/careers'}]}],notice:'Live monitoring is available in the production runtime; these demo links are not asserted as recruitment facts.'});
 if(req.method==='GET'&&p==='/api/map/states'){
   const counts={};jobs().forEach(j=>counts[j.state]=(counts[j.state]||0)+1);return json(res,200,{states:Object.entries(counts).map(([state,n])=>({state,jobs:n})).sort((a,b)=>b.jobs-a.jobs)});
 }
 if(req.method==='POST'&&p==='/api/search')return body(req).then(x=>{let filters=x.context||{},reset=false;if(x.query)({filters,reset}=parseQuery(x.query,filters));const r=runSearch(jobs(),filters,x.profile||{},new Date());return json(res,200,{filters,reset,chips:describe(filters),total:r.length,results:r});}).catch(e=>json(res,e.status||500,{error:e.message}));
 if(req.method==='GET'&&p.startsWith('/api/jobs/')){
   const id=decodeURIComponent(p.slice('/api/jobs/'.length));const j=jobs().find(x=>x.id===id);if(!j)return json(res,404,{error:'Recruitment not found or not yet verified.'});return json(res,200,{...j,deadline:deadlineInfo(j.dates,new Date())});
 }
 if(req.method==='POST'&&p.startsWith('/api/jobs/')&&p.endsWith('/eligibility'))return body(req).then(x=>{const id=decodeURIComponent(p.slice('/api/jobs/'.length,-'/eligibility'.length));const j=jobs().find(y=>y.id===id);if(!j)return json(res,404,{error:'Recruitment not found or not yet verified.'});return json(res,200,evaluate(j,x.profile||{}));}).catch(e=>json(res,e.status||500,{error:e.message}));
 if(req.method==='POST'&&p==='/api/assistant/ask')return body(req).then(x=>{if(!String(x.question||'').trim())return json(res,400,{error:'Question is required.'});const result=ask({jobs:jobs(),question:x.question,recruitmentId:x.recruitmentId,mode:x.mode||'QUICK',profile:x.profile||{},now:new Date()});if(result.needs_clarification)return json(res,200,result);const id=crypto.randomUUID();audit.unshift({id,question:x.question,mode:x.mode||'QUICK',verification:result.audit,created_at:new Date().toISOString()});return json(res,200,{...result,audit_id:id});}).catch(e=>json(res,e.status||500,{error:e.message}));
 if(req.method==='POST'&&p==='/api/assistant/graph')return body(req).then(x=>json(res,200,answerGraphQuestion(buildGraph(jobs()),x.question||''))).catch(e=>json(res,500,{error:e.message}));
 if(req.method==='GET'&&p==='/api/graph'){const g=buildGraph(jobs());const q=typeof u.query?.q==='string'?u.query.q:'';return json(res,200,q?queryGraph(g,q):g)}
 if(req.method==='GET'&&p==='/api/assistant/audit')return json(res,200,audit.slice(0,50));
 if(req.method==='GET'&&p==='/api/assistant/audit/verify')return json(res,200,{ok:true,mode:'STANDALONE_DEMO',records:audit.length});
 if(req.method==='GET'&&p==='/api/exams')return json(res,200,runtime.exams());
 if(req.method==='GET'&&/^\/api\/exams\/\d+\/syllabus$/.test(p)){const id=Number(p.split('/')[3]),v=runtime.exams().find(x=>x.version_id===id);if(!v)return json(res,404,{error:'Verified exam version not found.'});return json(res,200,{exam_version:v,tree:runtime.syllabus(id)});}
 if(req.method==='GET'&&p==='/api/career-paths')return json(res,200,runtime.careerPaths());







 if(req.method==='GET'&&p==='/api/calendar/standalone-demo.ics'){let out=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//GovCareer AI//EN'];for(const x of localApplications){const j=jobs().find(q=>q.id===x.recruitment_id),d=j?.dates?.application_close;if(!j||!d)continue;out.push('BEGIN:VEVENT',`UID:${j.id}@govcareer.ai`,`DTSTART;VALUE=DATE:${String(d).slice(0,10).replace(/-/g,'')}`,`SUMMARY:Application deadline: ${j.title}`,'END:VEVENT')}out.push('END:VCALENDAR');res.writeHead(200,{'content-type':'text/calendar; charset=utf-8'});return res.end(out.join('\r\n'));}

 if(req.method==='POST'&&p==='/api/assistant/search')return body(req).then(x=>{let filters=x.filters||{};if(x.query)filters=parseQuery(x.query,filters).filters;const results=runSearch(jobs(),filters,x.profile||{},new Date());return json(res,200,{results,total:results.length,filters});}).catch(e=>json(res,e.status||400,{error:e.message}));
 if(req.method==='GET'&&/^\/api\/assistant\/audit\/[^/]+$/.test(p)){const id=p.split('/').pop(),item=audit.find(x=>x.id===id);return item?json(res,200,item):json(res,404,{error:'Audit record not found.'});}
 if(req.method==='GET'&&p==='/api/account/applications')return json(res,200,localApplications);
 if(req.method==='PUT'&&/^\/api\/account\/applications\/[^/]+$/.test(p))return body(req).then(x=>{const id=p.split('/').pop(),job=jobs().find(j=>j.id===id);if(!job)return json(res,404,{error:'Opportunity not found.'});const item={recruitment_id:id,title:job.title,status:x.status||'SAVED',application_number:x.application_number||null,notes:x.notes||null,applied_at:x.applied_at||null,updated_at:new Date().toISOString()};const i=localApplications.findIndex(a=>a.recruitment_id===id);if(i>=0)localApplications[i]=item;else localApplications.unshift(item);return json(res,200,item);}).catch(e=>json(res,400,{error:e.message}));
 if(req.method==='GET'&&p==='/api/account/preferences')return json(res,200,preferences);
 if(req.method==='PUT'&&p==='/api/account/preferences')return body(req).then(x=>{if(x.language)preferences.language=String(x.language);preferences.voice_enabled=!!x.voice_enabled;return json(res,200,preferences)});
 if(req.method==='POST'&&p==='/api/account/calendar/token')return json(res,200,{token:'standalone-demo',ics_url:'/api/calendar/standalone-demo.ics'});
 if(req.method==='GET'&&p==='/api/calendar/standalone-demo.ics'){const esc=x=>String(x||'').replace(/[\\;,]/g,m=>'\\'+m).replace(/\r?\n/g,'\\n');let out=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//GovCareer AI//EN'];for(const x of localApplications){const j=jobs().find(q=>q.id===x.recruitment_id),d=j?.dates?.application_close;if(!j||!d)continue;out.push('BEGIN:VEVENT',`UID:${esc(j.id)}@govcareer.ai`,`DTSTART;VALUE=DATE:${String(d).slice(0,10).replace(/-/g,'')}`,`SUMMARY:${esc('Application deadline: '+j.title)}`,'END:VEVENT')}out.push('END:VCALENDAR');res.writeHead(200,{'content-type':'text/calendar; charset=utf-8'});return res.end(out.join('\r\n'));}
 if(req.method==='GET'&&p==='/api/assistant/audit/verify')return json(res,200,{ok:true,mode:'STANDALONE_DEMO',records:audit.length});
 if(req.method==='GET'&&/^\/api\/mock-tests\/\d+$/.test(p))return json(res,200,runtime.mockTests(p.split('/').pop()));
 if(req.method==='POST'&&p==='/api/assistant/tutor')return body(req).then(x=>{const v=runtime.exams().find(y=>y.version_id===Number(x.exam_version_id));if(!v)return json(res,404,{error:'Verified exam version not found.'});const nodes=runtime.syllabus(v.version_id)||[],topic=String(x.topic||'');const hit=nodes.find(n=>(n.title+' '+n.description).toLowerCase().includes(topic.toLowerCase()));return json(res,200,{version:v,topic,question:x.question||'',answer:hit?`For ${hit.title}: ${hit.description}. This explanation is pinned to ${v.syllabus_version}. For exact rules, verify the current official notification.`:`No exact topic match was found in ${v.syllabus_version}. Available verified topics: ${nodes.map(n=>n.title).join(', ')}.`,sources:nodes.slice(0,3).map(n=>({title:n.title,source_ref:n.source_ref,page:n.source_page}))});}).catch(e=>json(res,500,{error:e.message}));
 if(req.method==='GET'&&p==='/api/operations/privacy')return json(res,200,{policy_version:'2026-01',principles:['purpose limitation','data minimisation','consent','access/export','erasure','security safeguards'],document_upload:'confirm-before-use',voice:'opt-in'});
 if(req.method==='GET'&&p==='/api/voice/config')return json(res,200,{supported_locales:['en-IN','hi-IN','te-IN','ta-IN','bn-IN'],provider:'browser'});
 if(req.method==='GET'&&p==='/api/advanced/meta')return sendAdv(res,'meta');
 if(req.method==='POST'&&/^\/api\/advanced\/(runway|planner|rank|overlap|portfolio|brief|whatif|analytics|sm2|study-plan|next-actions)$/.test(p)){const n=p.split('/').pop();return body(req).then(x=>sendAdv(res,n==='study-plan'?'studyPlan':n==='next-actions'?'nextActions':n,x)).catch(e=>json(res,e.status||400,{error:e.message}));}
 if(req.method==='GET'&&p==='/api/bridge/meta')return sendBridge(res,bridgeApi.meta({}));
 if(req.method==='POST'&&p==='/api/bridge/resume/parse')return body(req).then(x=>sendBridge(res,bridgeApi.parseResume({body:x}))).catch(e=>json(res,e.status||400,{error:e.message}));
 if(req.method==='POST'&&p==='/api/bridge/analyze')return body(req).then(x=>sendBridge(res,bridgeApi.analyze({body:x,account:null,cookies:''}))).catch(e=>json(res,e.status||400,{error:e.message}));
 if(req.method==='POST'&&/^\/api\/bridge\/jobs\/[^/]+\/explain$/.test(p))return body(req).then(x=>sendBridge(res,bridgeApi.explain({body:x,params:{id:decodeURIComponent(p.split('/')[4])},account:null,cookies:''}))).catch(e=>json(res,e.status||400,{error:e.message}));

 if(req.method==='GET'&&p.startsWith('/api/'))return json(res,404,{error:'Endpoint not available in standalone mode',hint:'Use the PostgreSQL runtime for authenticated/persistent workflows.'});
 if(req.method==='GET')return serveStatic(res,p);
 return json(res,405,{error:'Method not allowed'});
}
function serveStatic(res,p){let rel=p==='/'?'index.html':p.replace(/^\/+/,''),file=path.normalize(path.join(ROOT,rel));if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory())return json(res,404,{error:'Not found'});const ext=path.extname(file),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':ext==='.html'?'no-cache':'public, max-age=3600','x-content-type-options':'nosniff'});fs.createReadStream(file).pipe(res)}
http.createServer((req,res)=>{try{route(req,res)}catch(e){json(res,e.status||500,{error:e.message||'Internal error'})}}).listen(PORT,()=>console.log(`GovCareer AI standalone runtime: http://localhost:${PORT}`));
