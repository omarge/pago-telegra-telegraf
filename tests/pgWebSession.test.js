'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPgWebSession}=require('../src/pgWebSession');
test('persist opaque token digest, not token or phone',async()=>{
 let insert;
 const pool={connect:async()=>{},query:async(sql,params)=>{insert={sql,params};return {rowCount:1,rows:[{actor_id:'987'}]};}};
 const session=createPgWebSession({pool});
 const issued=await session.issue({tenant:'T1',actorId:'987'});
 assert.equal(issued.token.length,43);
 assert.match(insert.params[0],/^[a-f0-9]{64}$/);
 assert.ok(!insert.params.includes(issued.token));
 assert.equal(session.isFinancialAuthority,false);
});
test('expired or revoked sessions are rejected by SQL',async()=>{
 const calls=[];
 const pool={connect:async()=>{},query:async(sql,params)=>{calls.push(sql);return {rowCount:0,rows:[]};}};
 const session=createPgWebSession({pool});
 assert.equal(await session.requireSession({tenant:'T1',token:'a'.repeat(43)}),null);
 assert.match(calls[0],/expires_at>now\(\)/);
 assert.match(calls[0],/revoked_at IS NULL/);
});
test('invalid token rejected without DB',async()=>{
 const session=createPgWebSession({pool:{connect(){},query(){throw Error('DB unexpected');}}});
 assert.equal(await session.requireSession({tenant:'T1',token:'bad'}),null);
});
