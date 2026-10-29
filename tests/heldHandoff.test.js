'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPgPaymentGate}=require('../src/pgPaymentGate');
test('held handoff is read-only, tenant isolated and contains no card reference',async()=>{
 const calls=[];
 const pool={connect:async()=>{},query:async(sql,params)=>{
  calls.push({sql,params});
  return {rowCount:1,rows:[{operation_id:'operation01',amount_minor:'4200',currency:'MXN',status:'HELD',created_at:new Date()}]};
 }};
 const gate=createPgPaymentGate(pool);
 const item=await gate.readHeldHandoff({tenant:'tenantA',operationId:'operation01'});
 assert.equal(item.status,'HELD');assert.equal(item.amount_minor,'4200');
 assert.deepEqual(calls[0].params,['tenantA','operation01']);
 assert.match(calls[0].sql,/status='HELD'/);
 assert.doesNotMatch(calls[0].sql,/card_reference/);
 assert.equal(gate.isFinancialAuthority,false);
});
test('invalid handoff lookup does not read database',async()=>{
 const gate=createPgPaymentGate({connect(){},query(){throw Error('unexpected DB')}});
 assert.equal(await gate.readHeldHandoff({tenant:'t',operationId:'../../etc'}),null);
});
