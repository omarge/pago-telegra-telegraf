'use strict';
const crypto=require('node:crypto');
// This is a transport integrity envelope, NOT PSP execution permission.
// S2S authentication, Merchant authority and financial evidence remain BusinessOS duties.
const fields=['tenantId','operationId','amountMinor','currency','originKey','occurredAt'];
function canonical(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('HANDOFF_INVALID');
 if(Object.keys(value).length!==fields.length || Object.keys(value).some(k=>!fields.includes(k)))throw Error('HANDOFF_INVALID');
 const values=fields.map(k=>value[k]);
 if(values.some(v=>typeof v!=='string'||v.length===0||v.length>256))throw Error('HANDOFF_INVALID');
 if(!/^[A-Za-z0-9_-]{8,128}$/.test(value.operationId)||!/^[A-Z]{3}$/.test(value.currency)||
    !/^[1-9][0-9]{0,15}$/.test(value.amountMinor)||
    !/^msgv1_[a-f0-9]{64}$/.test(value.originKey)||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.occurredAt)||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.occurredAt)||
    !Number.isFinite(Date.parse(value.occurredAt)))throw Error('HANDOFF_INVALID');
 return 'KASHBIT-TELEGRAM-HELD-V1\n'+values.map((v,i)=>fields[i]+':'+Buffer.byteLength(v,'utf8')+':'+v).join('\n');
}
function signHandoff(payload,secret){
 if(typeof secret!=='string'||Buffer.byteLength(secret)<32)throw Error('HANDOFF_KEY_INVALID');
 const mac=crypto.createHmac('sha256',secret).update(canonical(payload)).digest('hex');
 return Object.freeze({version:1,kind:'HELD',payload:{...payload},mac});
}
function verifyHandoff(envelope,secret){
 if(!envelope||Object.keys(envelope).length!==4||Object.keys(envelope).some(k=>!['version','kind','payload','mac'].includes(k))||
    envelope.version!==1||envelope.kind!=='HELD'||typeof envelope.mac!=='string'||
    !/^[a-f0-9]{64}$/.test(envelope.mac))return false;
 try{
  const signed=signHandoff(envelope.payload,secret);
  return crypto.timingSafeEqual(Buffer.from(signed.mac,'hex'),Buffer.from(envelope.mac,'hex'));
 }catch(_){return false;}
}
module.exports={canonical,signHandoff,verifyHandoff};
