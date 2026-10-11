const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./lib/db');
const repo = require('./lib/repo');
const registry = require('./lib/registry');
const { evaluate, LEVEL_LABEL, FIELD_LABEL } = require('./lib/eligibility');
const { parseQuery, describe, runSearch, STATES } = require('./lib/search');
const { deadlineInfo, formatYMD } = require('./lib/dates');
const { ask } = require('./lib/answer');
const { validateFilters, llmFilters } = require('./lib/assistantSearch');
const { buildGraph, queryGraph, answerGraphQuestion } = require('./lib/knowledgeGraph');
const { audit } = require('./lib/audit');
const citizenAuth = require('./lib/citizenAuth');
const alerts = require('./lib/alerts');
const userDocuments = require('./lib/userDocuments');
const i18n = require('./lib/i18n');
const lineage = require('./lib/lineage');
const observability = require('./lib/observability');
const voice = require('./lib/voice');
const exams = require('./lib/exams');
const runtime = require('./lib/runtime');
const liveSources = require('./lib/liveSources');
const sso = require('./lib/sso');
const realtime = require('./lib/realtime');
const feed = require('./lib/feed');
const detected = require('./lib/detected');

const app = express();
app.disable('x-powered-by');

// Unified Campus Portal bridge ---------------------------------------------------------------
// The P1 portal remains a complete application, but is launched as an internal service and
// exposed through the same GovCareer origin. This keeps the two feature sets intact while
// avoiding cross-origin API failures, cookie problems and hard-coded localhost URLs.
const http = require('http');
const { spawn } = require('child_process');
const CAMPUS_PORT = Number(process.env.CAMPUS_PORT || 3101);
// Bridge: shared secret that signs GovCareer -> Campus server-to-server calls. Generated per boot when not
// configured (unified mode); separate deployments must set the same BRIDGE_SERVICE_SECRET (>= 32 chars) on both.
if (!process.env.BRIDGE_SERVICE_SECRET || process.env.BRIDGE_SERVICE_SECRET.length < 32) process.env.BRIDGE_SERVICE_SECRET = require('./lib/bridge/serviceAuth').newSecret();
const campusApiPrefixes = [
  '/api/auth', '/api/results', '/api/graph/skills', '/api/twin', '/api/voice', '/api/storage',
  '/api/sync', '/api/aptitude', '/api/gate-passes', '/api/portal-auth', '/api/ai',
  '/api/ai-ml', '/api/ai-status', '/api/ai-ml-status', '/api/health/ready', '/api/health/live',
  '/api/health/runtime', '/api/health/metrics', '/api/health/runtime/deep', '/api/usage',
  '/api/vendor/face-api.js', '/api/news/headlines', '/api/v1.0/email', '/api/bridge-source'
];
function shouldProxyCampusApi(url) {
  return campusApiPrefixes.some(prefix => url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?'));
}
function proxyCampus(req, res, targetPath) {
  const headers = { ...req.headers, host: `127.0.0.1:${CAMPUS_PORT}`, 'x-forwarded-host': req.headers.host || '', 'x-forwarded-proto': 'http' };
  const options = { hostname: '127.0.0.1', port: CAMPUS_PORT, method: req.method, path: targetPath, headers, timeout: 125000 };
  const upstream = http.request(options, (up) => {
    res.statusCode = up.statusCode || 502;
    for (const [k,v] of Object.entries(up.headers)) {
      if (k.toLowerCase() === 'content-length' && v == null) continue;
      try { res.setHeader(k, v); } catch (_) {}
    }
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Campus service timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) res.status(503).json({ success:false, error:{code:'CAMPUS_SERVICE_UNAVAILABLE', message:'Campus AI service is starting or unavailable.'}, detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
    else res.destroy(err);
  });
  req.pipe(upstream);
}
function campusBridge(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/campus' || req.path.startsWith('/campus/')) {
    const stripped = req.url.replace(/^\/campus(?=\/|$)/, '') || '/';
    return proxyCampus(req, res, stripped);
  }
  if (shouldProxyCampusApi(req.path)) return proxyCampus(req, res, req.url);
  return next();
}
app.use(campusBridge);

let campusChild = null;
function startCampusService() {
  if (process.env.DISABLE_CAMPUS_PORTAL === '1') return;
  const campusServer = path.join(__dirname, 'campus', 'backend', 'server.js');
  campusChild = spawn(process.execPath, [campusServer], {
    cwd: path.join(__dirname, 'campus', 'backend'),
    env: { ...process.env, BRIDGE_SERVICE_SECRET: process.env.BRIDGE_SERVICE_SECRET, PORT: String(CAMPUS_PORT), CAMPUS_PORT: String(CAMPUS_PORT), CORS_ORIGIN: process.env.CORS_ORIGIN || `http://localhost:${process.env.PORT || 3000}` },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  campusChild.on('exit', (code, signal) => {
    campusChild = null;
    if (!global.__govcareerShuttingDown && code !== 0) console.warn(`[unified] Campus Portal stopped (code=${code}, signal=${signal || 'none'}).`);
  });
}
function stopCampusService() {
  global.__govcareerShuttingDown = true;
  if (campusChild && !campusChild.killed) campusChild.kill('SIGTERM');
}
process.on('exit', stopCampusService);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'"
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

app.use(observability.middleware);
app.use((req, res, next) => ((req.path === '/api/admin/upload' || req.path === '/api/account/documents/upload') ? next() : express.json({ limit: '200kb' })(req, res, next)));

// Single login: the Campus sign-in is the only login screen. Opening GovCareer without a Campus session sends the
// visitor to it (and back here afterwards). Fails open if the Campus service is unreachable; REQUIRE_LOGIN=0 disables.
app.use(async (req, res, next) => {
  try {
    if (req.method !== 'GET' || !(req.path === '/' || req.path === '/index.html')) return next();
    if (process.env.REQUIRE_LOGIN === '0' || (process.env.REQUIRE_LOGIN !== '1' && !sso.campusEnabled())) return next();
    const u = await sso.campusUser(req.headers.cookie, null);
    if (u === null) return res.redirect(302, '/campus/?next=' + encodeURIComponent(req.originalUrl || '/'));
  } catch (_) {}
  next();
});
// A browser that opens this site's root directly is sent to the Campus Portal (the GovCareer AI sub-tab was removed from it). Not applied to the embedded frame (?embed=campus), to
// API clients (they do not ask for text/html), or when GOVCAREER_STANDALONE_ENTRY=1 / ?standalone=1.
app.use((req, res, next) => {
  try {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html') && sso.campusEnabled() && process.env.GOVCAREER_STANDALONE_ENTRY !== '1'
      && /text\/html/.test(req.get('accept') || '') && req.query.embed !== 'campus' && req.query.standalone !== '1') return res.redirect(302, '/campus/');
  } catch (_) {}
  next();
});
app.use('/api/prep', (req, res, next) => require('./lib/prep').handle(req, res, '/api/prep' + req.path, { jobs: async () => require('./data/jobs').buildJobs(new Date()).filter((j) => j.lifecycle !== 'REVIEW_REQUIRED' && j.verification?.status === 'VERIFIED'), runtime: require('./lib/runtime') }).then((h) => h || next()).catch(next));
app.use('/api/admin', require('./routes/admin'));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', wrap(async (_req, res) => {
  let dbOk = true; try { await db.query('SELECT 1'); } catch { dbOk = false; }
  res.status(200).json({ ok: true, database: dbOk, runtime_mode: runtime.isDemo() ? 'RESILIENT_DEMO' : 'POSTGRES', time: new Date().toISOString() });
}));

