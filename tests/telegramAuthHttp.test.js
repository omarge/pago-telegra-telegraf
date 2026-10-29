'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {once}=require('node:events'),{startFormServer}=require('../src/formServer');
test('HTTP Telegram auth accepts signed identity, rejects unsigned and does not execute payment',async()=>{
 const prior=process.env.TELEGRAM_BOT_TOKEN,token='123456:HTTP_TEST';
 process.env.TELEGRAM_BOT_TOKEN=token;
 const now=Math.floor(Date.now()/1000);
 const user=JSON.stringify({id:987654,first_name:'T'});
 const values={auth_date:String(now),user};
 const check=Object.entries(values).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
 const secret=crypto.createHmac('sha256','WebAppData').update(token).digest();
 const hash=crypto.createHmac('sha256',secret).update(check).digest('hex');
 const initData=new URLSearchParams({...values,hash}).toString();
 const server=startFormServer(0,{tenant:'T1',webSessions:{issue:async()=>({token:'a'.repeat(43),expiresIn:300})}});
 try{
  if(!server.listening)await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const post=data=>fetch(base+'/pay/auth/telegram',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const valid=await post({initData});
  assert.equal(valid.status,200);
  assert.equal((await valid.json()).authenticated,true);
  assert.match(valid.headers.get('set-cookie'),/HttpOnly/);
  assert.match(valid.headers.get('set-cookie'),/Secure/);
  const invalid=await post({initData:'user=987654'});
  assert.equal(invalid.status,401);
  const charge=await fetch(base+'/pay/charge',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(charge.status,503);
 } finally {
  await new Promise(resolve=>server.close(resolve));
  if(prior===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=prior;
 }
});
