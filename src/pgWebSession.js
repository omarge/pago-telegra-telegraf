'use strict';
const crypto=require('node:crypto');
function createPgWebSession({pool,ttlSeconds=300}={}){
 if(!pool||typeof pool.connect!=='function'||!Number.isSafeInteger(ttlSeconds)||ttlSeconds<30||ttlSeconds>900)
  throw Error('SESSION_CONFIG_INVALID');
 const digest=token=>crypto.createHash('sha256').update(token).digest('hex');
 async function issue({tenant,actorId}={}){
  if(typeof tenant!=='string'||!tenant||typeof actorId!=='string'||!actorId)throw Error('SESSION_IDENTITY_INVALID');
  const token=crypto.randomBytes(32).toString('base64url');
  const q=await pool.query("INSERT INTO telegram_channel.web_session (token_hash,tenant_id,actor_id,expires_at) VALUES ($1,$2,$3,now()+($4::integer * interval '1 second')) RETURNING actor_id",
   [digest(token),tenant,actorId,ttlSeconds]);
  if(q.rowCount!==1)throw Error('SESSION_PERSISTENCE_FAILED');
  return {token,expiresIn:ttlSeconds};
 }
 async function requireSession({tenant,token}={}){
  if(typeof tenant!=='string'||!tenant||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))
   return null;
  const q=await pool.query("SELECT actor_id FROM telegram_channel.web_session WHERE token_hash=$1 AND tenant_id=$2 AND expires_at>now() AND revoked_at IS NULL",
   [digest(token),tenant]);
  return q.rowCount===1?{tenant,actorId:q.rows[0].actor_id}:null;
 }
 async function revoke({tenant,token}={}){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return false;
  const q=await pool.query("UPDATE telegram_channel.web_session SET revoked_at=now() WHERE token_hash=$1 AND tenant_id=$2 AND revoked_at IS NULL",
   [digest(token),tenant]);
  return q.rowCount===1;
 }
 return Object.freeze({issue,requireSession,revoke,isFinancialAuthority:false});
}
module.exports={createPgWebSession};