app.get('/api/meta', (_req, res) => res.json({ states: STATES, levels: LEVEL_LABEL, fields: FIELD_LABEL, categories: ['General', 'EWS', 'OBC', 'SC', 'ST'] }));
app.get('/api/languages', (_req,res)=>res.json({languages:i18n.LANGS, labels:i18n.labels, supported_voice_locales:voice.config().supported_locales}));
app.get('/api/feed', wrap(async (req, res) => {
  const since = Number(req.query.since) || 0, limit = req.query.limit;
  if (runtime.isDemo()) return res.json({ mode: 'DEMO', max_id: detected.maxId(), events: detected.recent({ since, limit }) });
  const kinds = req.query.kinds ? String(req.query.kinds).split(',').filter((k) => feed.KIND_EVENT[k]) : null;
  res.json({ mode: 'LIVE', max_id: await feed.maxId(db), events: await feed.recent(db, { since, limit, kinds }) });
}));
app.get('/api/autolive/status', wrap(async (_req, res) => {
  if (runtime.isDemo()) return res.json({ mode: 'DEMO', note: 'PostgreSQL is not connected, so notices are only detected as links on official portals. They are not read, verified or published automatically.', live: runtime.liveStatus() });
  res.json({ mode: 'LIVE', ...(await feed.status(db)), scheduler: app.locals.scheduler ? { inline: true, leader: app.locals.scheduler.state.leader, tasks: Object.fromEntries(Object.entries(app.locals.scheduler.state.tasks).map(([k, v]) => [k, { at: v.at, ok: v.ok }])) } : { inline: false } });
}));
app.get('/api/operations/metrics', (_req,res)=>res.json(runtime.isDemo() ? runtime.metrics() : observability.snapshot()));
app.get('/api/live/status', (_req,res)=>res.json(runtime.liveStatus()));
app.get('/api/live/opportunities', wrap(async (_req,res)=>{ const checks=await liveSources.checkAll(); checks.forEach(x=>runtime.recordLive(x)); res.json({checked_at:new Date().toISOString(),sources:checks,notice:'Live links are discovered directly from official portals. Structured recruitment facts are published only after verification.'}); }));
app.get('/api/operations/privacy', (_req,res)=>res.json({policy_version:process.env.PRIVACY_POLICY_VERSION||'2026-01', principles:['purpose limitation','data minimisation','consent','access/export','erasure','security safeguards'],document_upload:'confirm-before-use',voice:'opt-in; browser audio is not retained by default'}));
app.get('/api/voice/config', (_req,res)=>res.json(voice.config()));

