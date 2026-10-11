const fs=require('fs'); const path=require('path'); const crypto=require('crypto'); const db=require('./db');
const ROOT=process.env.USER_DOCUMENT_DIR || path.join(process.cwd(),'private_uploads');
const ALLOWED=new Set(['application/pdf','image/png','image/jpeg']); const MAX=10*1024*1024;
function sniffMime(buffer){
 if(!Buffer.isBuffer(buffer)) return null;
 if(buffer.subarray(0,5).toString('ascii') === '%PDF-') return 'application/pdf';
 if(buffer.length>=8 && buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
 if(buffer.length>=3 && buffer.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return 'image/jpeg';
 return null;
}
function ensure(){fs.mkdirSync(ROOT,{recursive:true});}
function safeTitle(s){return String(s||'document').replace(/[^\w.-]+/g,'_').slice(0,120)||'document';}
async function create(accountId,buffer,{title,mime,purpose='ELIGIBILITY_REVIEW'}={}){
 if(!ALLOWED.has(mime)) throw Object.assign(new Error('Unsupported document type.'),{status:415});
 if(!Buffer.isBuffer(buffer)||buffer.length===0||buffer.length>MAX) throw Object.assign(new Error('Document must be between 1 byte and 10 MB.'),{status:413});
 const detected=sniffMime(buffer);
 if(detected!==mime) throw Object.assign(new Error('The uploaded bytes do not match the declared document type.'),{status:415});
 ensure(); const sha=crypto.createHash('sha256').update(buffer).digest('hex'); const dir=path.join(ROOT,String(accountId)); fs.mkdirSync(dir,{recursive:true}); const filename=`${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${safeTitle(title)}`; const storage=path.join(dir,filename); fs.writeFileSync(storage,buffer);
 const r=await db.query(`INSERT INTO user_documents(account_id,title,storage_path,mime,byte_size,sha256,purpose) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,mime,byte_size,sha256,status,purpose,created_at`,[accountId,title||'Document',storage,mime,buffer.length,sha,purpose]);
 return r.rows[0];
}
async function confirm(id,accountId,confirmed){ const status=confirmed?'CONFIRMED':'REJECTED'; const r=await db.query(`UPDATE user_documents SET status=$1,confirmed_at=CASE WHEN $1='CONFIRMED' THEN now() ELSE NULL END WHERE id=$2 AND account_id=$3 AND status='PENDING_CONFIRMATION' RETURNING id,status,confirmed_at`,[status,id,accountId]); if(!r.rows[0]) throw Object.assign(new Error('Document is unavailable or already confirmed.'),{status:409}); return r.rows[0]; }
async function list(accountId){return (await db.query('SELECT id,title,mime,byte_size,sha256,status,purpose,confirmed_at,created_at FROM user_documents WHERE account_id=$1 AND status<>\'DELETED\' ORDER BY created_at DESC',[accountId])).rows;}
async function remove(id,accountId){ const r=await db.query(`UPDATE user_documents SET status='DELETED',deleted_at=now() WHERE id=$1 AND account_id=$2 AND status<>'DELETED' RETURNING storage_path`,[id,accountId]); if(!r.rows[0]) return false; try{fs.rmSync(r.rows[0].storage_path,{force:true});}catch{} return true; }
module.exports={create,confirm,list,remove,MAX,ALLOWED,sniffMime};
