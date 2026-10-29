'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events'),{startFormServer}=require('../src/formServer');
test('consent microapp renders without PIN/card secrets and keeps PSP closed',async()=>{
 const server=startFormServer(0);
 try{
  if(!server.listening)await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const page=await fetch(base+'/pay/consent?operationId=operation01');
  assert.equal(page.status,200);
  assert.equal(page.headers.get('cache-control'),'no-store');
  assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  const html=await page.text();
  assert.match(html,/Confirmar pago/);
  assert.ok(!html.includes('OPENPAY_PRIVATE_KEY'));
  assert.ok(!html.includes('initDataUnsafe'));
  const script=await fetch(base+'/pay/consent-app.js');
  assert.equal(script.status,200);
  const js=await script.text();
  assert.match(js,/tg.initData/);
  assert.match(js,/consent\/verify-pin/);
  assert.doesNotMatch(js,/chargeSavedCard|openpayCharge/);
  const charge=await fetch(base+'/pay/charge',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(charge.status,503);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