// Phase 4 citizen accounts and consent.
// Single sign-on with the Campus login. POST {consent:true} is required only the first time (creates the account).
app.post('/api/account/sso', wrap(async (req,res)=>{
  if (runtime.isDemo()) return res.status(503).json({ error:'Accounts need the PostgreSQL runtime.', demo:true });
  const u = await sso.campusUser(req.headers.cookie, req.get('authorization'));
  if (!u) return res.status(401).json({ error:'Sign in on the Campus login first.', login:'/campus/' });
  res.json(await sso.exchange(u, { consent: req.body?.consent === true }));
}));
app.get('/api/session', wrap(async (req,res)=>{ const u = await sso.campusUser(req.headers.cookie, null); res.json({ signed_in: !!u, campus: u === undefined ? 'unreachable' : 'ok', user: u ? { email:u.email, name:u.name, role:u.role } : null, login:'/campus/' }); }));
// Real time: one SSE stream for everyone (public facts); a bearer token adds that person's private events.
app.get('/api/stream', wrap(async (req,res)=>{
  let accountId = null;
  const t = req.query.token || (/^Bearer (.+)$/.exec(req.get('authorization')||'')||[])[1];
  if (t && !runtime.isDemo()) { const a = await citizenAuth.fromToken(t).catch(()=>null); if (a) accountId = a.id; }
  realtime.subscribe(req, res, { accountId });
}));
const legacyLogin = (_q, res, next) => process.env.LEGACY_ACCOUNT_LOGIN === '1' ? next() : res.status(410).json({ error: 'GovCareer uses the single Campus login. Sign in at /campus/.', login: '/campus/' });
app.post('/api/account/register', legacyLogin, wrap(async (req,res)=>res.status(201).json(await citizenAuth.register(req.body||{}))));
app.post('/api/account/login', legacyLogin, wrap(async (req,res)=>res.json(await citizenAuth.login(req.body?.email,req.body?.password,req.ip))));
app.post('/api/account/logout', citizenAuth.middleware, wrap(async(req,res)=>{await citizenAuth.revoke(req.citizenToken);res.json({ok:true});}));
app.get('/api/account/me', citizenAuth.middleware, (req,res)=>res.json(req.citizen));
app.post('/api/account/consent/withdraw', citizenAuth.middleware, wrap(async(req,res)=>{await db.query("UPDATE citizen_accounts SET active=false,updated_at=now() WHERE id=$1",[req.citizen.id]);await db.query("INSERT INTO consent_events(account_id,version,action) VALUES($1,$2,'WITHDRAWN')",[req.citizen.id,req.citizen.consent_version]);await bridgeStore.revokeLink(req.citizen.id).catch(()=>{});await citizenAuth.revoke(req.citizenToken);await audit(`citizen:${req.citizen.email}`,'CONSENT_WITHDRAWN','citizen_account',req.citizen.id,{});res.json({ok:true});}));
app.get('/api/account/export', citizenAuth.middleware, wrap(async(req,res)=>{
  const id=req.citizen.id;
  const [a,w,s,n,apps,c,d,p,pe,bridge]=await Promise.all([
    db.query('SELECT id,email,name,consent_version,consented_at,created_at,updated_at FROM citizen_accounts WHERE id=$1',[id]),
    db.query('SELECT * FROM watchlists WHERE account_id=$1',[id]), db.query('SELECT * FROM saved_searches WHERE account_id=$1',[id]),
    db.query('SELECT id,recruitment_id,event_type,dedupe_key,payload,created_at FROM alert_events WHERE account_id=$1 ORDER BY id',[id]),
    db.query('SELECT * FROM application_tracker WHERE account_id=$1',[id]), db.query('SELECT version,action,at FROM consent_events WHERE account_id=$1 ORDER BY id',[id]),
    db.query('SELECT id,title,mime,byte_size,sha256,status,purpose,confirmed_at,created_at FROM user_documents WHERE account_id=$1 ORDER BY id',[id]),
    db.query('SELECT * FROM user_preferences WHERE account_id=$1',[id]), db.query('SELECT event_type,purpose,policy_version,detail,created_at FROM privacy_events WHERE account_id=$1 ORDER BY id',[id]),
    bridgeApi.exportData(id)
  ]); const extra=await require('./routes/trust').exportExtras(db,id); res.json({export_version:'1.3',...extra,bridge,exported_at:new Date().toISOString(),account:a.rows[0],watchlists:w.rows,saved_searches:s.rows,alerts:n.rows,applications:apps.rows,consent_events:c.rows,user_documents:d.rows,user_preferences:p.rows,privacy_events:pe.rows});
}));
app.delete('/api/account', citizenAuth.middleware, wrap(async(req,res)=>{const id=req.citizen.id;await bridgeApi.unlink({account:req.citizen,cookies:req.headers.cookie||''}).catch(()=>{});await db.tx(async(c)=>{await c.query('DELETE FROM citizen_accounts WHERE id=$1',[id]);});res.json({ok:true,deleted:true});}));

