'use strict';
const crypto=require('node:crypto');
function verifyTelegramInitData(initData,botToken,{now=Date.now(),maxAgeSeconds=300}={}){
 if(typeof initData!=='string'||!initData||initData.length>8192||typeof botToken!=='string'||!botToken)
  throw Error('TELEGRAM_AUTH_INVALID');
 const pairs=[...new URLSearchParams(initData)];
 const fields=new Map(pairs);
 if(fields.size!==pairs.length||!fields.has('hash'))throw Error('TELEGRAM_AUTH_INVALID');
 const supplied=fields.get('hash');
 fields.delete('hash');
 if(!/^[a-fA-F0-9]{64}$/.test(supplied))throw Error('TELEGRAM_AUTH_INVALID');
 const check=[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
 const secret=crypto.createHmac('sha256','WebAppData').update(botToken).digest();
 const expected=crypto.createHmac('sha256',secret).update(check).digest();
 if(!crypto.timingSafeEqual(Buffer.from(supplied,'hex'),expected))throw Error('TELEGRAM_AUTH_INVALID');
 const authDate=Number(fields.get('auth_date'));
 if(!Number.isSafeInteger(authDate)||authDate*1000>now+30000||now-authDate*1000>maxAgeSeconds*1000)
  throw Error('TELEGRAM_AUTH_EXPIRED');
 let user;
 try{user=JSON.parse(fields.get('user'));}catch(_){throw Error('TELEGRAM_AUTH_INVALID');}
 if(!Number.isSafeInteger(user?.id)||user.id<=0)throw Error('TELEGRAM_AUTH_INVALID');
 return Object.freeze({actorId:String(user.id),authenticatedAt:authDate});
}
module.exports={verifyTelegramInitData};
