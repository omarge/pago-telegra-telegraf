'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const {createPgPaymentGate}=require('../src/pgPaymentGate');
const {createPgPinService}=require('../src/pgPinService');
const {createPgWebSession}=require('../src/pgWebSession');
if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL required');
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:16});
const tenant='integration-'+process.pid;
const gate=createPgPaymentGate(pool);
const pins=createPgPinService({pool,pepper:'integration-secret-pepper-for-CI-only-123456789'});
const sessions=createPgWebSession({pool,ttlSeconds:60});
test.after(async()=>{await pool.query('DELETE FROM telegram_channel.financial_handoff WHERE tenant_id=$1',[tenant]);await pool.query('DELETE FROM telegram_channel.payment_consent WHERE tenant_id=$1',[tenant]);await pool.query('DELETE FROM telegram_channel.message_inbox WHERE tenant_id=$1',[tenant]);await pool.query('DELETE FROM telegram_channel.pin_verifier WHERE tenant_id=$1',[tenant]);await pool.query('DELETE FROM telegram_channel.web_session WHERE tenant_id=$1',[tenant]);await pool.end();});
test('PostgreSQL: 32 identical message arrivals admit exactly one',async()=>{
 const x=await Promise.all(Array.from({length:32},()=>gate.admitOrigin({tenant,channel:'TELEGRAM',actorId:'111',messageId:'555',payload:{amountMinor:1000}})));
 assert.equal(x.filter(y=>y.state==='NEW').length,1);
 assert.equal(x.filter(y=>y.state==='DUPLICATE').length,31);
 const conflict=await gate.admitOrigin({tenant,channel:'TELEGRAM',actorId:'111',messageId:'555',payload:{amountMinor:2000}});
 assert.equal(conflict.state,'CONFLICT');
});
test('PostgreSQL: 32 parallel consent consumers cannot consume twice',async()=>{
 await pool.query("INSERT INTO telegram_channel.payment_consent (tenant_id,operation_id,actor_id,card_reference,amount_minor,currency,expires_at,state) VALUES($1,'operation01','111','token-reference',1000,'MXN',now()+interval '5 minutes','AUTHORIZED')",[tenant]);
 const x=await Promise.all(Array.from({length:32},()=>gate.consumeConsent({tenant,operationId:'operation01',actorId:'111'})));
 assert.equal(x.filter(y=>y.state==='CONSUMED').length,1);
 assert.equal(x.filter(y=>y.state==='NOT_AUTHORIZED').length,31);
 assert.equal((await gate.consumeConsent({tenant,operationId:'operation01',actorId:'other'})).state,'NOT_AUTHORIZED');
});
test('PostgreSQL: PIN enrollment, failure, success, lockout and owner isolation',async()=>{
 await pins.enroll({tenant,actorId:'222',pin:'4826'});
 assert.equal(await pins.verify({tenant,actorId:'222',pin:'0000'}),false);
 assert.equal(await pins.verify({tenant,actorId:'222',pin:'4826'}),true);
 assert.equal(await pins.verify({tenant,actorId:'333',pin:'4826'}),false);
 await Promise.all(Array.from({length:5},()=>pins.verify({tenant,actorId:'222',pin:'0000'})));
 assert.equal(await pins.verify({tenant,actorId:'222',pin:'4826'}),false);
 const q=await pool.query('SELECT attempts FROM telegram_channel.pin_verifier WHERE tenant_id=$1 AND actor_id=$2',[tenant,'222']);
 assert.equal(q.rows[0].attempts,5);
});
test('PostgreSQL: exact payment consent cannot be replayed by 32 concurrent PIN confirmations',async()=>{
 await pins.enroll({tenant,actorId:'444',pin:'4826'});
 await pool.query("INSERT INTO telegram_channel.payment_consent (tenant_id,operation_id,actor_id,card_reference,amount_minor,currency,expires_at) VALUES($1,'operation02','444','card-A',3000,'MXN',now()+interval '5 minutes')",[tenant]);
 const x=await Promise.all(Array.from({length:32},()=>gate.confirmWithVerifiedPin({tenant,operationId:'operation02',actorId:'444',pin:'4826',verifyPin:arg=>pins.verify(arg)})));
 assert.equal(x.filter(y=>y.state==='AUTHORIZED').length,1);
 assert.equal(x.filter(y=>y.state==='NOT_ELIGIBLE').length,31);
 const q=await pool.query('SELECT state,amount_minor,card_reference FROM telegram_channel.payment_consent WHERE tenant_id=$1 AND operation_id=$2',[tenant,'operation02']);
 assert.equal(q.rows[0].state,'AUTHORIZED');assert.equal(q.rows[0].amount_minor,'3000');assert.equal(q.rows[0].card_reference,'card-A');
});
test('PostgreSQL: session token stored hashed, revocable',async()=>{
 const s=await sessions.issue({tenant,actorId:'555'});
 assert.deepEqual(await sessions.requireSession({tenant,token:s.token}),{tenant,actorId:'555'});
 const raw=await pool.query('SELECT token_hash FROM telegram_channel.web_session WHERE tenant_id=$1',[tenant]);
 assert.ok(raw.rows.every(x=>x.token_hash!==s.token));
 assert.equal(await sessions.revoke({tenant,token:s.token}),true);
 assert.equal(await sessions.requireSession({tenant,token:s.token}),null);
});

test('PostgreSQL: 32 concurrent financial handoffs stage exactly one HELD record',async()=>{
 const origin=await gate.admitOrigin({tenant,channel:'TELEGRAM',actorId:'777',messageId:'origin-777',payload:{amountMinor:4200}});
 assert.equal(origin.state,'NEW');
 await pool.query("INSERT INTO telegram_channel.payment_consent (tenant_id,operation_id,actor_id,origin_key,card_reference,amount_minor,currency,expires_at,state) VALUES($1,'operation03','777',$2,'card-G',4200,'MXN',now()+interval '5 minutes','AUTHORIZED')",[tenant,origin.operationKey]);
 const outputs=await Promise.all(Array.from({length:32},()=>gate.stageHeldFinancialHandoff({tenant,operationId:'operation03',actorId:'777'})));
 assert.equal(outputs.filter(x=>x.state==='HELD').length,1);
 assert.equal(outputs.filter(x=>x.state==='NOT_AUTHORIZED').length,31);
 const rows=await pool.query("SELECT status,amount_minor,card_reference FROM telegram_channel.financial_handoff WHERE tenant_id=$1 AND operation_id='operation03'",[tenant]);
 assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].status,'HELD');
 assert.equal(rows.rows[0].amount_minor,'4200');assert.equal(rows.rows[0].card_reference,'card-G');
 assert.equal((await gate.stageHeldFinancialHandoff({tenant,operationId:'operation03',actorId:'intruder'})).state,'NOT_AUTHORIZED');
});

test('PostgreSQL: originless authorized operation cannot stage a financial handoff',async()=>{
 await pool.query("INSERT INTO telegram_channel.payment_consent (tenant_id,operation_id,actor_id,card_reference,amount_minor,currency,expires_at,state) VALUES($1,'operation04','888','card-H',1,'MXN',now()+interval '5 minutes','AUTHORIZED')",[tenant]);
 assert.equal((await gate.stageHeldFinancialHandoff({tenant,operationId:'operation04',actorId:'888'})).state,'NOT_AUTHORIZED');
 const q=await pool.query("SELECT count(*)::int AS n FROM telegram_channel.financial_handoff WHERE tenant_id=$1 AND operation_id='operation04'",[tenant]);
 assert.equal(q.rows[0].n,0);
});