app.get('/api/account/watchlist', citizenAuth.middleware, wrap(async(req,res)=>res.json((await db.query(`SELECT w.id,w.recruitment_id,r.title,w.created_at FROM watchlists w JOIN recruitments r ON r.id=w.recruitment_id WHERE w.account_id=$1 ORDER BY w.created_at DESC`,[req.citizen.id])).rows)));
app.post('/api/account/watchlist/:id', citizenAuth.middleware, wrap(async(req,res)=>{await db.query('INSERT INTO watchlists(account_id,recruitment_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.citizen.id,req.params.id]);res.status(201).json({ok:true});}));
app.delete('/api/account/watchlist/:id', citizenAuth.middleware, wrap(async(req,res)=>{await db.query('DELETE FROM watchlists WHERE account_id=$1 AND recruitment_id=$2',[req.citizen.id,req.params.id]);res.json({ok:true});}));

app.get('/api/account/searches', citizenAuth.middleware, wrap(async(req,res)=>res.json((await db.query('SELECT * FROM saved_searches WHERE account_id=$1 ORDER BY created_at DESC',[req.citizen.id])).rows)));
app.post('/api/account/searches', citizenAuth.middleware, wrap(async(req,res)=>{let {name,query,filters}=req.body||{};if(query&&!filters)filters=parseQuery(query,{}).filters;const r=await db.query('INSERT INTO saved_searches(account_id,name,query,filters) VALUES($1,$2,$3,$4) RETURNING *',[req.citizen.id,name||'Saved search',query||null,filters||{}]);res.status(201).json(r.rows[0]);}));
app.patch('/api/account/searches/:id', citizenAuth.middleware, wrap(async(req,res)=>{const r=await db.query('UPDATE saved_searches SET name=COALESCE($1,name),filters=COALESCE($2,filters),enabled=COALESCE($3,enabled),updated_at=now() WHERE id=$4 AND account_id=$5 RETURNING *',[req.body?.name,req.body?.filters,req.body?.enabled,req.params.id,req.citizen.id]);if(!r.rows[0])return res.status(404).json({error:'Saved search not found.'});res.json(r.rows[0]);}));
app.delete('/api/account/searches/:id', citizenAuth.middleware, wrap(async(req,res)=>{await db.query('DELETE FROM saved_searches WHERE id=$1 AND account_id=$2',[req.params.id,req.citizen.id]);res.json({ok:true});}));
app.get('/api/account/alerts', citizenAuth.middleware, wrap(async(req,res)=>res.json((await db.query(`SELECT ae.*,json_agg(json_build_object('channel',nd.channel,'status',nd.status,'sent_at',nd.sent_at)) deliveries FROM alert_events ae LEFT JOIN notification_deliveries nd ON nd.alert_id=ae.id WHERE ae.account_id=$1 GROUP BY ae.id ORDER BY ae.id DESC LIMIT 100`,[req.citizen.id])).rows)));

// Phase 6: private user documents. Upload never becomes an eligibility input until confirmed.
app.post('/api/account/documents/upload', citizenAuth.middleware, express.raw({type:'*/*',limit:'10mb'}), wrap(async(req,res)=>{
  const title=req.get('x-title')||'User document'; const mime=req.get('content-type')||'application/octet-stream'; const purpose=req.get('x-purpose')||'ELIGIBILITY_REVIEW';
  const doc=await userDocuments.create(req.citizen.id,req.body,{title,mime,purpose});
  await db.query("INSERT INTO privacy_events(account_id,event_type,purpose,policy_version,detail) VALUES($1,'DOCUMENT_UPLOADED',$2,$3,$4)",[req.citizen.id,purpose,process.env.PRIVACY_POLICY_VERSION||'2026-01',{document_id:doc.id,status:doc.status}]);
  await audit(`citizen:${req.citizen.email}`,'DOCUMENT_UPLOADED','user_document',doc.id,{purpose,status:doc.status});
  res.status(201).json({confirm_before_use:true,document:doc});
}));
app.get('/api/account/documents', citizenAuth.middleware, wrap(async(req,res)=>res.json(await userDocuments.list(req.citizen.id))));
app.post('/api/account/documents/:id/confirm', citizenAuth.middleware, wrap(async(req,res)=>{const confirmed=req.body?.confirmed===true;const out=await userDocuments.confirm(req.params.id,req.citizen.id,confirmed);await db.query('INSERT INTO privacy_events(account_id,event_type,purpose,policy_version,detail) VALUES($1,$2,$3,$4,$5)',[req.citizen.id,confirmed?'DOCUMENT_CONFIRMED':'DOCUMENT_REJECTED','ELIGIBILITY_REVIEW',process.env.PRIVACY_POLICY_VERSION||'2026-01',{document_id:req.params.id}]);await audit(`citizen:${req.citizen.email}`,confirmed?'DOCUMENT_CONFIRMED':'DOCUMENT_REJECTED','user_document',req.params.id,{confirmed});res.json(out);}));
app.delete('/api/account/documents/:id', citizenAuth.middleware, wrap(async(req,res)=>{const ok=await userDocuments.remove(req.params.id,req.citizen.id);res.json({ok});}));
app.put('/api/account/preferences', citizenAuth.middleware, wrap(async(req,res)=>{const language=i18n.language(req.body?.language);const voiceEnabled=!!req.body?.voice_enabled;const r=await db.query(`INSERT INTO user_preferences(account_id,language,voice_enabled) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET language=EXCLUDED.language,voice_enabled=EXCLUDED.voice_enabled,updated_at=now() RETURNING *`,[req.citizen.id,language,voiceEnabled]);res.json(r.rows[0]);}));
app.get('/api/account/preferences', citizenAuth.middleware, wrap(async(req,res)=>{const r=await db.query('SELECT * FROM user_preferences WHERE account_id=$1',[req.citizen.id]);res.json(r.rows[0]||{account_id:req.citizen.id,language:'en',voice_enabled:false});}));

app.get('/api/account/applications', citizenAuth.middleware, wrap(async(req,res)=>res.json((await db.query(`SELECT a.*,r.title FROM application_tracker a JOIN recruitments r ON r.id=a.recruitment_id WHERE a.account_id=$1 ORDER BY a.updated_at DESC`,[req.citizen.id])).rows)));
app.put('/api/account/applications/:id', citizenAuth.middleware, wrap(async(req,res)=>{const p=req.body||{};const r=await db.query(`INSERT INTO application_tracker(account_id,recruitment_id,status,application_number,notes,applied_at) VALUES($1,$2,COALESCE($3,'SAVED'),$4,$5,$6) ON CONFLICT(account_id,recruitment_id) DO UPDATE SET status=EXCLUDED.status,application_number=EXCLUDED.application_number,notes=EXCLUDED.notes,applied_at=EXCLUDED.applied_at,updated_at=now() RETURNING *`,[req.citizen.id,req.params.id,p.status,p.application_number||null,p.notes||null,p.applied_at||null]);res.json(r.rows[0]);}));

app.post('/api/account/calendar/token', citizenAuth.middleware, wrap(async(req,res)=>{const crypto=require('crypto');const raw=crypto.randomBytes(32).toString('hex');await db.query('DELETE FROM calendar_tokens WHERE account_id=$1',[req.citizen.id]);await db.query('INSERT INTO calendar_tokens(token_hash,account_id) VALUES($1,$2)',[citizenAuth.sha(raw),req.citizen.id]);res.json({token:raw,ics_url:`/api/calendar/${raw}.ics`});}));
app.get('/api/calendar/:token.ics', wrap(async(req,res)=>{const account=(await db.query('SELECT account_id FROM calendar_tokens WHERE token_hash=$1 AND (expires_at IS NULL OR expires_at>now())',[citizenAuth.sha(req.params.token)])).rows[0];if(!account)return res.status(404).send('Not found');const rows=(await db.query(`SELECT a.recruitment_id,a.status,r.title,r.data FROM application_tracker a JOIN recruitments r ON r.id=a.recruitment_id WHERE a.account_id=$1`,[account.account_id])).rows;const esc=s=>String(s||'').replace(/[\\;,]/g,m=>'\\'+m).replace(/\r?\n/g,'\\n');let out=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//GovCareer AI//EN'];for(const x of rows){const dates=x.data?.dates||{};const d=dates.application_end||dates.last_date||dates.deadline;if(!d)continue;const day=String(d).replace(/-/g,'');out.push('BEGIN:VEVENT',`UID:${esc(x.recruitment_id)}@govcareer.ai`,`DTSTART;VALUE=DATE:${day}`,`SUMMARY:${esc('Application deadline: '+x.title)}`,'END:VEVENT');}out.push('END:VCALENDAR');res.type('text/calendar').send(out.join('\r\n'));}));

// ---- Bridge: Campus skill evidence + resume matched to verified government jobs -----------------------------
// Handlers live in lib/bridge/api.js (shared with standalone.js). Accounts and Campus linking need PostgreSQL;
// resume parsing, self-assessment and matching work for everyone, including the resilient demo runtime.
const bridgeStore = require('./lib/bridge/store');
const bridgeCampus = require('./lib/bridge/campusClient');
const { createApi: createBridgeApi } = require('./lib/bridge/api');
const bridgeApi = createBridgeApi({
  jobs: (now) => repo.publishedJobs(now),
  exams: async () => runtime.isDemo() ? runtime.exams() : (await db.query(`SELECT e.id,e.code,e.name,e.organization,ev.id version_id,ev.recruitment_year,ev.syllabus_version,ev.pattern FROM exams e JOIN exam_versions ev ON ev.exam_id=e.id WHERE ev.status='VERIFIED' ORDER BY e.name,ev.recruitment_year DESC`)).rows,
  syllabus: async (versionId) => runtime.isDemo() ? (runtime.syllabus(versionId) || []) : exams.nodesOf(+versionId),
  get store() { return runtime.isDemo() ? null : bridgeStore; },
  get campus() { return process.env.DISABLE_CAMPUS_PORTAL === '1' && !process.env.CAMPUS_HOST ? null : bridgeCampus; },
  consentVersion: () => process.env.PRIVACY_POLICY_VERSION || '2026-10',
  audit: (actor, action, type, id, detail) => runtime.isDemo() ? Promise.resolve() : audit(actor, action, type, id, detail),
  privacyEvent: (accountId, type, detail) => db.query('INSERT INTO privacy_events(account_id,event_type,purpose,policy_version,detail) VALUES($1,$2,$3,$4,$5)', [accountId, type, 'SKILL_JOB_MATCHING', process.env.PRIVACY_POLICY_VERSION || '2026-01', detail || {}]),
});
const bridgeRoute = (name) => wrap(async (req, res) => {
  const out = await bridgeApi[name]({ body: req.body || {}, params: req.params, query: req.query, account: req.citizen || null, cookies: req.headers.cookie || '' });
  res.status(out.status).json(out.body);
});
const needAccounts = (_req, res, next) => (runtime.isDemo() ? res.status(503).json({ error: 'Accounts are not available in the resilient demo runtime.', code: 'ACCOUNTS_UNAVAILABLE' }) : next());
app.get('/api/bridge/meta', bridgeRoute('meta'));
app.post('/api/bridge/resume/parse', bridgeRoute('parseResume'));
app.post('/api/bridge/analyze', bridgeRoute('analyze'));
app.post('/api/bridge/jobs/:id/explain', bridgeRoute('explain'));
app.post('/api/account/bridge/analyze', needAccounts, citizenAuth.middleware, bridgeRoute('analyze'));
app.post('/api/account/bridge/jobs/:id/explain', needAccounts, citizenAuth.middleware, bridgeRoute('explain'));
app.get('/api/account/bridge/link', needAccounts, citizenAuth.middleware, bridgeRoute('linkStatus'));
app.post('/api/account/bridge/link', needAccounts, citizenAuth.middleware, bridgeRoute('link'));
app.delete('/api/account/bridge/link', needAccounts, citizenAuth.middleware, bridgeRoute('unlink'));
app.get('/api/account/bridge/settings', needAccounts, citizenAuth.middleware, bridgeRoute('getSettings'));
app.put('/api/account/bridge/settings', needAccounts, citizenAuth.middleware, bridgeRoute('putSettings'));
app.get('/api/account/bridge/history', needAccounts, citizenAuth.middleware, bridgeRoute('history'));

// Advanced Strategy Suite (additive, stateless): age runway, deadline radar, decision matrix, syllabus overlap,
// target portfolio, study planner, mock analytics, what-if. The profile travels in the request; nothing is stored.
const { createAdvancedApi } = require('./lib/advanced');
const advancedApi = createAdvancedApi({
  jobs: (now) => repo.publishedJobs(now),
  exams: async () => runtime.isDemo() ? runtime.exams() : (await db.query(`SELECT e.id,e.code,e.name,e.organization,ev.id version_id,ev.recruitment_year,ev.syllabus_version,ev.pattern FROM exams e JOIN exam_versions ev ON ev.exam_id=e.id WHERE ev.status='VERIFIED' ORDER BY e.name,ev.recruitment_year DESC`)).rows,
  syllabus: async (versionId) => runtime.isDemo() ? (runtime.syllabus(versionId) || []) : exams.nodesOf(+versionId),
});
const advRoute = (name) => wrap(async (req, res) => { const out = await advancedApi[name](req.method === 'GET' ? (req.query || {}) : (req.body || {})); res.status(out.status).json(out.body); });
app.get('/api/advanced/meta', advRoute('meta'));
['runway', 'planner', 'rank', 'overlap', 'portfolio', 'brief', 'whatif', 'analytics', 'sm2'].forEach((n) => app.post('/api/advanced/' + n, advRoute(n)));
app.post('/api/advanced/study-plan', advRoute('studyPlan'));
app.post('/api/advanced/next-actions', advRoute('nextActions'));


app.get('/api/map/states', wrap(async(req,res)=>{ if(runtime.isDemo()) return res.json({states:runtime.mapStates()}); const rows=(await db.query(`SELECT COALESCE(data->>'state','All India') state,COUNT(*)::int jobs FROM recruitments WHERE published_at IS NOT NULL AND lifecycle<>'ARCHIVED' GROUP BY 1 ORDER BY jobs DESC`)).rows; res.json({states:rows}); }));

app.post('/api/alerts/run', require('./lib/auth').requireRole('ADMIN'), wrap(async(_req,res)=>res.json(await alerts.workerTick())));

// Natural-language or structured search. Conversation memory = the filters object the client sends back.
app.post('/api/search', wrap(async (req, res) => {
  const { query, context = {}, profile = {} } = req.body || {};
  let filters = context, reset = false;
  if (query) ({ filters, reset } = parseQuery(query, context));
  const now = new Date();
  const results = runSearch(await repo.publishedJobs(now), filters, profile, now);
  const tmap = await require('./lib/trust/service').trustForJobs(await repo.publishedJobs(now), now);
  for (const r of results) { const t = tmap[r.id]; if (t) r.trust = { display_status: t.display_status, verification: t.verification, amended: t.amended, can_rely_on_for_decisions: t.can_rely_on_for_decisions }; }
  res.json({ filters, reset, chips: describe(filters), total: results.length, results });
}));

app.get('/api/jobs/:id', wrap(async (req, res) => {
  const now = new Date();
  const job = (await repo.publishedJobs(now)).find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Recruitment not found or not yet verified.' });
  const lang=i18n.language(req.query.lang||'en'); const trust=await require('./lib/trust/service').trustForJob(job,now); res.json({ ...job, deadline: deadlineInfo(job.dates, now), cutoff_label: formatYMD(job.age.cutoff_date), localized:i18n.renderJobData(job,lang), trust:{display_status:trust.display_status,verification:trust.verification,verification_label:trust.verification_label,phase:trust.phase,amended:trust.amended,can_rely_on_for_decisions:trust.can_rely_on_for_decisions,why:trust.why,open_flags:trust.open_flags} });
}));


const answerAudit = require('./lib/answerAudit');
const auditStore = answerAudit.pgStore(db);
app.post('/api/assistant/ask', wrap(async (req, res) => {
  const { question = '', recruitmentId, mode = 'QUICK', profile = {} } = req.body || {};
  if (!String(question).trim()) return res.status(400).json({ error: 'Question is required.' });
  const now = new Date();
  const jobs = await repo.publishedJobs(now);
  let result;
  try { result = ask({ jobs, question, recruitmentId, mode, profile, now }); }
  catch (e) {
    if (e.status === 409) { await audit('public', 'ASSISTANT_ANSWER_BLOCKED', 'recruitment', recruitmentId || null, { mode, question, unsupported: e.audit.unsupported }); return res.status(409).json({ error: 'The answer was blocked because a figure could not be verified against the official record.', unsupported: e.audit.unsupported }); }
    throw e;
  }
  if (result.needs_clarification) return res.json(result);
  const auditId = runtime.isDemo() ? runtime.audit({ actor:'public', question, mode, recruitment_id:result.recruitment_id, verification:result.audit }) : (await answerAudit.record(auditStore, { actor: 'public', question, result })).id;
  if (!runtime.isDemo()) await audit('public', 'ASSISTANT_ANSWER', 'recruitment', result.recruitment_id, { mode, intent: result.intent, audit_id: auditId, ok: result.audit.ok });
  // v2.9.0: abstain when evidence is insufficient or official documents conflict; separate official facts from derived and generated text.
  const tsvc = require('./lib/trust/service'); const jobForTrust = jobs.find((j) => j.id === result.recruitment_id);
  if (jobForTrust) { const tr = await tsvc.trustForJob(jobForTrust, now); const fl = await tsvc.stores().flags.open(jobForTrust.id); return res.json({ ...tsvc.guardAnswer({ result, trust: tr, flags: fl, question }), audit_id: auditId }); }
  res.json({ ...result, audit_id: auditId });
}));

app.post('/api/assistant/graph', wrap(async (req, res) => {
  const graph = buildGraph(await repo.publishedJobs(new Date()));
  res.json(answerGraphQuestion(graph, req.body?.question || ''));
}));

app.post('/api/assistant/search', wrap(async (req,res)=>{
  const { query='', context={} }=req.body||{};
  const parsed=await llmFilters(query,context);
  const now=new Date();
  const results=runSearch(await repo.publishedJobs(now),parsed.filters,{},now);
  if(runtime.isDemo()) runtime.audit({actor:'public',type:'ASSISTANT_SEARCH',query,filters:parsed.filters,provider:parsed.provider});
  else await audit('public','ASSISTANT_SEARCH','search',null,{query,filters:parsed.filters,provider:parsed.provider});
  res.json({filters:parsed.filters,provider:parsed.provider,results});
}));

app.get('/api/assistant/audit/verify', wrap(async (_req, res) => res.json(runtime.isDemo() ? {ok:true,mode:'RESILIENT_DEMO',records:runtime.metrics().audits} : await answerAudit.verifyChain(auditStore))));
app.get('/api/assistant/audit/:id', wrap(async(req,res)=>{
  if(runtime.isDemo()){ const r=runtime.metrics(); return res.json({id:req.params.id,mode:'RESILIENT_DEMO',note:'Audit record retained in the running public intelligence session.'}); }
  const r=(await db.query('SELECT id,actor,question,mode,recruitment_id,answer,claims,verification,filters,created_at FROM answer_audits WHERE id=$1',[+req.params.id])).rows[0];
  if(!r)return res.status(404).json({error:'Answer audit not found.'}); res.json(r);
}));

app.get('/api/assistant/audit', wrap(async(req,res)=>{
  if(runtime.isDemo()) return res.json([]);
  const rows=(await db.query('SELECT id,question,mode,recruitment_id,verification,created_at FROM answer_audits ORDER BY id DESC LIMIT $1',[Math.min(+req.query.limit||50,200)])).rows; res.json(rows);
}));

app.get('/api/graph', wrap(async(req,res)=>{
  const graph=buildGraph(await repo.publishedJobs(new Date()));
  res.json(req.query.q ? queryGraph(graph,req.query.q) : graph);
}));

app.get('/api/lineage/:entityType/:entityId', wrap(async(req,res)=>res.json({entity_type:req.params.entityType,entity_id:req.params.entityId,events:await lineage.get(req.params.entityType,req.params.entityId)})));

// Phase 5 exam and study APIs. Every tutor request is pinned to a verified recruitment-year syllabus version.
const study=require('./lib/study');
const verifiedVersion=async(id)=>{const v=await exams.version(+id); if(!v) throw Object.assign(new Error('Verified exam version not found.'),{status:404}); return v;};
app.get('/api/exams', wrap(async(req,res)=>{
  if(runtime.isDemo()) return res.json(runtime.exams());
  const rows=(await db.query(`SELECT e.id,e.code,e.name,e.organization,ev.id version_id,ev.recruitment_year,ev.syllabus_version,ev.pattern FROM exams e JOIN exam_versions ev ON ev.exam_id=e.id WHERE ev.status='VERIFIED' ORDER BY e.name,ev.recruitment_year DESC`)).rows;
  res.json(rows);
}));
app.get('/api/exams/:versionId/syllabus', wrap(async(req,res)=>{ if(runtime.isDemo()){ const v=runtime.exams().find(x=>x.version_id===Number(req.params.versionId)); if(!v)return res.status(404).json({error:'Verified exam version not found.'}); return res.json({exam_version:v,tree:runtime.syllabus(req.params.versionId)}); } const v=await verifiedVersion(req.params.versionId); res.json({exam_version:v,tree:await exams.tree(v.id)});}));
app.put('/api/account/syllabus-progress/:nodeId', citizenAuth.middleware, wrap(async(req,res)=>{
  const {pct,status}=study.parseProgress(req.body?.progress_pct);
  const ok=(await db.query(`SELECT 1 FROM syllabus_nodes sn JOIN exam_versions ev ON ev.id=sn.exam_version_id WHERE sn.id=$1 AND ev.status='VERIFIED'`,[+req.params.nodeId])).rowCount>0;
  if(!ok)return res.status(404).json({error:'Syllabus topic not found in a verified version.'});
  const r=await db.query(`INSERT INTO syllabus_progress(account_id,syllabus_node_id,status,progress_pct) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,syllabus_node_id) DO UPDATE SET status=EXCLUDED.status,progress_pct=EXCLUDED.progress_pct,updated_at=now() RETURNING *`,[req.citizen.id,+req.params.nodeId,status,pct]); res.json(r.rows[0]);
}));
app.get('/api/account/syllabus-progress/:versionId', citizenAuth.middleware, wrap(async(req,res)=>{
  const v=await verifiedVersion(req.params.versionId);
  const r=await db.query(`SELECT sp.*,sn.code,sn.title FROM syllabus_progress sp JOIN syllabus_nodes sn ON sn.id=sp.syllabus_node_id WHERE sp.account_id=$1 AND sn.exam_version_id=$2 ORDER BY sn.sort_order,sn.id`,[req.citizen.id,v.id]); res.json(r.rows);
}));
app.post('/api/account/study-plans', citizenAuth.middleware, wrap(async(req,res)=>{
  const v=await exams.version(+req.body?.exam_version_id); if(!v)return res.status(404).json({error:'Verified exam version not found.'});
  const nodes=await exams.nodesOf(v.id);
  const prog=Object.fromEntries((await db.query(`SELECT sp.syllabus_node_id id,sp.status FROM syllabus_progress sp JOIN syllabus_nodes sn ON sn.id=sp.syllabus_node_id WHERE sp.account_id=$1 AND sn.exam_version_id=$2`,[req.citizen.id,v.id])).rows.map(x=>[x.id,x.status]));
  const minutes=Number(req.body.daily_minutes);
  const plan=exams.buildPlan(nodes,req.body.start_date,req.body.target_date,minutes,prog);
  const r=await db.query(`INSERT INTO study_plans(account_id,exam_version_id,start_date,target_date,daily_minutes,plan) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.citizen.id,v.id,req.body.start_date,req.body.target_date,minutes,JSON.stringify(plan)]);
  res.status(201).json({...r.rows[0],warnings:study.planWarnings(plan,minutes)});
}));
app.get('/api/account/study-plans', citizenAuth.middleware, wrap(async(req,res)=>res.json((await db.query(`SELECT sp.*,e.name,ev.recruitment_year,ev.syllabus_version FROM study_plans sp JOIN exam_versions ev ON ev.id=sp.exam_version_id JOIN exams e ON e.id=ev.exam_id WHERE sp.account_id=$1 ORDER BY sp.created_at DESC`,[req.citizen.id])).rows)));
// Learners never receive the answer key before attempting; every question carries its origin label.
app.get('/api/mock-tests/:versionId', wrap(async(req,res)=>{
  if(runtime.isDemo()) return res.json(runtime.mockTests(req.params.versionId));
  const v=await verifiedVersion(req.params.versionId);
  const rows=(await db.query(`SELECT id,title,questions,source_ref FROM mock_tests WHERE exam_version_id=$1 ORDER BY id DESC`,[v.id])).rows;
  res.json(rows.map(r=>({...r,questions:study.publicQuestions(r.questions)})));
}));
app.post('/api/mock-tests/:id/attempts', citizenAuth.middleware, wrap(async(req,res)=>{
  const t=runtime.isDemo()?runtime.mockTestWithAnswers(req.params.id):(await db.query(`SELECT mt.id,mt.questions,ev.pattern FROM mock_tests mt JOIN exam_versions ev ON ev.id=mt.exam_version_id AND ev.status='VERIFIED' WHERE mt.id=$1`,[+req.params.id])).rows[0];
  if(!t)return res.status(404).json({error:'Mock test not found.'});
  const answers=req.body?.answers||{}; const result=study.scoreAttempt(t.questions,answers,t.pattern||{});
  if(runtime.isDemo()) return res.status(201).json({id:t.id,answers,result});
  const r=await db.query(`INSERT INTO mock_attempts(account_id,mock_test_id,answers,score) VALUES($1,$2,$3,$4) RETURNING *`,[req.citizen.id,t.id,JSON.stringify(answers),result.score]); res.status(201).json({...r.rows[0],result});
}));
app.get('/api/career-paths', wrap(async(req,res)=>{ if(runtime.isDemo()) return res.json(runtime.careerPaths()); return res.json((await db.query('SELECT * FROM career_paths ORDER BY title')).rows); }));
app.post('/api/assistant/tutor', wrap(async(req,res)=>{
 const q=req.body?.question??'',tp=req.body?.topic??''; if(typeof q!=='string'||typeof tp!=='string'||q.length>500||tp.length>200)return res.status(400).json({error:'topic (max 200) and question (max 500) must be text.'});
 if(runtime.isDemo()){const v=runtime.exams().find(x=>x.version_id===Number(req.body?.exam_version_id)); if(!v)return res.status(404).json({error:'Verified exam version not found.'}); const tree=runtime.syllabus(v.version_id)||[]; const hit=tree.find(n=>`${n.title} ${n.description}`.toLowerCase().includes(tp.toLowerCase())); return res.json({version:v,topic:tp,question:q,answer:hit?`For ${hit.title}: ${hit.description}. This explanation is pinned to ${v.syllabus_version}. For exact exam rules, verify the current official notification.`:`The verified syllabus for ${v.syllabus_version} contains no exact topic match for “${tp}”. Try a syllabus topic name such as ${tree.map(n=>n.title).join(', ')}.`,sources:tree.filter(n=>!tp||`${n.title} ${n.description}`.toLowerCase().includes(tp.toLowerCase())).slice(0,3).map(n=>({title:n.title,source_ref:n.source_ref,page:n.source_page}))}); }
 res.json(await exams.tutor(+req.body?.exam_version_id,tp,q));
}));


app.get('/api/documents/:id/page/:page', wrap(async(req,res)=>{
  const page=Math.max(1,+req.params.page||1);
  const d=(await db.query(`SELECT d.id,d.storage_path,d.mime,d.title FROM documents d JOIN recruitment_versions v ON v.document_id=d.id JOIN recruitments r ON r.id=d.recruitment_id WHERE d.id=$1 AND v.status IN ('APPROVED','SUPERSEDED') AND r.published_at IS NOT NULL LIMIT 1`,[+req.params.id])).rows[0];
  if(!d)return res.status(404).json({error:'Not found.'});
  res.json({document_id:d.id,title:d.title,page,url:`/api/documents/${d.id}/file#page=${page}`,viewer_url:`/api/documents/${d.id}/file#page=${page}`});
}));

app.post('/api/jobs/:id/eligibility', wrap(async (req, res) => {
  const job = (await repo.publishedJobs(new Date())).find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Recruitment not found or not yet verified.' });
  const e = evaluate(job, (req.body || {}).profile || {}); const t = await require('./lib/trust/service').trustForJob(job);
  res.json({ ...e, trust: { display_status: t.display_status, verification: t.verification, can_rely_on_for_decisions: t.can_rely_on_for_decisions } });
}));

// Public file access only for documents that belong to a PUBLISHED recruitment version.
app.get('/api/documents/:id/file', wrap(async (req, res) => {
  const d = (await db.query(`SELECT d.storage_path,d.mime,d.title FROM documents d JOIN recruitment_versions v ON v.document_id=d.id JOIN recruitments r ON r.id=d.recruitment_id
    WHERE d.id=$1 AND v.status IN ('APPROVED','SUPERSEDED') AND r.published_at IS NOT NULL AND r.lifecycle <> 'ARCHIVED' LIMIT 1`, [+req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: 'Not found.' });
  res.type(d.mime).set('Content-Disposition', `inline; filename="${d.title.replace(/[^\w.-]/g, '_')}"`).send(fs.readFileSync(d.storage_path));
}));

// v2.9.0 trust & evidence layer (additive): status with reasons, evidence ledger, flags, explained eligibility, guards.
require('./routes/trust').mount(app, { db, runtime, repo, citizenAuth, auth: require('./lib/auth'), needAccounts, audit });
// v2.10.0 national coverage (every State/UT), corrected domains, instant Web Push, Atom feed (additive).
require('./routes/national').mount(app, { db, runtime, auth: require('./lib/auth'), audit });

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'ILLEGAL_TRANSITION' || err.code === 'HUMAN_ONLY' ? 409 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on our side.' : err.message, ...(err.errors ? { errors: err.errors } : {}) });
});

app.ready = (async () => { try { await db.migrate(); await registry.seedRegistry(); await require('./lib/sourcePolicy').seedExtra(db); await require('./lib/domainGuard').reconcile({ db, audit }); await repo.seedSampleJobs(); } catch (e) { runtime.enableDemo(e.message); console.warn('GovCareer AI: PostgreSQL unavailable; running resilient public intelligence mode:', e.message); } })();

const port = process.env.PORT || 3000;
// Small public shape pushed to browsers. Missing values stay null: the UI shows "not stated", never a guess.
function slimEvent(e) {
  const p = e.payload || {};
  return { feed_id: e.id, kind: e.kind, recruitment_id: e.recruitment_id || null, title: e.title, organization: e.organization || null, vacancies: p.vacancies ?? null, application_close: p.application_close ?? null,
    verified: p.verified !== false, level: p.level || null, document_url: p.document_url || p.official_url || null, application_link: p.application_link || null, source_url: p.source_url || null, changes: (p.changes || []).slice(0, 4), reason: p.reason || null };
}
// The scheduler (look for new notifications, read them, publish by policy, alerts, broadcast) runs inside this server unless
// RUN_WORKER_INLINE=0. `node worker.js` can run it elsewhere too; an advisory lock lets only one instance schedule.
function startInlineWorker() {
  if (runtime.isDemo() || process.env.RUN_WORKER_INLINE === '0') return;
  try {
    const sch = require('./lib/scheduler').create({ alertProviders: require('./lib/providers').alertProviders });
    const stop = sch.start(); app.locals.scheduler = sch;
    const bye = () => stop().finally(() => process.exit(0)); process.once('SIGTERM', bye); process.once('SIGINT', bye);
    console.log('GovCareer AI: automatic monitoring started (checks official sources on a schedule; see /api/autolive/status)');
  } catch (e) { console.warn('GovCareer AI: automatic monitoring could not start:', e.message); }
}
let lastFeed = null;
function startRealtime() {
  let lastAlert = null;
  realtime.start({
    getJobs: (now) => repo.publishedJobs(now),
    checkSources: async () => {
      const c = await liveSources.checkAll(); c.forEach(x => runtime.recordLive(x));
      // Demo mode has no ingestion pipeline: report links that appear after the first look as "detected, not verified".
      if (runtime.isDemo()) detected.observe(c).forEach(ev => realtime.publish('job.detected', slimEvent(ev)));
      return c;
    },
    pollFeed: async () => {
      if (runtime.isDemo()) return [];
      if (lastFeed === null) { lastFeed = await feed.maxId(db); return []; }
      const rows = (await db.query('SELECT id,kind,recruitment_id,title,organization,payload,created_at FROM feed_events WHERE id>$1 ORDER BY id LIMIT 50', [lastFeed])).rows;
      if (rows.length) lastFeed = Number(rows[rows.length - 1].id);
      return rows.map(feed.toEvent).map(e => ({ type: feed.KIND_EVENT[e.kind] || 'job.new', data: slimEvent(e) }));
    },
    // Alerts are written by the separate worker process, so poll the table (cross-process safe, only while someone is connected).
    pollAlerts: async () => {
      if (runtime.isDemo()) return [];
      if (lastAlert === null) { lastAlert = Number((await db.query('SELECT COALESCE(MAX(id),0) m FROM alert_events')).rows[0].m); return []; }
      const rows = (await db.query('SELECT id,account_id,recruitment_id,event_type,payload FROM alert_events WHERE id>$1 ORDER BY id LIMIT 50', [lastAlert])).rows;
      if (rows.length) lastAlert = Number(rows[rows.length - 1].id);
      return rows.map(r => ({ accountId: r.account_id, data: { id: r.id, recruitment_id: r.recruitment_id, event_type: r.event_type, payload: r.payload } }));
    },
  });
}
if (require.main === module) app.ready.then(() => app.listen(port, () => { console.log(`GovCareer AI running on http://localhost:${port}`); console.log(`Unified Campus Portal: http://localhost:${port}/campus`); startCampusService(); startRealtime(); startInlineWorker(); }));
module.exports = app;
