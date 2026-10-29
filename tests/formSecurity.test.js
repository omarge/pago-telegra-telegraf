'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {startFormServer}=require('../src/formServer');
test('unauthenticated legacy card, PIN and charge endpoints cannot render or mutate',async()=>{
 const server=startFormServer(0);
 try{
  if(!server.listening)await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  for(const p of ['/pay/one-time','/cards/enroll','/nip/change']){
   const result=await fetch(base+p);
   assert.equal(result.status,503,p);
  }
  for(const p of ['/pay/charge','/cards/enroll','/nip/change']){
   const result=await fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({user_id:'victim',old_pin:'1234',new_pin:'4567',token_id:'fake'})});
   assert.equal(result.status,503,p);
   assert.equal((await result.json()).code,'SECURE_AUTHORIZATION_REQUIRED');
  }
 }finally{await new Promise(resolve=>server.close(resolve));}
});
