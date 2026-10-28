'use strict';

const {describe,it,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,randomBytes}=require('node:crypto');
const {PostgresTelegramInbox}=require('../src/telegram/postgresInbox');
const {PostgresTelegramOutbox}=require('../src/telegram/postgresOutbox');

const KEY=randomBytes(32).toString('hex');
function update(id){return {update_id:id,message:{message_id:id,
  from:{id:321,is_bot:false,first_name:'Fixture'},
  chat:{id:321,type:'private'},date:1761680000,text:'ping'}};}
function inbox(pool){return new PostgresTelegramInbox({enabled:true,pool,encryptionKeyHex:KEY});}
function outbox(pool){return new PostgresTelegramOutbox({enabled:true,pool,encryptionKeyHex:KEY});}
function message(text='Mensaje de prueba'){return {chatId:321,text};}
const nextId=()=>Math.floor(Date.now()*1000)%1000000000000 + Math.floor(Math.random()*10000);

describe('F05d immutable Telegram outbox contract',()=>{
  it('is disabled by default and does not call external transports',async()=>{
    let queries=0;
    const box=new PostgresTelegramOutbox({pool:{query:()=>{queries++;}}});
    await assert.rejects(box.enqueueForClaim({}),e=>e.code==='OUTBOX_DISABLED');
    await assert.rejects(box.claimForSend(),e=>e.code==='OUTBOX_DISABLED');
    assert.equal(queries,0);
    assert.throws(()=>new PostgresTelegramOutbox({enabled:true,pool:{query:()=>{}},
      encryptionKeyHex:KEY}),e=>e.code==='OUTBOX_NOT_CONFIGURED');
    assert.throws(()=>new PostgresTelegramOutbox({enabled:true,pool:{
      connect:()=>{},query:()=>{}},encryptionKeyHex:'none'}),
    e=>e.code==='OUTBOX_NOT_CONFIGURED');
  });
  it('rejects malformed messages and untrusted actor fields before DB use',async()=>{
    let acquired=0;
    const box=outbox({query:()=>{},connect:()=>{acquired++;throw new Error('must not connect');}});
    for(const bad of [
      {chatId:0,text:'hi'}, {chatId:1.5,text:'hi'},
      {chatId:321,text:''}, {chatId:321,text:'x'.repeat(4097)},
      {chatId:'321',text:'hi'}, {chatId:321,text:null},
    ])await assert.rejects(box.enqueueForClaim({
      updateId:1,inboxLeaseId:randomUUID(),actionKey:'reply',message:bad,
    }),e=>e.code==='OUTBOX_INPUT_INVALID');
    for(const actionKey of ['../script','', 'bad key','hello\nworld']) {
      await assert.rejects(box.enqueueForClaim({
        updateId:1,inboxLeaseId:randomUUID(),actionKey,message:message(),
      }),e=>e.code==='OUTBOX_INPUT_INVALID');
    }
    await assert.rejects(box.enqueueForClaim({
      updateId:1,inboxLeaseId:'fake',actionKey:'reply',message:message(),
    }),e=>e.code==='OUTBOX_INPUT_INVALID');
    assert.equal(acquired,0);
  });
  it('hides database errors and never leaks connection strings',async()=>{
    const box=outbox({
      query:async()=>{throw new Error('postgres://user:secret@db');},
      connect:()=>{throw new Error('postgres://user:secret@db');},
    });
    await assert.rejects(box.claimForSend(),e=>
      e.code==='OUTBOX_DATABASE_UNAVAILABLE'&&!e.message.includes('secret'));
    await assert.rejects(box.enqueueForClaim({
      updateId:1,inboxLeaseId:randomUUID(),actionKey:'notify',message:message(),
    }),e=>e.code==='OUTBOX_DATABASE_UNAVAILABLE');
  });
});

