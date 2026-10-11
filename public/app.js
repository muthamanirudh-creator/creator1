const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const KEY='govcareer.profile.v2', LANG_KEY='govcareer.language.v2', THEME_KEY='govcareer.theme.v1';
// Client-side catalog is intentionally complete enough to keep the profile builder usable
// when the API is starting, offline, or temporarily unavailable. The backend remains authoritative.
const FALLBACK_META={
 states:['Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand','West Bengal','Delhi','Jammu and Kashmir','Ladakh','Puducherry','Chandigarh','Andaman and Nicobar Islands','Lakshadweep','Dadra and Nagar Haveli and Daman and Diu'],
 levels:{'8th':'8th pass','10th':'10th pass','12th':'12th pass','iti':'ITI','diploma':'Diploma / Polytechnic','bachelor':"Bachelor's degree",'master':"Master's / Postgraduate degree",'phd':'PhD / Doctorate'},
 fields:{engineering:'Engineering / Technology',science:'Science',commerce:'Commerce / Business',arts:'Arts / Humanities',medical:'Medical / Pharmacy',law:'Law',education:'Education (B.Ed)',computer_applications:'Computer Applications',other:'Other'},
 categories:['General','EWS','OBC','SC','ST']
};
const NEEDS_STREAM=['diploma','iti','bachelor','master','phd'];
const VERDICT={MATCH:['✓','Matches'],PARTIAL_MATCH:['◐','Partial match'],CONDITIONALLY_ELIGIBLE:['◔','Conditional'],CONDITIONAL:['◔','Conditional'],NOT_ELIGIBLE:['×','Not eligible'],UNKNOWN:['?','Needs verification'],INSUFFICIENT_EVIDENCE:['⚠','Insufficient evidence']};
let meta={},profile={},filters={},lastJobId=null,searchTimer,toastTimer;
try{profile=JSON.parse(localStorage.getItem(KEY)||'{}')}catch{profile={}}
let uiLanguage=localStorage.getItem(LANG_KEY)||'en';
$('#ui-language').value=uiLanguage;
function saveProfile(){try{localStorage.setItem(KEY,JSON.stringify(profile))}catch{}}
function showToast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2600)}
async function api(url,opts={}){
 const ctl=new AbortController(); const timeout=setTimeout(()=>ctl.abort(),Number(opts.timeout||9000));
 try{const headers={...(opts.body?{'Content-Type':'application/json'}:{}),...(opts.headers||{})};const r=await fetch(url,{...opts,headers,signal:opts.signal||ctl.signal});let d={};try{d=await r.json()}catch{}if(!r.ok)throw Object.assign(new Error(d.error||`Request failed (${r.status})`),{status:r.status,data:d});return d}
 catch(e){if(e.name==='AbortError')throw new Error(`Request timed out: ${url}`);throw e} finally{clearTimeout(timeout)}
}
function fmtDate(s){if(!s)return'';const d=new Date(String(s).slice(0,10)+'T00:00:00');return Number.isNaN(d.getTime())?String(s):d.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
function nav(view){$$('.view').forEach(x=>x.classList.toggle('active',x.id===`view-${view}`));$$('.nav-btn').forEach(x=>x.classList.toggle('active',x.dataset.view===view));window.scrollTo({top:0,behavior:'smooth'});if(view==='opportunities')search($('#q').value);if(view==='exams')loadExams();if(view==='career')loadCareer();if(view==='tools')loadTools();if(view==='bridge'&&window.loadBridge)window.loadBridge();if(view==='advanced'&&window.loadAdvanced)window.loadAdvanced()}
$$('[data-view]').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.view)));
$('#brand-home').onclick=()=>nav('overview');$('#profile-jump').onclick=()=>{nav('opportunities');setTimeout(()=>$('#profile-panel').scrollIntoView({behavior:'smooth'}),80)};
$('#theme-toggle').onclick=()=>{document.body.classList.toggle('dark');localStorage.setItem(THEME_KEY,document.body.classList.contains('dark')?'dark':'light')};
if(localStorage.getItem(THEME_KEY)==='dark')document.body.classList.add('dark');

