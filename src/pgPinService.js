'use strict';
const crypto=require('node:crypto');
const argon2=require('argon2');
function createPgPinService({pool,pepper=process.env.KASHBIT_PIN_PEPPER}={}){
 if(!pool||typeof pool.connect!=='function'||typeof pepper!=='string'||Buffer.byteLength(pepper)<32)
  throw Error('PIN_SERVICE_NOT_CONFIGURED');
 const options={type:argon2.argon2id,timeCost:3,memoryCost:65536,parallelism:2,hashLength:32,saltLength:16};
 const prehash=pin=>crypto.createHmac('sha256',pepper).update('KASHBIT-PIN-V1:').update(pin).digest('hex');
 const valid=pin=>typeof pin==='string'&&/^[0-9]{4}$/.test(pin);
 async function tx(fn){
  const c=await pool.connect();let begun=false;
  try{await c.query('BEGIN');begun=true;const res=await fn(c);await c.query('COMMIT');begun=false;return res;}
  catch(error){if(begun)await c.query('ROLLBACK');throw error;}finally{c.release();}
 }
 async function enroll({tenant,actorId,pin}){
  if(!tenant||!actorId||!valid(pin))throw Error('PIN_ENROLLMENT_INVALID');
  const hash=await argon2.hash(prehash(pin),options);
  return tx(async c=>{
   const res=await c.query('INSERT INTO telegram_channel.pin_verifier (tenant_id,actor_id,verifier) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING actor_id',[tenant,actorId,hash]);
   if(res.rowCount!==1)throw Error('PIN_ALREADY_ENROLLED_OR_RESET_REQUIRED');
   return {enrolled:true};
  });
 }
 async function verify({tenant,actorId,pin}){
  if(!tenant||!actorId||!valid(pin))return false;
  return tx(async c=>{
   const q=await c.query('SELECT verifier,attempts,locked_until FROM telegram_channel.pin_verifier WHERE tenant_id=$1 AND actor_id=$2 FOR UPDATE',[tenant,actorId]);
   if(q.rowCount!==1)return false;
   const row=q.rows[0];
   if(row.attempts>=5||row.locked_until&&new Date(row.locked_until).getTime()>Date.now())return false;
   let match=false;
   try{match=await argon2.verify(row.verifier,prehash(pin));}catch(_){match=false;}
   await c.query("UPDATE telegram_channel.pin_verifier SET attempts=$3,locked_until=CASE WHEN $3>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE tenant_id=$1 AND actor_id=$2",
     [tenant,actorId,match?0:Number(row.attempts)+1]);
   return match;
  });
 }
 return Object.freeze({enroll,verify});
}
module.exports={createPgPinService};
