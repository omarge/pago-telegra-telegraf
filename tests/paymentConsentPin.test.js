'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPgPaymentGate}=require('../src/pgPaymentGate');
test('PIN receipt updates only matching pending payment',async()=>{
 const sql=[];
 const client={query:async(q)=>{sql.push(q);return q.startsWith('SELECT actor_id')?{rowCount:1,rows:[{actor_id:'u'}]}:q.startsWith('UPDATE telegram_channel.payment_consent')?{rowCount:1,rows:[{operation_id:'o'}]}:{rowCount:0,rows:[]}},release(){}};
 const g=createPgPaymentGate({connect:async()=>client});
 let verified=0;
 const out=await g.confirmWithVerifiedPin({tenant:'t',operationId:'o',actorId:'u',pin:'4826',verifyPin:async()=>{verified++;return true;}});
 assert.equal(out.state,'AUTHORIZED');
 assert.equal(verified,1);
 assert.ok(sql.some(x=>x.includes("state='PENDING'")&&x.includes('RETURNING operation_id')));
 assert.equal(g.isFinancialAuthority,false);
});