function fillSelect(el,entries){
 if(!el)return; const current=el.value; while(el.options.length>1)el.remove(1);
 for(const [v,l] of entries){if(!el.querySelector(`option[value=\"${CSS.escape(String(v))}\"]`))el.add(new Option(l,v));}
 if(current)el.value=current;
}
function syncProfileUI(){
 const lvl=profile.education?.level||'',adv=NEEDS_STREAM.includes(lvl);
 $('#p-level').value=lvl;$('#w-status').hidden=!adv;$('#w-field').hidden=!adv;
 $('#p-status').value=profile.education?.status||'completed';$('#p-field').value=profile.education?.field||'';
 $('#p-dob').value=profile.dob||'';$('#p-state').value=profile.state||'';$('#p-category').value=profile.category||'';
 $('#p-pwbd').checked=!!profile.pwbd;$('#p-ex').checked=!!profile.exServiceman;$('#p-domicile').value=profile.domicileState||'';$('#p-exp').value=profile.experienceYears??'';
 const complete=!!(lvl&&profile.dob&&profile.state);$('#profile-status').textContent=complete?'Profile ready':'Build profile';
}
function readProfile(){
 const lvl=$('#p-level').value,adv=NEEDS_STREAM.includes(lvl),prev=profile.state;
 profile.education=lvl?{level:lvl,status:adv?$('#p-status').value:'completed',field:adv?($('#p-field').value||undefined):undefined}:undefined;
 profile.dob=$('#p-dob').value||undefined;profile.state=$('#p-state').value||undefined;profile.category=$('#p-category').value||undefined;
 profile.pwbd=$('#p-pwbd').checked;profile.exServiceman=$('#p-ex').checked;profile.domicileState=$('#p-domicile').value||undefined;
 profile.experienceYears=$('#p-exp').value===''?undefined:+$('#p-exp').value;saveProfile();syncProfileUI();
 if(profile.state&&profile.state!==prev)filters={...filters,state:profile.state};
}
function onProfileChange(){readProfile();clearTimeout(searchTimer);searchTimer=setTimeout(()=>search(),250)}
function verdict(v){const x=VERDICT[v]||VERDICT.UNKNOWN;return`<span class="verdict v-${esc(v)}"><span aria-hidden="true">${x[0]}</span>${x[1]}</span>`}
function renderChips(chips=[]){const el=$('#chips');el.innerHTML='';chips.forEach(c=>{const s=document.createElement('span');s.className='chip';s.innerHTML=`${esc(c.label)} <button aria-label="Remove ${esc(c.label)}">×</button>`;s.querySelector('button').onclick=()=>{delete filters[c.key];search()};el.append(s)});if(chips.length>1){const b=document.createElement('button');b.className='chip';b.textContent='Start over';b.onclick=()=>{$('#q').value='';filters={};search()};el.append(b)}}
async function search(query){
 try{
  const d=await api('/api/search',{method:'POST',body:JSON.stringify({query:query||'',context:filters,profile})});filters=d.filters||{};renderChips(d.chips||[]);renderResults(d);return d;
 }catch(e){$('#results').innerHTML=`<li class="empty"><strong>Search is temporarily unavailable.</strong><br>${esc(e.message)}<br><button class="text-btn" onclick="search()">Retry</button></li>`;return null}
}
function renderResults(data){
 const rows=data.results||[],has=rows.some(r=>r.eligibility),hide=has&&$('#hide-not').checked,list=rows.filter(r=>!(hide&&r.eligibility?.overall==='NOT_ELIGIBLE'));
 $('#hide-wrap').hidden=!has;$('#count').textContent=`${list.length} opportunity${list.length===1?'':'ies'}${rows.length!==list.length?` · ${rows.length-list.length} hidden`:''}`;
 const ol=$('#results');ol.innerHTML='';
 if(!list.length){ol.innerHTML='<li class="empty"><strong>No verified opportunities match.</strong><br>Try removing a filter or describing a broader requirement.</li>';return}
 list.forEach(r=>{const li=document.createElement('li');li.innerHTML=`<button type="button" class="card ${esc(r.deadline.status)}${r.eligibility?.overall==='NOT_ELIGIBLE'?' dim':''}">
 <h2>${esc(r.title)}</h2>${r.trust&&window.GCTrust?`<p class="tr-line">${GCTrust.badge(r.trust)}</p>`:''}<p class="org">${esc(r.organization)}, ${esc(r.state)}</p><div class="row"><span class="deadline">${esc(r.deadline.label)}</span><span>${r.deadline.status==='UPCOMING'?'Opens':'Closes'} ${esc(r.deadline.status==='UPCOMING'?r.deadline.opens_exact:r.deadline.closes_exact)}</span><span>${Number(r.vacancies_total||0).toLocaleString('en-IN')} vacancies</span>${r.eligibility?verdict(r.eligibility.overall):''}</div>${r.eligibility?.short_reason&&r.eligibility.overall!=='MATCH'?`<p class="reason">${esc(r.eligibility.short_reason)}</p>`:''}</button>`;li.querySelector('button').onclick=()=>openJob(r.id);ol.append(li)})
}
function srcLine(job,s){return s?`<span class="src">Source: ${esc((job.sources||[]).find(x=>x.id===s.doc)?.name||'Notification')}, page ${esc(s.page)}, section ${esc(s.section)}</span>`:''}
function askForm(ask,idx){const id=`ask-${idx}`;let input='';if(ask.field==='dob')input=`<input type="date" id="${id}">`;else if(ask.field==='experience')input=`<input type="number" min="0" max="50" id="${id}">`;else if(ask.field==='domicile')input=`<select id="${id}"><option value="">Select</option><option value="none">I do not have one</option>${meta.states.map(s=>`<option>${esc(s)}</option>`).join('')}</select>`;else if(ask.field==='field')input=`<select id="${id}"><option value="">Select</option>${Object.entries(meta.fields).map(([v,l])=>`<option value="${v}">${esc(l)}</option>`).join('')}</select>`;else if(ask.field==='subjects')input=`<div>${ask.options.map(o=>`<label class="check"><input type="checkbox" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</div>`;return`<span class="ask" data-field="${esc(ask.field)}" data-id="${id}"><p>${esc(ask.prompt)}</p>${input}<button type="button" class="btn">Save & re-check</button></span>`}
function applyAsk(el){const f=el.dataset.field,id=el.dataset.id,val=()=>el.querySelector('#'+id)?.value;if(f==='dob'){if(!val())return;profile.dob=val()}else if(f==='experience'){if(val()==='')return;profile.experienceYears=+val()}else if(f==='domicile'){if(!val())return;profile.domicileState=val()}else if(f==='field'){if(!val())return;profile.education={...(profile.education||{}),field:val()}}else if(f==='subjects'){profile.subjects=[...el.querySelectorAll('input:checked')].map(x=>x.value);profile.subjectsKnown=true}saveProfile();syncProfileUI();openJob(lastJobId,true);search()}
/* ---- Pass 4: rules-engine eligibility check against the stored notice (shared Hybrid RAG service) ----------------------
   Additive second opinion under the existing analysis. Code decides each requirement (meets / not_meets / unknown) and shows the
   verbatim notice quote; no AI is involved in the verdict. Opt-in with explicit consent; the profile is sent for this one request and
   never stored (the extra fields below are NOT saved to localStorage or to the profile). */
const HY_VERDICT={eligible_confirmed:['MATCH','✓','Eligible — confirmed'],eligible_provisional:['CONDITIONAL','◔','Likely eligible — provisional'],ineligible_confirmed:['NOT_ELIGIBLE','×','Not eligible — confirmed'],ineligible_provisional:['PARTIAL_MATCH','◐','Appears not eligible — verify on the notice'],indeterminate:['UNKNOWN','?','Cannot be determined yet'],drive_closed:['UNKNOWN','–','Drive closed']};
const HY_CRIT={meets:['MATCH','✓','Meets'],not_meets:['NOT_ELIGIBLE','×','Does not meet'],unknown:['UNKNOWN','?','Unknown']};
const HY_DRIVE={active:'Active · verified recently',upcoming:'Upcoming · verified',closed:'Closed',unverified:'Unverified — confirm on the official notice',inaccessible:'Source unreachable on last check'};
const HY_AUTH={official:'Official source',verified:'Verified source',auto_extracted:'Auto-extracted',third_party:'Third-party report'};
const HY_KEY={min_cgpa:'Minimum CGPA',min_percentage:'Minimum percentage',degrees:'Degree',branches:'Branch',graduation_years:'Graduation year',max_active_backlogs:'Active backlogs',max_total_backlogs:'Total backlogs',max_age:'Maximum age',min_age:'Minimum age',required_skills:'Skills',certifications:'Certifications',min_experience_years:'Experience (years)',work_locations:'Work location'};
const HY_DEGREES={btech:'B.E. / B.Tech',mtech:'M.E. / M.Tech',bsc:'B.Sc',msc:'M.Sc',bca:'BCA',mca:'MCA',mba:'MBA / PGDM',bcom:'B.Com',ba:'B.A.',diploma:'Diploma'};
const HY_BRANCHES={cse:'Computer Science',it:'Information Technology',ece:'Electronics & Communication',eee:'Electrical & Electronics',ee:'Electrical',mech:'Mechanical',civil:'Civil',aiml:'AI / ML',ds:'Data Science',chem:'Chemical',instrumentation:'Instrumentation'};
const hyChip=(map,k)=>{const x=map[k]||['UNKNOWN','?',String(k||'Unknown')];return`<span class="verdict v-${esc(x[0])}"><span aria-hidden="true">${x[1]}</span>${esc(x[2])}</span>`};
const hySafeUrl=u=>{try{const x=new URL(String(u||''));return x.protocol==='https:'||x.protocol==='http:'?x.href:''}catch{return''}};
const hyVal=v=>v==null||v===''?'—':Array.isArray(v)?(v.map(x=>HY_DEGREES[x]||HY_BRANCHES[x]||x).join(', ')||'—'):typeof v==='object'?JSON.stringify(v):String(HY_DEGREES[v]||HY_BRANCHES[v]||v);
function hyRecordId(id){return`gc:${String(id).replace(/[^A-Za-z0-9_.:\-]/g,'_')}`.slice(0,80)}
function hyShell(){
 const opt=m=>Object.entries(m).map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join('');
 return`<section class="blk" id="hy-elig"><h3>Check against the notice text</h3>
 <p class="fine">Optional second opinion from a rules engine. Each requirement quoted from the stored notice is marked Meets, Does not meet or Unknown by code, never by AI, and shows the exact notice wording. Nothing you enter here is stored.</p>
 <details class="hy-fields"><summary>Add academic details (all optional)</summary><div class="hy-grid">
 <label>CGPA<input id="hy-cgpa" type="number" min="0" max="100" step="0.01" inputmode="decimal"></label><label>CGPA scale<input id="hy-scale" type="number" min="1" max="100" step="1" placeholder="10" inputmode="decimal"></label>
 <label>Percentage<input id="hy-pct" type="number" min="0" max="100" step="0.01" inputmode="decimal"></label><label>Graduation year<input id="hy-grad" type="number" min="1980" max="2100" step="1" inputmode="numeric"></label>
 <label>Active backlogs<input id="hy-act" type="number" min="0" max="99" step="1" inputmode="numeric"></label><label>Total backlogs<input id="hy-tot" type="number" min="0" max="99" step="1" inputmode="numeric"></label>
 <label>Degree<select id="hy-degree"><option value="">Not specified</option>${opt(HY_DEGREES)}</select></label><label>Branch<select id="hy-branch"><option value="">Not specified</option>${opt(HY_BRANCHES)}</select></label></div></details>
 <label class="check hy-consent"><input type="checkbox" id="hy-consent"> I agree to send these details${profile.dob||profile.experienceYears!=null?', plus the date of birth and experience from my profile,':''} to the rules engine for this one check.</label>
 <button type="button" id="hy-run" class="secondary-btn" disabled>Run rules check</button><div id="hy-out" aria-live="polite"></div></section>`}
function hyProfile(){
 const n=id=>{const v=$('#'+id)?.value;return v===''||v==null?undefined:+v},s=id=>$('#'+id)?.value||undefined,p={};
 const put=(k,v)=>{if(v!==undefined&&!Number.isNaN(v))p[k]=v};
 put('cgpa',n('hy-cgpa'));put('cgpa_scale',n('hy-scale'));put('percentage',n('hy-pct'));put('graduation_year',n('hy-grad'));put('active_backlogs',n('hy-act'));put('total_backlogs',n('hy-tot'));put('degree',s('hy-degree'));put('branch',s('hy-branch'));
 if(profile.dob)p.dob=profile.dob;if(profile.experienceYears!=null)p.experience_years=profile.experienceYears;return p}
function hyError(e){
 const d=e.data||{},m=(d.detail&&d.detail.message)||(d.error&&d.error.message)||(typeof d.error==='string'?d.error:'')||e.message||'Request failed';
 if(e.status===401||e.status===403)return`<p role="alert" class="hy-note"><strong>Sign in to run this check.</strong> It uses the Campus AI service. <a href="/campus/">Sign in</a></p>`;
 if(e.status===404||e.status===501)return`<p role="alert" class="hy-note"><strong>Not available here.</strong> The rules check needs the Campus AI service, which is not part of this deployment or is an older build.</p>`;
 if(e.status===503||e.status===502||e.status===504)return`<p role="alert" class="hy-note"><strong>The AI service is starting or unavailable.</strong> Your details were not stored. Try again in a moment.</p>`;
 return`<p role="alert" class="hy-note"><strong>Check unavailable.</strong> ${esc(m)}</p>`}
function hyRender(d){
 const rows=d.results||[];
 if(!rows.length)return`<p class="hy-note">${esc(d.message||'No matching recruitment record is stored. Nothing was assumed.')} Stored notices appear after an administrator runs the Hybrid RAG sync.</p>`;
 return rows.map(a=>{
  const r=a.record||{},link=hySafeUrl(r.url),sm=a.summary||{},cov=a.coverage||{},miss=a.missing_profile_fields||[];
  const crit=(a.criteria||[]).map(c=>`<tr><td data-l="Requirement"><strong>${esc(HY_KEY[c.key]||String(c.key||'').replace(/_/g,' '))}</strong>${c.mandatory?'':'<span class="note">optional</span>'}</td><td data-l="Notice says">${esc(hyVal(c.required))}${c.quote?`<blockquote class="hy-quote">“${esc(c.quote)}”</blockquote>`:''}</td><td data-l="You">${esc(hyVal(c.student_value))}</td><td data-l="Result">${hyChip(HY_CRIT,c.status)}<span class="note">${esc(c.reason||'')}</span></td></tr>`).join('');
  return`<div class="hy-result"><div class="overall v-${esc((HY_VERDICT[a.verdict]||HY_VERDICT.indeterminate)[0])}">${hyChip(HY_VERDICT,a.verdict)}<span class="hy-sum">${Number(sm.meets||0)} met · ${Number(sm.not_meets||0)} not met · ${Number(sm.unknown||0)} unknown</span></div>
  <p class="fine hy-meta">${esc(HY_DRIVE[r.drive_status]||'Status unknown')} · ${esc(HY_AUTH[r.authority]||r.authority||'Source type unknown')}${r.advt_no?` · Advt. No. ${esc(r.advt_no)}`:''}<br>${r.published_at?`Published ${esc(fmtDate(r.published_at))} · `:''}${r.last_verified_at?`Last verified ${esc(fmtDate(r.last_verified_at))}`:'Never verified'}${r.deadline?` · Deadline ${esc(fmtDate(r.deadline))}`:''}${link?` · <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open the notice</a>`:''}</p>
  ${(a.caveats||[]).length?`<ul class="plain hy-caveats">${a.caveats.map(c=>`<li>${esc(c)}</li>`).join('')}</ul>`:''}
  ${miss.length?`<p class="hy-note">To settle this, add: ${miss.map(m=>esc(String(m).replace(/_/g,' '))).join(', ')}.</p>`:''}
  ${crit?`<table class="elig hy-table"><thead><tr><th>Requirement</th><th>Notice says</th><th>Your details</th><th>Result</th></tr></thead><tbody>${crit}</tbody></table>`:''}
  ${(cov.not_extracted||[]).length?`<p class="fine">Not found in the notice text (not assumed absent): ${cov.not_extracted.map(k=>esc(HY_KEY[k]||k)).join(', ')}.</p>`:''}</div>`}).join('')
  +`<p class="fine">Details used for this check: ${(d.profile_fields_used||[]).map(esc).join(', ')||'none'}. Not stored. Guidance only, not an official decision.</p>`}
function hyWire(job){
 const box=$('#hy-elig');if(!box)return;const consent=$('#hy-consent'),run=$('#hy-run'),out=$('#hy-out');
 consent.onchange=()=>{run.disabled=!consent.checked};
 run.onclick=async()=>{
  if(!consent.checked||run.disabled)return;run.disabled=true;run.setAttribute('aria-busy','true');out.innerHTML='<p class="fine">Checking the stored notice…</p>';
  try{const d=await api('/api/ai-ml/rag/hybrid/eligibility',{method:'POST',timeout:20000,body:JSON.stringify({profile:hyProfile(),record_id:hyRecordId(job.id),include_closed:true})});out.innerHTML=hyRender(d)}
  catch(e){out.innerHTML=hyError(e)}
  finally{run.removeAttribute('aria-busy');run.disabled=!consent.checked}}}
async function openJob(id,keep=false){
 lastJobId=id;try{
  const [job,elig]=await Promise.all([api(`/api/jobs/${encodeURIComponent(id)}?lang=${encodeURIComponent(uiLanguage)}`),api(`/api/jobs/${encodeURIComponent(id)}/eligibility`,{method:'POST',body:JSON.stringify({profile})})]);
  const b=job.vacancies.breakdown||{},rows=(elig.rows||[]).map((r,i)=>`<tr><td data-l="Requirement"><strong>${esc(r.label)}</strong></td><td data-l="Official">${esc(r.official)}</td><td data-l="You">${esc(r.yours)}</td><td data-l="Result">${verdict(r.result)}<span class="note">${esc(r.note)}</span>${srcLine(job,r.source)}${r.ask?askForm(r.ask,i):''}</td></tr>`).join('');
  $('#d-body').innerHTML=`<h2 id="d-title">${esc(job.title)}</h2><p class="sub">${esc(job.organization)}, ${esc(job.department)} · ${esc(job.state)}</p>
  ${job.trust&&window.GCTrust?GCTrust.panel(job.trust):''}<p class="ver">${job.trust&&!['VERIFIED','SAMPLE'].includes(job.trust.verification)?'Record published':'Verified'} ${esc(fmtDate(job.verification?.verified_at))}.${job.sample?' Demo record.':''}</p>${job.pending_update?'<p class="ver">A newer official document is being checked; the verified version remains the displayed record.</p>':''}
  <div class="clock ${esc(job.deadline.status)}"><div class="big">${esc(job.deadline.label)}</div><div>${job.deadline.status==='UPCOMING'?'Opens':'Closes'}: ${esc(job.deadline.status==='UPCOMING'?job.deadline.opens_exact:job.deadline.closes_exact)}</div></div>
  <section class="blk"><h3>Eligibility analysis</h3><div class="overall v-${esc(elig.overall)}"><strong>${esc((VERDICT[elig.overall]||VERDICT.UNKNOWN)[1])}</strong>${esc(elig.summary||'')}</div>
  <table class="elig"><thead><tr><th>Requirement</th><th>Official</th><th>Your profile</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="fine">Age is evaluated on the notification's stated cutoff date. Unknown profile details remain unknown; this is guidance, not an official decision.</p></section>
  ${hyShell()}
  <section class="blk"><h3>Vacancies</h3><table><thead><tr><th>Category</th><th class="num">Posts</th></tr></thead><tbody>${Object.entries(b).map(([k,v])=>`<tr><td>${esc(k)}</td><td class="num">${Number(v).toLocaleString('en-IN')}</td></tr>`).join('')}<tr><td><strong>Total</strong></td><td class="num"><strong>${Number(job.vacancies.total).toLocaleString('en-IN')}</strong></td></tr></tbody></table><p class="fine">PwBD ${Number(job.vacancies.pwbd||0).toLocaleString('en-IN')}; ex-servicemen ${Number(job.vacancies.ex_servicemen||0).toLocaleString('en-IN')}.${srcLine(job,job.field_sources?.vacancies)||''}</p></section>
  ${job.history?.length?`<section class="blk"><h3>Official updates</h3><ul class="plain">${job.history.map(h=>`<li><strong>${esc(h.field)}</strong>: ${esc(h.delta)} <span class="src">Updated ${esc(fmtDate(h.date))}. Source: ${esc(h.source)}</span></li>`).join('')}</ul></section>`:''}
  <section class="blk"><h3>Key dates & fees</h3><dl class="kv"><dt>Applications open</dt><dd>${esc(job.deadline.opens_exact)}</dd><dt>Applications close</dt><dd>${esc(job.deadline.closes_exact)}</dd><dt>Exam date</dt><dd>${job.dates.exam_date?esc(fmtDate(job.dates.exam_date)):'Not announced in the notification'}</dd><dt>General fee</dt><dd>${esc(job.fee.general)}</dd><dt>Reserved fee</dt><dd>${esc(job.fee.reserved)}</dd></dl></section>
  <section class="blk"><h3>Selection process</h3><ul class="plain">${(job.selection||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section>
  <section class="blk"><div style="display:flex;gap:10px;flex-wrap:wrap"><button id="track-job" class="primary-btn" type="button">Track this opportunity</button><button id="copy-job-link" class="secondary-btn" type="button">Copy job link</button></div></section><section class="blk"><h3>Official documents</h3><ul class="plain">${(job.sources||[]).map(x=>`<li><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.name)}</a> · ${esc(x.issuer)}</li>`).join('')}</ul><p class="fine">Apply and pay only through the official portal named in the verified notification.</p></section>`;
  hyWire(job);$$('#d-body .ask .btn').forEach(b=>b.onclick=()=>applyAsk(b.closest('.ask')));$('#track-job').onclick=()=>trackLocal(job);$('#copy-job-link').onclick=async()=>{try{await navigator.clipboard.writeText(location.origin+`/api/jobs/${encodeURIComponent(job.id)}`);showToast('Job API link copied')}catch{showToast('Copy unavailable')}};
  $('#drawer').hidden=false;$('#scrim').hidden=false;if(!keep){$('#drawer').scrollTop=0;$('#d-close').focus()}
 }catch(e){showToast(e.message)}
}
function closeDrawer(){$('#drawer').hidden=true;$('#scrim').hidden=true}

async function askGrounded(promptOverride){
 const input=$('#ai-q'),btn=$('#ai-ask'),q=(promptOverride||input.value).trim();if(!q||btn.disabled)return;
 input.value='';input.setAttribute('autocomplete','off');input.setAttribute('autocorrect','off');input.setAttribute('spellcheck','false');[60,400].forEach(ms=>setTimeout(()=>{if(input.value.trim()===q)input.value=''},ms));btn.disabled=true;btn.setAttribute('aria-busy','true');const box=$('#ai-answer'),head=`<p class="muted ai-you">You asked: ${esc(q)}</p>`;
 box.innerHTML=`${head}<p>Checking the verified record…</p>`;
 try{const r=await api('/api/assistant/ask',{method:'POST',body:JSON.stringify({question:q,mode:$('#ai-mode').value,recruitmentId:lastJobId,profile})});
  if(r.needs_clarification){box.innerHTML=`${head}<p>${esc(r.question)}</p><div class="suggestions">${(r.options||[]).map(o=>`<button data-id="${esc(o.id)}">${esc(o.title)}</button>`).join('')}</div>`;box.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{lastJobId=b.dataset.id;askGrounded(q)});return}
  const src=(r.where_did_this_come_from||[]).map(c=>`<li>${esc(c.label)}: ${esc(c.value)} ${c.viewer_url?`<a target="_blank" rel="noopener" href="${esc(c.viewer_url)}">Open ${esc(c.doc)}, page ${esc(c.page)}</a>`:`(${esc(c.doc)}, page ${esc(c.page)})`}</li>`).join('');
  box.innerHTML=`${head}<p>${esc(r.text)}</p>${window.GCTrust?GCTrust.answerBlock(r):''}<p class="muted">Verified ${r.audit?.checks?.length||0} claim checks${r.official_silent?'; official source is silent on some requested details':''}. Audit #${esc(r.audit_id)}</p>${src?`<details><summary>Where did this come from?</summary><ul>${src}</ul></details>`:''}`;
 }catch(e){box.innerHTML=`${head}<p role="alert"><strong>Answer unavailable.</strong> ${esc(e.message)}</p><button class="text-btn" id="retry-ai" type="button">Retry</button>`;$('#retry-ai').onclick=()=>askGrounded(q)}
 finally{btn.disabled=false;btn.removeAttribute('aria-busy');if(!promptOverride&&matchMedia('(hover:hover)').matches)input.focus()}
}
function showAudit(){showToast('Grounded answers bind claims to structured records and retain an audit trail. Open “Where did this come from?” on an answer to inspect source pages.')}
$('#audit-info').onclick=showAudit;$('#footer-audit').onclick=showAudit;
$('#hero-ask').onclick=()=>{$('#ai-q').focus();$('#ai-q').scrollIntoView({behavior:'smooth',block:'center'})};
$('#ai-ask').onclick=()=>askGrounded();$('#ai-q').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();askGrounded()}});$$('.suggestions button[data-prompt]').forEach(b=>b.onclick=()=>askGrounded(b.dataset.prompt));
$('#ui-language').onchange=()=>{uiLanguage=$('#ui-language').value;localStorage.setItem(LANG_KEY,uiLanguage);if(lastJobId)openJob(lastJobId,true);search($('#q').value)};
$('#search-form').onsubmit=e=>{e.preventDefault();search($('#q').value.trim())};$('#hide-not').onchange=()=>search();$('#clear-filters').onclick=()=>{$('#q').value='';filters={};search()};$('#clear-profile').onclick=()=>{profile={};filters={};localStorage.removeItem(KEY);syncProfileUI();search()};$$('#profile-form input, #profile-form select').forEach(el=>el.addEventListener('change',onProfileChange));$('#p-exp').addEventListener('input',onProfileChange);
$('#profile-collapse').onclick=()=>{$('#profile-panel form').hidden=!$('#profile-panel form').hidden;$('#profile-collapse').textContent=$('#profile-panel form').hidden?'Expand':'Collapse'};
$('#d-close').onclick=closeDrawer;$('#scrim').onclick=closeDrawer;document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeDrawer();closePalette()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openPalette()}});
function openPalette(){const m=$('#command-palette');m.hidden=false;$('#command-input').value='';renderCommands('');setTimeout(()=>$('#command-input').focus(),0)}
function closePalette(){$('#command-palette').hidden=true}
const commands=[['Overview','See your career command center','overview'],['Opportunity radar','Search and filter government jobs','opportunities'],['Exam Lab','Explore verified syllabi and preparation','exams'],['Career paths','Explore the knowledge graph','career'],['Bridge','Match Campus skills and your resume to government jobs','bridge'],['Strategy','Age runway, deadline conflicts, study planner, mock analytics','advanced'],['My Tools','Application cockpit and privacy tools','tools']];
function renderCommands(q){const list=$('#command-results'),needle=q.toLowerCase();list.innerHTML=commands.filter(x=>(x[0]+' '+x[1]).toLowerCase().includes(needle)).map((x,i)=>`<button class="command-item ${i===0?'active':''}" data-view="${x[2]}"><span><strong>${esc(x[0])}</strong><small> · ${esc(x[1])}</small></span><span>↵</span></button>`).join('');list.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{closePalette();nav(b.dataset.view)})}
$('#command-btn').onclick=openPalette;$('#command-palette').onclick=e=>{if(e.target.id==='command-palette')closePalette()};$('#command-input').oninput=e=>renderCommands(e.target.value);$('#command-input').onkeydown=e=>{if(e.key==='Enter'){$('#command-results .active')?.click()}};

