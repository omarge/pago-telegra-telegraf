'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const argon2=require('argon2');
const crypto=require('node:crypto');
const {createPgPinService}=require('../src/pgPinService');
const pepper='test-pepper-only-not-a-production-secret-1234567890';
const digest=pin=>crypto.createHmac('sha256',pepper).update('KASHBIT-PIN-V1:').update(pin).digest('hex');

test('PIN verification uses Argon2id and increments durable failed-attempt counter',async()=>{
 const hash=await argon2.hash(digest('4826'),{type:argon2.argon2id,timeCost:3,memoryCost:65536,parallelism:2});
 const queries=[];
 const client={query:async(sql,params=[])=>{
  queries.push({sql,params});
  if(sql.startsWith('SELECT verifier'))return {rowCount:1,rows:[{verifier:hash,attempts:0,locked_until:null}]};
  return {rowCount:1,rows:[]};
 },release(){}};
 const pin=createPgPinService({pool:{connect:async()=>client},pepper});
 assert.equal(await pin.verify({tenant:'T1',actorId:'U1',pin:'9999'}),false);
 assert.ok(queries.some(q=>q.sql.includes('FOR UPDATE')));
 const changed=queries.find(q=>q.sql.startsWith('UPDATE'));
 assert.equal(changed.params[2],1);
 assert.ok(queries.some(q=>q.sql==='COMMIT'));
});
test('missing or malformed PIN fails without touching database',async()=>{
 let calls=0;
 const pin=createPgPinService({pool:{connect:async()=>{calls++;throw Error('no DB');}},pepper});
 assert.equal(await pin.verify({tenant:'T1',actorId:'U1',pin:'123'}),false);
 assert.equal(await pin.verify({tenant:'T1',actorId:'U1',pin:'１２３４'}),false);
 assert.equal(calls,0);
});
test('missing pepper fails closed',()=>{
 assert.throws(()=>createPgPinService({pool:{connect(){}},pepper:'short'}),/NOT_CONFIGURED/);
});
