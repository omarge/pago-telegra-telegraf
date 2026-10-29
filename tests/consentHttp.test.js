'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events'),{startFormServer}=require('../src/formServer');
test('PIN consent requires exact origin and authenticated actor; no PSP',async()=>{
 let attempts=0;
 const server=startFormServer(0,{
  tenant:'t1',publicOrigin:'https://pay.example.test',
  webSessions:{requireSession:async({token})=>token==='valid'?{actorId:'owner'}:null},
  pinService:{verify:async()=>{attempts++;return true;}},
  paymentGate:{confirmWithVerifiedPin:async({actorId,verifyPin,tenant,operationId,pin})=>{
   assert.equal(actorId,'owner');assert.equal(tenant,'t1');assert.equal(operationId,'payment01');
   assert.equal(await verifyPin({tenant,actorId,pin}),true);return {state:'AUTHORIZED'};
  }}
 });
 try{
  if(!server.listening)await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port+'/pay/consent/verify-pin';
  const post=(origin,cookie)=>fetch(base,{method:'POST',headers:{origin,'content-type':'application/json',cookie},
   body:JSON.stringify({operationId:'payment01',pin:'4826',actorId:'attacker'})});
  assert.equal((await post('https://evil.test','kashbit_tg_session=valid')).status,403);
  assert.equal((await post('https://pay.example.test','kashbit_tg_session=bad')).status,401);
  const ok=await post('https://pay.example.test','kashbit_tg_session=valid');
  assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{state:'AUTHORIZED'});
  assert.equal(attempts,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