async function loadOverview(){
 try{
  const settled=await Promise.allSettled([
   api('/api/search',{method:'POST',body:JSON.stringify({query:'',context:{},profile:{}})}),
   api('/api/exams'),api('/api/map/states')
  ]);
  const searchData=settled[0].status==='fulfilled'?settled[0].value:{results:[]};
  const exams=settled[1].status==='fulfilled'?settled[1].value:[];
  const map=settled[2].status==='fulfilled'?settled[2].value:{states:[]};
  if(settled.every(x=>x.status==='rejected')) $('#metric-system').textContent='OFFLINE'; else if(settled.some(x=>x.status==='rejected')) $('#metric-system').textContent='PARTIAL';
  const jobs=searchData.results||[];if(window.GCMetrics){window.GCMetrics.set({verified:jobs.length,closing:jobs.filter(x=>x.deadline?.status==='CLOSING_SOON').length,exams:Array.isArray(exams)?exams.length:0})}else{$('#metric-jobs').textContent=jobs.length.toLocaleString('en-IN');$('#metric-deadlines').textContent=jobs.filter(x=>x.deadline?.status==='CLOSING_SOON').length;$('#metric-exams').textContent=exams.length}if(settled.every(x=>x.status==='fulfilled'))$('#metric-system').textContent='ONLINE';
  $('#system-health').textContent='Public intelligence responding';
  renderRadar(jobs);
  loadLiveSources();
  clearInterval(window.__liveTimer); window.__liveTimer=setInterval(loadLiveSources, 60000);
 }catch(e){if(window.GCMetrics)window.GCMetrics.set({verified:0,exams:0});$('#metric-system').textContent='DEGRADED';$('#system-health').textContent='Some services need attention'}
}
function renderRadar(jobs){const el=$('#deadline-radar'),rows=jobs.filter(x=>x.deadline?.status!=='CLOSED').sort((a,b)=>String(a.deadline?.closes_exact).localeCompare(String(b.deadline?.closes_exact))).slice(0,3);el.innerHTML=rows.length?rows.map(r=>`<button class="radar-card" data-id="${esc(r.id)}"><span class="date">${esc(r.deadline.label)}</span><h3>${esc(r.title)}</h3><p>${esc(r.organization)} · ${Number(r.vacancies_total||0).toLocaleString('en-IN')} vacancies</p></button>`).join(''):'<div class="empty">No verified deadline records are currently available.</div>';el.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>openJob(b.dataset.id))}
async function loadExams(){
 const el=$('#exam-list');if(el.dataset.loaded)return;try{const rows=await api('/api/exams');el.innerHTML=rows.length?rows.map(x=>`<button class="exam-card" data-id="${esc(x.version_id)}"><span class="year">${esc(x.recruitment_year)}</span><div class="eyebrow">${esc(x.code||'EXAM')}</div><h3>${esc(x.name)}</h3><p>${esc(x.organization)} · syllabus ${esc(x.syllabus_version)}</p><span class="feature-link">Open syllabus →</span></button>`).join(''):'<div class="loading-panel">No verified exam versions available.</div>';el.dataset.loaded='1';el.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>openExam(b.dataset.id))}catch(e){el.innerHTML=`<div class="loading-panel">${esc(e.message)}</div>`}}
