'use strict';

const {describe,it,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,randomUUID,randomInt}=require('node:crypto');
const {PostgresTelegramInbox}=require('../src/telegram/postgresInbox');
const {PostgresTelegramOutbox}=require('../src/telegram/postgresOutbox');
const {PostgresDemoInviteAuthority}=require('../src/telegram/postgresDemoInvites');
const {DurableTelegramTransport}=require('../src/telegram/durableTransport');
const {createUatCommandHandler,parseDemoAmount,DEMO_INVITE_MESSAGE}=require('../src/telegram/uatCommandHandler');
const {TelegramOutboxDispatcher}=require('../src/telegram/outboxDispatcher');

const KEY=randomBytes(32).toString('hex'),INVITE_KEY=randomBytes(32).toString('hex');
const id=()=>randomInt(600000000,1700000000);
const tg=(updateId,text='/solicitar 10.50',userId=123456)=>({
  update_id:updateId,message:{message_id:updateId,
    from:{id:userId,is_bot:false,first_name:'CI'},
    chat:{id:userId,type:'private'},date:1761680000,text},
});

describe('F05e-02 UAT command validation',()=>{
  it('rejects invalid amount without contacting DB',()=>{
    for(const bad of ['/solicitar','/solicitar 10','/solicitar 0.00',
      '/solicitar 1.2','/solicitar -5.00','/solicitar 1001.00',
      '/solicitar 0001.00','/solicitar 1.00 extra','/solicitar 1.00\n/paid']){
      assert.throws(()=>parseDemoAmount(bad));
    }
    assert.equal(parseDemoAmount('/solicitar 10.50'),1050);
    assert.equal(parseDemoAmount('/solicitar 1000.00'),100000);
  });
  it('requires distinct UAT demo invite authority and a leased, private Telegram actor',async()=>{
    let enqueue=0;
    const handler=createUatCommandHandler({outbox:{
      enqueueForClaim:async()=>{enqueue++;},
    }});
    const msg=tg(200);
    await assert.rejects(handler(msg,{updateId:200,inboxLeaseId:randomUUID()}),
      e=>e.code==='UAT_DEMO_INVITES_DISABLED');
    assert.equal(enqueue,0);
    let created=0;
    const enabled=createUatCommandHandler({
      demoInvites:{createForClaim:async()=>{created++;}},
      outbox:{enqueueForClaim:async()=>{enqueue++;}},
    });
    const malicious={...msg,message:{...msg.message,
      chat:{id:9999,type:'private'}}};
    await assert.rejects(enabled(malicious,{updateId:200,inboxLeaseId:randomUUID()}),
      e=>e.code==='UAT_COMMAND_NOT_MIGRATED');
    await assert.rejects(enabled(msg,{updateId:201,inboxLeaseId:randomUUID()}),
      e=>e.code==='UAT_INBOX_CLAIM_REQUIRED');
    assert.equal(created,0);
    assert.equal(enqueue,0);
  });
});

describe('F05e-02 UAT register-only demo request via PostgreSQL 18',{
  skip:!process.env.F05_POSTGRES_URL,
},()=>{
  let admin,pool,schema,inbox,outbox,invites;
  before(async()=>{
    const {Pool}=require('pg');
    admin=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:2});
    schema='f05e02cmd_'+randomUUID().replaceAll('-','');
    await admin.query('CREATE SCHEMA "'+schema+'"');
    pool=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:20,
      options:'-c search_path='+schema,connectionTimeoutMillis:5000});
    for(const file of ['f05b_telegram_durable_inbox.sql',
      'f05d_telegram_outbox.sql','f05e02_demo_invites.sql']){
      await pool.query(fs.readFileSync(path.join(__dirname,'..','sql',file),'utf8'));
    }
    inbox=new PostgresTelegramInbox({enabled:true,pool,encryptionKeyHex:KEY});
    outbox=new PostgresTelegramOutbox({enabled:true,pool,encryptionKeyHex:KEY});
    invites=new PostgresDemoInviteAuthority({enabled:true,pool,tokenKeyHex:INVITE_KEY});
  });
  beforeEach(async()=>{
    await pool.query('TRUNCATE kashbit_telegram_demo_claims,'+
      'kashbit_telegram_demo_invites,kashbit_telegram_outbox,kashbit_telegram_inbox');
  });
  after(async()=>{
    if(pool)await pool.end();
    if(admin){if(schema)await admin.query('DROP SCHEMA "'+schema+'" CASCADE');
      await admin.end();}
  });
  function transport(){
    return new DurableTelegramTransport({
      inbox,getUpdates:async()=>({ok:true,result:[]}),
      handleUpdate:createUatCommandHandler({outbox,demoInvites:invites}),
    });
  }
  it('registers real immutable demo invite and static outbox notice, without any payment',async()=>{
    const updateId=id();
    await inbox.append(tg(updateId));
    assert.equal(await transport().deliverOnce(),true);
    const invite=(await pool.query('SELECT requester_telegram_id,amount_cents,token_digest '+
      'FROM kashbit_telegram_demo_invites')).rows[0];
    assert.equal(Number(invite.requester_telegram_id),123456);
    assert.equal(Number(invite.amount_cents),1050);
    assert.match(invite.token_digest,/^[0-9a-f]{64}$/);
    const registered=(await pool.query('SELECT state FROM kashbit_telegram_outbox')).rows[0];
    assert.equal(registered.state,'READY');
    assert.equal((await pool.query('SELECT state FROM kashbit_telegram_inbox')).rows[0].state,'DONE');
    const sent=[];
    const dispatch=new TelegramOutboxDispatcher({
      outbox,sendMessage:async(chatId,text)=>{
        sent.push({chatId,text});
        return {message_id:900,chat:{id:chatId}};
      },
    });
    assert.equal(await dispatch.dispatchOnce(),true);
    assert.deepEqual(sent,[{chatId:123456,text:DEMO_INVITE_MESSAGE}]);
    assert.ok(!sent[0].text.includes('ki_'));
    assert.ok(!sent[0].text.includes('Pago completado'));
    assert.equal(await dispatch.dispatchOnce(),false);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_claims')).rows[0].n,0);
  });
  it('crash after invite+notification enqueue before inbound ack does not duplicate records',async()=>{
    const updateId=id();
    await inbox.append(tg(updateId));
    const c=await inbox.claim({leaseSeconds:30});
    const handler=createUatCommandHandler({outbox,demoInvites:invites});
    await handler(c.update,{updateId:c.updateId,inboxLeaseId:c.leaseId});
    await pool.query("UPDATE kashbit_telegram_inbox SET leased_until=now()-interval '1 second' "+
      'WHERE update_id=$1',[updateId]);
    const fresh=await inbox.claim({leaseSeconds:90});
    assert.equal(fresh.updateId,updateId);
    await handler(fresh.update,{updateId:fresh.updateId,inboxLeaseId:fresh.leaseId});
    assert.equal(await inbox.ack(updateId,fresh.leaseId),true);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_invites')).rows[0].n,1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM kashbit_telegram_outbox')).rows[0].n,1);
  });
  it('will not register an invite if inbox delivery is from an invalid actor',async()=>{
    const updateId=id();
    const malicious=tg(updateId,'/solicitar 1.00');
    malicious.message.chat.id=99999;
    await inbox.append(malicious);
    await assert.rejects(transport().deliverOnce(),
      e=>e.code==='TELEGRAM_HANDLER_FAILED');
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_invites')).rows[0].n,0);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM kashbit_telegram_outbox')).rows[0].n,0);
  });
});
