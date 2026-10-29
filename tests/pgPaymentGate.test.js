'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPgPaymentGate}=require('../src/pgPaymentGate');
test('consent consumption is conditional on authorized state and scope',async()=>{
 const calls=[];
 const client={query:async(sql,params)=>{calls.push({sql,params});return sql.startsWith('UPDATE')?{rowCount:0,rows:[]}:{rowCount:0,rows:[]};},release(){}};
 const g=createPgPaymentGate({connect:async()=>client});
 const result=await g.consumeConsent({tenant:'a',operationId:'op1',actorId:'user1'});
 assert.equal(result.state,'NOT_AUTHORIZED');
 assert.match(calls[1].sql,/state='AUTHORIZED'/);
 assert.match(calls[1].sql,/expires_at>now/);
 assert.equal(g.isFinancialAuthority,false);
});