async function openExam(id){const box=$('#exam-detail');box.hidden=false;box.innerHTML='<div class="loading-panel">Loading version-pinned syllabus…</div>';try{const d=await api(`/api/exams/${id}/syllabus`),nodes=d.tree||[];const leaves=nodes.filter(n=>!nodes.some(x=>x.parent_id===n.id)),content=leaves.length?leaves.map(n=>`<div class="syllabus-node"><strong>${esc(n.title)}</strong><small>${esc(n.code||'')} ${n.source_page?`· page ${esc(n.source_page)}`:''}</small><div class="progress-track"><span style="width:0%"></span></div></div>`).join(''):'<div class="muted">No syllabus nodes recorded.</div>';box.innerHTML=`<div class="page-head"><div><div class="eyebrow">${esc(d.exam_version.syllabus_version)}</div><h3>${esc(d.exam_version.name||'Exam syllabus')} · ${esc(d.exam_version.recruitment_year)}</h3><p>${esc(d.exam_version.pattern?JSON.stringify(d.exam_version.pattern):'Verified version')}</p></div><button class="ghost-btn" id="close-exam">Close</button></div><div class="syllabus-tree">${content}</div>`;$('#close-exam').onclick=()=>box.hidden=true}catch(e){box.innerHTML=`<div class="loading-panel">${esc(e.message)}</div>`}}
async function loadCareer(){
 if($('#graph-result').dataset.loaded)return;try{const [g,paths]=await Promise.all([api('/api/graph'),api('/api/career-paths')]);renderGraph(g);renderPaths(paths);$('#graph-result').dataset.loaded='1'}catch(e){$('#graph-result').innerHTML=`<div class="loading-panel">${esc(e.message)}</div>`}}
