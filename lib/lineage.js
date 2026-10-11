const db=require('./db');
async function record(entityType,entityId,stage,sourceRef=null,metadata={}){await db.query('INSERT INTO lineage_events(entity_type,entity_id,stage,source_ref,metadata) VALUES($1,$2,$3,$4,$5)',[entityType,String(entityId),stage,sourceRef,metadata]);}
async function get(entityType,entityId){return (await db.query('SELECT id,stage,source_ref,metadata,created_at FROM lineage_events WHERE entity_type=$1 AND entity_id=$2 ORDER BY id',[entityType,String(entityId)])).rows;}
module.exports={record,get};
