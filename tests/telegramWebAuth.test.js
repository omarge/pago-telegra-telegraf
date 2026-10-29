'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyTelegramInitData}=require('../src/telegramWebAuth');
const token='123456:TEST_BOT_TOKEN',now=Date.UTC(2026,9,29,12);
function signed(userId=123,ts=Math.floor(now/1000)){
 const fields=[['auth_date',String(ts)],['user',JSON.stringify({id:userId,first_name:'Test'})]];
 const check=fields.map(([k,v])=>k+'='+v).sort().join('\n');
 const secret=crypto.createHmac('sha256','WebAppData').update(token).digest();
 const hash=crypto.createHmac('sha256',secret).update(check).digest('hex');
 return new URLSearchParams([...fields,['hash',hash]]).toString();
}
test('valid signed Telegram identity accepted',()=>assert.equal(
 verifyTelegramInitData(signed(),token,{now}).actorId,'123'));
test('tampering with user and duplicate hash fail closed',()=>{
 const valid=signed();
 assert.throws(()=>verifyTelegramInitData(valid.replace('123','456'),token,{now}));
 assert.throws(()=>verifyTelegramInitData(valid+'&hash='+'0'.repeat(64),token,{now}));
});
test('expired and wrong bot identity denied',()=>{
 assert.throws(()=>verifyTelegramInitData(signed(123,Math.floor(now/1000)-900),token,{now}));
 assert.throws(()=>verifyTelegramInitData(signed(),'different-bot',{now}));
});
