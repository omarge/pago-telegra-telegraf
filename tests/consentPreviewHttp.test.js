'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events'),{startFormServer}=require('../src/formServer');
test('consent preview is actor-scoped, no financial secrets or PAN/token',async()=>{
 const server=startFormServer(0,{
  tenant:'t1',publicOrigin:'https://pay.example.test',
  webSessions:{requireSession:async({token})=>token==='verified'?{actorId:'payer'}:null},
  paymentGate:{previewConsent:async({actorId,operationId})=>actorId==='payer'&&operationId==='operation1'?
    {operation_id:'operation1',amount_minor:1250,currency:'MXN',expires_at:'2026-10-29T23:00:00Z',card_reference:'private-token'}:null}
 });
 try{
  if(!server.listening)await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port+'/pay/consent/preview/operation1';
  assert.equal((await fetch(url)).status,401);
  const ok=await fetch(url,{headers:{cookie:'kashbit_tg_session=verified'}});
  assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store');
  const data=await ok.json();assert.equal(data.amountMinor,1250);
  assert.ok(!JSON.stringify(data).includes('private-token'));
 }finally{await new Promise(resolve=>server.close(resolve));}
});
