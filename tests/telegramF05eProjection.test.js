'use strict';

const {describe,it,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,randomBytes,randomInt}=require('node:crypto');
const {PostgresTelegramInbox}=require('../src/telegram/postgresInbox');
const {PostgresTelegramOutbox}=require('../src/telegram/postgresOutbox');
const {DurableTelegramTransport}=require('../src/telegram/durableTransport');
const {createUatCommandHandler}=require('../src/telegram/uatCommandHandler');
const {TelegramOutboxDispatcher}=require('../src/telegram/outboxDispatcher');

const KEY=randomBytes(32).toString('hex');
const update=(id,text='/estado_cuenta',chatId=5500123)=>({
  update_id:id,message:{message_id:id,from:{
    id:chatId,first_name:'CI',is_bot:false},
    chat:{id:chatId,type:'private'},date:1761680000,text},
});
const next=()=>randomInt(700000000,1700000000);

describe('F05e Telegram informational command projection contracts',()=>{
  it('fails closed with no configured outbox or mismatched inbound lease',async()=>{
    assert.throws(()=>createUatCommandHandler(),
      e=>e.code==='UAT_OUTBOX_NOT_CONFIGURED');
    let enqueued=0;
    const handler=createUatCommandHandler({outbox:{
      enqueueForClaim:async()=>{enqueued++;},
    }});
    await assert.rejects(handler(update(100),{updateId:101,inboxLeaseId:randomUUID()}),
      e=>e.code==='UAT_INBOX_CLAIM_REQUIRED');
    assert.equal(enqueued,0);
  });

  it('will not execute unmigrated financial, invite or callback handlers',async()=>{
    let enqueued=0;
    const handler=createUatCommandHandler({outbox:{
      enqueueForClaim:async()=>{enqueued++;},
    }});
    for (const bad of [
      update(1,'/start'),
      update(2,'/cobrar'),
      update(3,'/guardar_tarjeta'),
      update(4,'/estado_cuenta secret'),
      update(5,'/configuracion'),
      {...update(6),callback_query:{data:'confirm:yes:a'},message:undefined},
      {...update(7),message:{...update(7).message,chat:{id:5,type:'group'}}},
      {...update(8),message:{...update(8).message,from:{id:99,is_bot:false}}},
    ]) {
      await assert.rejects(handler(bad,{
        updateId:bad.update_id,inboxLeaseId:randomUUID(),
      }),e=>e.code==='UAT_COMMAND_NOT_MIGRATED');
    }
    assert.equal(enqueued,0);
  });

  it('dispatcher hides Telegram errors and sends only once',async()=>{
    let sent=0,unknown=0;
    const dispatcher=new TelegramOutboxDispatcher({
      outbox:{
        claimForSend:async()=>sent===0?{updateId:5,actionKey:'statement-unavailable-v1',
          dispatchId:randomUUID(),message:{chatId:11,text:'sample'}}:null,
        markSent:async()=>{throw Error('not expected');},
        finishUnknown:async()=>{unknown++;return true;},
      },
      sendMessage:async()=>{sent++;throw Error('telegram private URL token');},
    });
    await assert.rejects(dispatcher.dispatchOnce(),
      e=>e.code==='OUTBOX_REMOTE_UNKNOWN'&&!e.message.includes('token'));
    assert.equal(await dispatcher.dispatchOnce(),false);
    assert.equal(sent,1);
    assert.equal(unknown,1);
  });
});

