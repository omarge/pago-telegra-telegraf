'use strict';
const crypto=require('node:crypto');
const {messageOriginKey}=require('./messageOrigin');
function createPgPaymentGate(pool){
 if(!pool||typeof pool.connect!=='function')throw Error('POSTGRES_REQUIRED');
 async function transaction(fn){
  const c=await pool.connect();let active=false;
  try{await c.query('BEGIN');active=true;const out=await fn(c);await c.query('COMMIT');active=false;return out;}
  catch(e){if(active)await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async function admitOrigin({tenant,channel,actorId,messageId,payload}){
  const key=messageOriginKey({tenant,channel,actorId,messageId});
  const digest=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return transaction(async c=>{
   const q=await c.query('INSERT INTO telegram_channel.message_inbox (tenant_id,channel,actor_id,message_id,origin_key,payload_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING origin_key',
    [tenant,channel,actorId,messageId,key,digest]);
   if(q.rowCount===1)return {state:'NEW',operationKey:key};
   const prior=await c.query('SELECT payload_digest FROM telegram_channel.message_inbox WHERE tenant_id=$1 AND channel=$2 AND actor_id=$3 AND message_id=$4',[tenant,channel,actorId,messageId]);
   if(prior.rowCount!==1||prior.rows[0].payload_digest!==digest)return {state:'CONFLICT'};
   return {state:'DUPLICATE',operationKey:key};
  });
 }
 async function consumeConsent({tenant,operationId,actorId}){
  return transaction(async c=>{
   const q=await c.query("UPDATE telegram_channel.payment_consent SET state='CONSUMED',consumed_at=now() WHERE tenant_id=$1 AND operation_id=$2 AND actor_id=$3 AND state='AUTHORIZED' AND expires_at>now() RETURNING operation_id,card_reference,amount_minor,currency",
   [tenant,operationId,actorId]);
   return q.rowCount===1?{state:'CONSUMED',operation:q.rows[0]}:{state:'NOT_AUTHORIZED'};
  });
 }
 return Object.freeze({admitOrigin,consumeConsent,isFinancialAuthority:false});
}
module.exports={createPgPaymentGate};