function renderGraph(g){const nodes=g.nodes||[],edges=g.edges||[];const types={};nodes.forEach(n=>types[n.type]=(types[n.type]||0)+1);$('#graph-result').innerHTML=`<div class="graph-summary"><div class="graph-stat"><strong>${nodes.length}</strong><span>documented nodes</span></div><div class="graph-stat"><strong>${edges.length}</strong><span>documented relationships</span></div><div class="graph-stat"><strong>${Object.keys(types).length}</strong><span>entity types</span></div></div><p class="muted">The graph is derived from published recruitment records. It does not invent relationships.</p>`}
function renderPaths(paths){const el=$('#career-paths');el.innerHTML=(paths||[]).map(p=>{let steps=[];try{steps=typeof p.steps==='string'?JSON.parse(p.steps):p.steps||[]}catch{}return`<article class="path-card"><div class="eyebrow">${esc(p.code||'PATH')}</div><h3>${esc(p.title)}</h3><p>${esc(p.description||'')}</p><div class="path-steps">${steps.map((s,i)=>`<div class="path-step">${i+1}. ${esc(typeof s==='string'?s:(s.title||s.label||JSON.stringify(s)))}</div>`).join('')}</div></article>`}).join('')}
$('#graph-search').onclick=async()=>{const q=$('#graph-q').value.trim();if(!q)return;try{const r=await api('/api/assistant/graph',{method:'POST',body:JSON.stringify({question:q})});$('#graph-result').innerHTML=r.understood?`<div class="graph-summary"><div class="graph-stat"><strong>${r.jobs?.length||0}</strong><span>matching documented roles</span></div><div class="graph-stat"><strong>${Object.keys(r.constraints||{}).length}</strong><span>constraints understood</span></div><div class="graph-stat"><strong>${r.path?.length||0}</strong><span>graph hops</span></div></div><p>${r.jobs?.length?r.jobs.map(x=>`<span class="chip">${esc(x.title)}</span>`).join(' '):'No documented role satisfies all stated constraints.'}</p>`:`<div class="empty">${esc(r.note||'No graph-answerable constraint found.')}</div>`}catch(e){showToast(e.message)}};
$('#graph-ask-btn').onclick=()=>{$('#graph-q').focus()};
const TRACK_KEY='govcareer.tracker.v1';
function localTracker(){try{return JSON.parse(localStorage.getItem(TRACK_KEY)||'[]')}catch{return[]}}
function saveTracker(rows){localStorage.setItem(TRACK_KEY,JSON.stringify(rows));}
function trackLocal(job){const rows=localTracker().filter(x=>x.id!==job.id);rows.unshift({id:job.id,title:job.title,organization:job.organization,status:'WATCHING',deadline:job.dates?.application_close||job.dates?.deadline||null,updated_at:new Date().toISOString()});saveTracker(rows);showToast('Added to your local application cockpit');loadTools()}
async function loadLiveSources(){const box=$('#live-sources');if(!box)return;box.innerHTML='<span class=\"muted\">Checking official portals…</span>';try{const d=await api('/api/live/opportunities');box.innerHTML=(d.sources||[]).map(x=>`<article class=\"live-source\"><strong><span class=\"dot\"></span>${esc(x.name)}</strong><span class=\"muted\">${esc(x.status)} · ${esc(x.latency_ms)} ms</span>${(x.links||[]).slice(0,2).map(l=>`<a href=\"${esc(l.url)}\" target=\"_blank\" rel=\"noopener noreferrer\">${esc(l.title)}</a>`).join('')||'<span class=\"muted\">No matching recruitment links detected on this check.</span>'}</article>`).join('')||'<span class=\"muted\">No source results.</span>';const online=(d.sources||[]).filter(x=>x.status==='ONLINE').length;$('#system-health').textContent=`LIVE · ${online}/${(d.sources||[]).length} official portals responding`;}catch(e){box.innerHTML=`<span class=\"muted\">Live monitor unavailable: ${esc(e.message)}</span>`}}

async function loadTools(){const local=localTracker();$('#application-list').innerHTML=local.length?local.slice(0,8).map(x=>`<div class="mini-item"><strong>${esc(x.title)}</strong><br><span class="muted">${esc(x.status)}${x.deadline?' · closes '+esc(fmtDate(x.deadline)):''}</span></div>`).join(''):'<div class="muted">No tracked applications yet. Open an opportunity and choose Track.</div>';try{const rows=await api('/api/account/applications');if(rows.length){$('#application-list').innerHTML=rows.slice(0,8).map(x=>`<div class="mini-item"><strong>${esc(x.title)}</strong><br><span class="muted">${esc(x.status)}</span></div>`).join('')}}catch{}}
$('#tools-refresh').onclick=loadTools;$('#live-refresh').onclick=loadLiveSources;$('#privacy-btn').onclick=async()=>{try{const p=await api('/api/operations/privacy');$('#calendar-output').textContent=`Policy ${p.policy_version}: ${p.principles.join(', ')}.`}catch(e){showToast(e.message)}};$('#calendar-btn').onclick=async()=>{try{const r=await api('/api/account/calendar/token',{method:'POST',body:'{}'});$('#calendar-output').innerHTML=`<a href="${esc(r.ics_url)}" target="_blank" rel="noopener">Open your private calendar feed</a>`}catch(e){showToast('Sign in to create a calendar feed.')}};

async function init(){
 // Populate immediately from the embedded catalog so no selector can ever be stuck at “Select”.
 meta=FALLBACK_META;
 fillSelect($('#p-level'),Object.entries(meta.levels));
 fillSelect($('#p-field'),Object.entries(meta.fields));
 fillSelect($('#p-state'),meta.states.map(x=>[x,x]));
 fillSelect($('#p-domicile'),meta.states.map(x=>[x,x]));
 fillSelect($('#p-category'),meta.categories.map(x=>[x,x]));
 syncProfileUI();
 try{
  const remote=await api('/api/meta',{timeout:5000});
  meta={...FALLBACK_META,...remote,levels:{...FALLBACK_META.levels,...(remote.levels||{})},fields:{...FALLBACK_META.fields,...(remote.fields||{})}};
  fillSelect($('#p-level'),Object.entries(meta.levels));fillSelect($('#p-field'),Object.entries(meta.fields));
  fillSelect($('#p-state'),(meta.states||FALLBACK_META.states).map(x=>[x,x]));fillSelect($('#p-domicile'),(meta.states||FALLBACK_META.states).map(x=>[x,x]));fillSelect($('#p-category'),(meta.categories||FALLBACK_META.categories).map(x=>[x,x]));syncProfileUI();
 }catch(e){showToast('Using built-in profile catalog; live metadata will retry automatically');}
 await loadOverview();search();
}
init();