describe('F05e PostgreSQL 18 inbox -> outbox -> controlled sender',{
  skip:!process.env.F05_POSTGRES_URL,
},()=>{
  let admin,pool,schema,inbox,outbox;
  before(async()=>{
    const {Pool}=require('pg');
    admin=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:2});
    schema='f05e_'+randomUUID().replaceAll('-','');
    await admin.query('CREATE SCHEMA "'+schema+'"');
    pool=new Pool({connectionString:process.env.F05_POSTGRES_URL,
      options:'-c search_path='+schema,max:15,connectionTimeoutMillis:5000});
    const inboxSql=fs.readFileSync(
      path.join(__dirname,'..','sql','f05b_telegram_durable_inbox.sql'),'utf8');
    const outboxSql=fs.readFileSync(
      path.join(__dirname,'..','sql','f05d_telegram_outbox.sql'),'utf8');
    await pool.query(inboxSql);
    await pool.query(outboxSql);
    inbox=new PostgresTelegramInbox({enabled:true,pool,encryptionKeyHex:KEY});
    outbox=new PostgresTelegramOutbox({enabled:true,pool,encryptionKeyHex:KEY});
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

  const deliver=async(sender)=>{
    const transport=new DurableTelegramTransport({
      inbox,getUpdates:async()=>({ok:true,result:[]}),
      handleUpdate:createUatCommandHandler({outbox}),
    });
    assert.equal(await transport.deliverOnce(),true);
    if(sender){
      const dispatch=new TelegramOutboxDispatcher({outbox,sendMessage:sender});
      return dispatch.dispatchOnce();
    }
  };

  it('routes one read-only command to persisted intent with one confirmed Telegram send',async()=>{
    const id=next();
    await inbox.append(update(id));
    assert.equal(await deliver(),undefined);
    const status=(await pool.query(
      'SELECT state FROM kashbit_telegram_inbox WHERE update_id=$1',[id])).rows[0];
    assert.equal(status.state,'DONE');
    const persisted=(await pool.query(
      'SELECT state FROM kashbit_telegram_outbox WHERE update_id=$1',[id])).rows[0];
    assert.equal(persisted.state,'READY');
    let sends=0,contents='';
    const first=new TelegramOutboxDispatcher({
      outbox,sendMessage:async (chatId,text)=>{
        sends++;contents=text;
        assert.equal(chatId,5500123);
        return {message_id:701,chat:{id:chatId}};
      },
    });
    const second=new TelegramOutboxDispatcher({
      outbox:new PostgresTelegramOutbox({enabled:true,pool,encryptionKeyHex:KEY}),
      sendMessage:async()=>{sends++;throw Error('duplicate');},
    });
    const results=await Promise.all([first.dispatchOnce(),second.dispatchOnce()]);
    assert.equal(results.filter(Boolean).length,1);
    assert.equal(sends,1);
    assert.ok(contents.includes('Financial Subledger'));
    assert.ok(!contents.includes('Pago completado'));
    assert.equal((await pool.query(
      'SELECT state FROM kashbit_telegram_outbox WHERE update_id=$1',[id])).rows[0].state,'SENT');
    assert.deepEqual(await inbox.append(update(id)),{inserted:false,updateId:id});
    assert.equal(await first.dispatchOnce(),false);
    assert.equal(sends,1);
  });

  it('crash after enqueue before inbox ACK cannot duplicate intent on replay',async()=>{
    const id=next();
    await inbox.append(update(id));
    const claim=await inbox.claim({leaseSeconds:90});
    const project=createUatCommandHandler({outbox});
    await project(claim.update,{updateId:claim.updateId,inboxLeaseId:claim.leaseId});
    // Deliberately do not acknowledge; simulate crash / lease expiry.
    await pool.query(
      "UPDATE kashbit_telegram_inbox SET leased_until=now()-interval '1 second' "+
      'WHERE update_id=$1',[id]);
    const restarted=await inbox.claim({leaseSeconds:90});
    assert.equal(restarted.updateId,id);
    const replay=await project(restarted.update,{
      updateId:restarted.updateId,inboxLeaseId:restarted.leaseId,
    });
    assert.equal(replay.inserted,false);
    assert.equal(await inbox.ack(id,restarted.leaseId),true);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::integer AS n FROM kashbit_telegram_outbox')).rows[0].n,1);
  });

  it('timeout after remote send produces UNKNOWN and no automatic second attempt',async()=>{
    const id=next();
    await inbox.append(update(id));
    await deliver();
    let calls=0;
    const dispatcher=new TelegramOutboxDispatcher({
      outbox,sendMessage:async()=>{calls++;throw Error('timeout-after-remote-accepted');},
    });
    await assert.rejects(dispatcher.dispatchOnce(),
      e=>e.code==='OUTBOX_REMOTE_UNKNOWN');
    assert.equal(calls,1);
    const second=new TelegramOutboxDispatcher({
      outbox,sendMessage:async()=>{calls++;throw Error('should never call');},
    });
    assert.equal(await second.dispatchOnce(),false);
    assert.equal(calls,1);
    const row=(await pool.query('SELECT state,attempts FROM kashbit_telegram_outbox '+
      'WHERE update_id=$1',[id])).rows[0];
    assert.equal(row.state,'UNKNOWN');
    assert.equal(row.attempts,1);
  });

  it('crash after claiming send before calling Telegram never retries IN_FLIGHT',async()=>{
    const id=next();
    await inbox.append(update(id));
    await deliver();
    const claimed=await outbox.claimForSend();
    assert.equal(claimed.updateId,id);
    let calls=0;
    const restarted=new TelegramOutboxDispatcher({
      outbox:new PostgresTelegramOutbox({enabled:true,pool,encryptionKeyHex:KEY}),
      sendMessage:async()=>{calls++;},
    });
    assert.equal(await restarted.dispatchOnce(),false);
    assert.equal(calls,0);
    assert.equal((await pool.query(
      'SELECT state FROM kashbit_telegram_outbox WHERE update_id=$1',
      [id])).rows[0].state,'IN_FLIGHT');
  });
});