describe('F05d PostgreSQL 18 outbox idempotency and ambiguity',{
  skip:!process.env.F05_POSTGRES_URL,
},()=>{
  let pool,admin,schema,ib,ob;
  before(async()=>{
    const {Pool}=require('pg');
    admin=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:2});
    schema='f05d_'+randomUUID().replaceAll('-','');
    await admin.query('CREATE SCHEMA "'+schema+'"');
    pool=new Pool({connectionString:process.env.F05_POSTGRES_URL,
      max:20,options:'-c search_path='+schema,connectionTimeoutMillis:5000});
    const sql1=fs.readFileSync(path.join(__dirname,'..','sql',
      'f05b_telegram_durable_inbox.sql'),'utf8');
    const sql2=fs.readFileSync(path.join(__dirname,'..','sql',
      'f05d_telegram_outbox.sql'),'utf8');
    await pool.query(sql1);
    await pool.query(sql2);
    ib=inbox(pool);ob=outbox(pool);
  });
  beforeEach(async()=>{
    await pool.query('TRUNCATE kashbit_telegram_outbox,kashbit_telegram_inbox');
  });
  after(async()=>{
    if(pool)await pool.end();
    if(admin){
      if(schema)await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
      await admin.end();
    }
  });
  async function claimInbox(id){
    await ib.append(update(id));
    const c=await ib.claim({leaseSeconds:90});
    assert.equal(c.updateId,id);
    return c;
  }
  async function stage(c,text='Notificación') {
    return ob.enqueueForClaim({
      updateId:c.updateId,inboxLeaseId:c.leaseId,
      actionKey:'requester-notify',message:message(text),
    });
  }

  it('stages one encrypted effect before acknowledging its inbox event',async()=>{
    const c=await claimInbox(nextId());
    const added=await stage(c,'private-user-telegram-message');
    assert.deepEqual(added,{inserted:true,updateId:c.updateId,
      actionKey:'requester-notify',status:'READY'});
    const stored=(await pool.query('SELECT state,digest,iv,tag,ciphertext,attempts '+
      'FROM kashbit_telegram_outbox WHERE update_id=$1',[c.updateId])).rows[0];
    assert.equal(stored.state,'READY');
    assert.equal(stored.attempts,0);
    assert.equal(stored.iv.length,12);
    assert.equal(stored.tag.length,16);
    assert.ok(!stored.ciphertext.toString('utf8').includes('private-user'));
    assert.equal(await ib.ack(c.updateId,c.leaseId),true);
    await assert.rejects(stage(c),e=>e.code==='OUTBOX_INBOX_AUTHORITY_LOST');
  });

  it('permits 32 concurrent identical staging requests without duplicating effect',async()=>{
    const c=await claimInbox(nextId());
    const all=await Promise.all(Array.from({length:32},()=>stage(c,'once-only-intent')));
    assert.equal(all.filter(x=>x.inserted).length,1);
    assert.equal(all.filter(x=>!x.inserted).length,31);
    const rows=(await pool.query(
      'SELECT COUNT(*)::integer AS n FROM kashbit_telegram_outbox')).rows[0].n;
    assert.equal(rows,1);
    assert.equal((await stage(c,'once-only-intent')).inserted,false);
    await assert.rejects(stage(c,'attacker-changed-economic-message'),
      e=>e.code==='OUTBOX_IDENTITY_CONFLICT');
    assert.equal(await ib.ack(c.updateId,c.leaseId),true);
  });

  it('rejects a forged, expired, or displaced inbox owner',async()=>{
    const c=await claimInbox(nextId());
    await assert.rejects(ob.enqueueForClaim({
      updateId:c.updateId,inboxLeaseId:randomUUID(),
      actionKey:'requester-notify',message:message(),
    }),e=>e.code==='OUTBOX_INBOX_AUTHORITY_LOST');
    await pool.query("UPDATE kashbit_telegram_inbox SET leased_until=now()-interval '2 second' "+
      'WHERE update_id=$1',[c.updateId]);
    await assert.rejects(stage(c),e=>e.code==='OUTBOX_INBOX_AUTHORITY_LOST');
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n '+
      'FROM kashbit_telegram_outbox')).rows[0].n,0);
  });

  it('allows only one irreversible send claim across 32 concurrent dispatchers',async()=>{
    const c=await claimInbox(nextId());
    await stage(c);
    await ib.ack(c.updateId,c.leaseId);
    const claims=await Promise.all(Array.from({length:32},()=>ob.claimForSend()));
    assert.equal(claims.filter(Boolean).length,1);
    const send=claims.find(Boolean);
    assert.equal(send.updateId,c.updateId);
    assert.deepEqual(send.message,message('Notificación'));
    assert.equal(await outbox(pool).claimForSend(),null);
    assert.equal((await pool.query('SELECT attempts FROM kashbit_telegram_outbox '+
      'WHERE update_id=$1',[c.updateId])).rows[0].attempts,1);
  });

  it('records valid Telegram confirmation and never replays a SENT effect',async()=>{
    const c=await claimInbox(nextId());
    await stage(c);
    await ib.ack(c.updateId,c.leaseId);
    const sent=await ob.claimForSend();
    const outcome=await ob.markSent(sent,{message_id:991,chat:{id:321}});
    assert.deepEqual(outcome,{
      status:'SENT',updateId:c.updateId,actionKey:'requester-notify',telegramMessageId:991,
    });
    await assert.rejects(ob.markSent(sent,{message_id:991,chat:{id:321}}),
      e=>e.code==='OUTBOX_DELIVERY_UNKNOWN');
    assert.equal(await outbox(pool).claimForSend(),null);
    const row=(await pool.query('SELECT state,attempts FROM kashbit_telegram_outbox '+
      'WHERE update_id=$1',[c.updateId])).rows[0];
    assert.equal(row.state,'SENT');assert.equal(row.attempts,1);
  });

  it('preserves an ambiguous remote success as IN_FLIGHT and never blindly retries',async()=>{
    const c=await claimInbox(nextId());
    await stage(c);
    await ib.ack(c.updateId,c.leaseId);
    const dispatched=await ob.claimForSend();
    let sendCount=0;
    // Inject a successful external send followed by an abrupt process crash
    // before the database can record the Telegram message_id.
    sendCount++;
    const restarted=outbox(pool);
    assert.equal(await restarted.claimForSend(),null);
    assert.equal(sendCount,1);
    await assert.rejects(restarted.markSent(dispatched,{
      message_id:18,chat:{id:9999},
    }),e=>e.code==='OUTBOX_DELIVERY_UNKNOWN');
    const still=(await pool.query('SELECT state FROM kashbit_telegram_outbox '+
      'WHERE update_id=$1',[c.updateId])).rows[0];
    assert.equal(still.state,'IN_FLIGHT');
    await pool.query("UPDATE kashbit_telegram_outbox SET started_at=now()-interval '20 minutes' "+
      'WHERE update_id=$1',[c.updateId]); // must be rejected by monotonic trigger
  });

  it('operator sealing marks stale ambiguous attempt UNKNOWN without sending',async()=>{
    const c=await claimInbox(nextId());
    await stage(c);
    await ib.ack(c.updateId,c.leaseId);
    const dispatched=await ob.claimForSend();
    // Operator manually closes this ambiguous attempt using an explicit
    // acknowledged result, no automatic resend or invented delivery.
    assert.equal(await ob.finishUnknown(dispatched.updateId,
      dispatched.actionKey,dispatched.dispatchId),true);
    assert.equal(await ob.finishUnknown(dispatched.updateId,
      dispatched.actionKey,dispatched.dispatchId),false);
    assert.equal(await outbox(pool).claimForSend(),null);
    assert.equal((await pool.query('SELECT state,attempts FROM kashbit_telegram_outbox '+
      'WHERE update_id=$1',[c.updateId])).rows[0].state,'UNKNOWN');
    assert.equal((await ob.sealStaleAsUnknown()).length,0);
  });

  it('database prevents mutation of message/ciphertext and terminal statuses',async()=>{
    const c=await claimInbox(nextId());
    await stage(c);
    await ib.ack(c.updateId,c.leaseId);
    const dispatched=await ob.claimForSend();
    await ob.finishUnknown(dispatched.updateId,dispatched.actionKey,dispatched.dispatchId);
    for(const sql of [
      "UPDATE kashbit_telegram_outbox SET state='READY' WHERE update_id=$1",
      "UPDATE kashbit_telegram_outbox SET digest=$2 WHERE update_id=$1",
      "DELETE FROM kashbit_telegram_outbox WHERE update_id=$1",
    ]) await assert.rejects(pool.query(sql,
      sql.includes('digest=')?[c.updateId,'0'.repeat(64)]:[c.updateId]),
      e=>e.code==='P0001');
  });
});
