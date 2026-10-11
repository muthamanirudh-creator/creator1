const crypto=require('crypto');
const db=require('./db');
const {hashPassword,checkPassword}=require('./auth');
const {audit}=require('./audit');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const attempts=new Map();
function keyFor(email,ip){return `${String(ip||'unknown')}|${String(email||'').trim().toLowerCase()}`;}
function blocked(key,now=Date.now()){const xs=(attempts.get(key)||[]).filter(t=>now-t<15*60*1000); attempts.set(key,xs); return xs.length>=5;}
function fail(key,now=Date.now()){attempts.set(key,[...(attempts.get(key)||[]),now]);}
function clear(key){attempts.delete(key);}
async function register({email,name,password}){
  const consentVersion=process.env.PRIVACY_POLICY_VERSION||'2026-10';
  if(!email||!name||!password) throw Object.assign(new Error('Name, email and password are required.'),{status:400});
  if(password.length<10) throw Object.assign(new Error('Password must be at least 10 characters.'),{status:400});
  const e=String(email).trim().toLowerCase();
  try{
    const r=await db.query('INSERT INTO citizen_accounts(email,name,password_hash,consent_version,consented_at) VALUES($1,$2,$3,$4,now()) RETURNING id,email,name,consent_version,consented_at',[e,name.trim(),hashPassword(password),consentVersion]);
    const u=r.rows[0]; await db.query('INSERT INTO consent_events(account_id,version,action) VALUES($1,$2,\'GRANTED\')',[u.id,consentVersion]);
    await audit('citizen:'+e,'CITIZEN_ACCOUNT_CREATED','citizen_account',u.id,{consentVersion});
    return u;
  }catch(err){if(err.code==='23505') throw Object.assign(new Error('An account with that email already exists.'),{status:409});throw err;}
}
async function login(email,password,ip='unknown'){
  const e=String(email||'').trim().toLowerCase();
  const key=keyFor(e,ip);
  if(blocked(key)) throw Object.assign(new Error('Too many attempts. Try again in 15 minutes.'),{status:429});
  const u=(await db.query('SELECT id,email,name,password_hash,consent_version FROM citizen_accounts WHERE email=$1 AND active',[e])).rows[0];
  if(!u||!checkPassword(String(password||''),u.password_hash)){ fail(key); throw Object.assign(new Error('Email or password is incorrect.'),{status:401}); }
  clear(key);
  const token=crypto.randomBytes(32).toString('hex');
  await db.query("INSERT INTO citizen_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[sha(token),u.id]);
  return {token,user:{id:u.id,email:u.email,name:u.name,consent_version:u.consent_version}};
}
async function fromToken(token){if(!token)return null;return (await db.query('SELECT a.id,a.email,a.name,a.consent_version FROM citizen_sessions s JOIN citizen_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active',[sha(token)])).rows[0]||null;}
async function middleware(req,res,next){try{const m=/^Bearer (.+)$/.exec(req.get('authorization')||'');const u=await fromToken(m&&m[1]);if(!u)return res.status(401).json({error:'Sign in required.'});req.citizen=u;req.citizenToken=m[1];next();}catch(e){next(e);}}
async function revoke(token){if(token)await db.query('DELETE FROM citizen_sessions WHERE token_hash=$1',[sha(token)]);}
module.exports={register,login,fromToken,middleware,revoke,sha};
