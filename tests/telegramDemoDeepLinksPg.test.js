'use strict';
const {describe,it,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {PostgresTelegramInbox}=require('../src/telegram/postgresInbox');
const {PostgresTelegramOutbox}=require('../src/telegram/postgresOutbox');
const {PostgresDemoInviteAuthority}=require('../src/telegram/postgresDemoInvites');
const {DurableTelegramTransport}=require('../src/telegram/durableTransport');
const {createUatCommandHandler}=require('../src/telegram/uatCommandHandler');
const {TelegramOutboxDispatcher}=require('../src/telegram/outboxDispatcher');
const {ACTION,REDEEM_ACTION,REDEEM_MESSAGE,renderDemoLink,
  tokenFromDemoLink,startToken,usernameValid}=require('../src/telegram/demoLinkPolicy');

const ENC=crypto.randomBytes(32).toString('hex');
const TOKEN_KEY=crypto.randomBytes(32).toString('hex');
const BOT='KashbitPayBot';
const randomId=()=>crypto.randomInt(700000000,1700000000);
const message=(updateId,fromId,txt)=>({
  update_id:updateId,message:{
    message_id:updateId,date:1761680000,
    from:{id:fromId,is_bot:false,first_name:'CI'},
    chat:{id:fromId,type:'private'},text:txt,
  },
});

describe('F05e-02B Telegram deep-link policy and bypass rejection',()=>{
  it('builds exact Telegram link without alternate domains, HTML or redirect',()=>{
    const token='ki_'+'A'.repeat(43);
    const text=renderDemoLink(BOT,token);
    assert.equal(tokenFromDemoLink(text,BOT),token);
    assert.equal(startToken('/start '+token),token);
    assert.equal(startToken('/start '+token+' extra'),null);
    assert.equal(startToken('/start  '+token),null);
    assert.equal(usernameValid(BOT),true);
    for(const name of ['FakeBot.attacker.com','bot','http://x','payment-site','KashbitPayBot/']){
      assert.throws(()=>renderDemoLink(name,token));
    }
    for(const changed of [
      text.replace('https://t.me/','https://evil.example/'),
      text.replace(BOT,'AnotherFakeBot'),
      text.replace(token,'ki_'+'B'.repeat(43)),
      text+'?',
    ]) assert.throws(()=>tokenFromDemoLink(changed,BOT));
  });
  it('keeps demo links disabled unless explicitly provisioned',async()=>{
    const handler=createUatCommandHandler({
      outbox:{enqueueForClaim:async()=>{}},
      demoInvites:{createForClaim:async()=>({token:'ki_'+'A'.repeat(43)})},
    });
    await assert.rejects(handler(message(11,123,'/start '+'ki_'+'A'.repeat(43)),
      {updateId:11,inboxLeaseId:crypto.randomUUID()}),
      e=>e.code==='UAT_DEMO_LINKS_DISABLED');
    assert.throws(()=>createUatCommandHandler({
      outbox:{enqueueForClaim(){}},demoInvites:{redeemForClaim(){},authorizeLinkDelivery(){}},
      linksEnabled:true,telegramBotUsername:'evil.example',
    }),e=>e.code==='UAT_DEMO_LINKS_NOT_CONFIGURED');
  });
});

describe('F05e-02B PostgreSQL 18 Telegram deep-link issue/redeem with no charges',{
  skip:!process.env.F05_POSTGRES_URL,
},()=>{
  let admin,pool,schema,inbox,outbox,invites;
  before(async()=>{
    const {Pool}=require('pg');
    admin=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:2});
    schema='f05e02b_'+crypto.randomUUID().replaceAll('-','');
    await admin.query('CREATE SCHEMA "'+schema+'"');
    pool=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:20,
      options:'-c search_path='+schema,connectionTimeoutMillis:5000});
    for(const name of ['f05b_telegram_durable_inbox.sql','f05d_telegram_outbox.sql',
      'f05e02_demo_invites.sql']){
      await pool.query(fs.readFileSync(path.join(__dirname,'..','sql',name),'utf8'));
    }
    inbox=new PostgresTelegramInbox({enabled:true,pool,encryptionKeyHex:ENC});
    outbox=new PostgresTelegramOutbox({enabled:true,pool,encryptionKeyHex:ENC});
    invites=new PostgresDemoInviteAuthority({enabled:true,pool,tokenKeyHex:TOKEN_KEY});
  });
  beforeEach(async()=>{
    await pool.query('TRUNCATE kashbit_telegram_demo_claims,kashbit_telegram_demo_invites,'+
      'kashbit_telegram_outbox,kashbit_telegram_inbox');
  });
  after(async()=>{
    if(pool)await pool.end();
    if(admin){
      if(schema)await admin.query('DROP SCHEMA "'+schema+'" CASCADE');
      await admin.end();
    }
  });
  const handler=()=>createUatCommandHandler({
    outbox,demoInvites:invites,linksEnabled:true,telegramBotUsername:BOT,
  });
  const sender=(sendMessage)=>new TelegramOutboxDispatcher({
    outbox,demoInvites:invites,linksEnabled:true,telegramBotUsername:BOT,
    sendMessage,
  });
  const worker=()=>new DurableTelegramTransport({
    inbox,getUpdates:async()=>({ok:true,result:[]}),handleUpdate:handler(),
  });
  async function issue(from=12345,amount='10.50'){
    const sourceId=randomId();
    await inbox.append(message(sourceId,from,'/solicitar '+amount));
    assert.equal(await worker().deliverOnce(),true);
    const rows=(await pool.query('SELECT source_update_id,amount_cents FROM kashbit_telegram_demo_invites')).rows;
    assert.equal(rows.length,1);
    assert.equal(Number(rows[0].source_update_id),sourceId);
    return sourceId;
  }

  it('issues one shareable demo link, redeems once for a distinct private Telegram user',async()=>{
    const sourceId=await issue();
    let sends=[];
    const dispatch=sender(async(chatId,text)=>{
      sends.push({chatId,text});
      return {message_id:500+sends.length,chat:{id:chatId}};
    });
    assert.equal(await dispatch.dispatchOnce(),true);
    assert.equal(sends.length,1);
    assert.equal(sends[0].chatId,12345);
    const token=tokenFromDemoLink(sends[0].text,BOT);
    assert.match(token,/^ki_[A-Za-z0-9_-]{43}$/);
    assert.ok(!sends[0].text.includes('Pago completado'));
    assert.equal(await invites.authorizeLinkDelivery({
      sourceUpdateId:sourceId,requesterTelegramId:12345,token,
    }),true);

    const original=(await pool.query(
      'SELECT token_digest FROM kashbit_telegram_demo_invites')).rows[0];
    assert.ok(!JSON.stringify(original).includes(token));
    const encrypted=(await pool.query(
      'SELECT ciphertext FROM kashbit_telegram_outbox WHERE update_id=$1',[sourceId])).rows[0];
    assert.ok(!encrypted.ciphertext.toString('utf8').includes(token));

    const payer=987654321,redeemId=sourceId+1;
    await inbox.append(message(redeemId,payer,'/start '+token));
    assert.equal(await worker().deliverOnce(),true);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_claims')).rows[0].n,1);
    assert.equal(await dispatch.dispatchOnce(),true);
    assert.deepEqual(sends[1],{chatId:payer,text:REDEEM_MESSAGE});
    assert.equal(await dispatch.dispatchOnce(),false);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_claims')).rows[0].n,1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM kashbit_telegram_outbox')).rows[0].n,2);
    assert.ok(sends.every(s=>!s.text.includes('autorizado un pago')));
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_invites')).rows[0].n,1);
  });

  it('does not send link to a substituted chat even when ciphertext is valid',async()=>{
    const sourceId=await issue();
    const original=await outbox.claimForSend();
    assert.equal(original.actionKey,ACTION);
    const token=tokenFromDemoLink(original.message.text,BOT);
    // The original remains IN_FLIGHT, simulating an ambiguous prior send.
    const otherId=randomId();
    await inbox.append(message(otherId,55555,'/estado_cuenta'));
    const claimed=await inbox.claim({leaseSeconds:90});
    assert.equal(claimed.updateId,otherId);
    await outbox.enqueueForClaim({
      updateId:otherId,inboxLeaseId:claimed.leaseId,actionKey:ACTION,
      message:{chatId:55555,text:renderDemoLink(BOT,token)},
    });
    await inbox.ack(otherId,claimed.leaseId);
    let calls=0;
    const d=sender(async()=>{calls++;return {message_id:10,chat:{id:55555}};});
    await assert.rejects(d.dispatchOnce(),e=>e.code==='OUTBOX_ACTION_NOT_APPROVED');
    assert.equal(calls,0);
    const row=(await pool.query('SELECT state FROM kashbit_telegram_outbox '+
      'WHERE update_id=$1',[otherId])).rows[0];
    assert.equal(row.state,'UNKNOWN');
  });

  it('rejects requester self-redemption and second competing payer',async()=>{
    const sourceId=await issue();
    const send=await outbox.claimForSend();
    const token=tokenFromDemoLink(send.message.text,BOT);
    const self=sourceId+1;
    await inbox.append(message(self,12345,'/start '+token));
    await assert.rejects(worker().deliverOnce(),e=>e.code==='TELEGRAM_HANDLER_FAILED');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_claims')).rows[0].n,0);
    // Quarantine rejected self-update to unblock ordered inbox for the legit payer.
    const selfClaim=await inbox.claim({leaseSeconds:90});
    assert.equal(selfClaim.updateId,self);
    await inbox.quarantine(selfClaim.updateId,selfClaim.leaseId);
    const payer=sourceId+2;
    await inbox.append(message(payer,888888,'/start '+token));
    assert.equal(await worker().deliverOnce(),true);
    const rival=sourceId+3;
    await inbox.append(message(rival,999999,'/start '+token));
    await assert.rejects(worker().deliverOnce(),e=>e.code==='TELEGRAM_HANDLER_FAILED');
    const owner=(await pool.query('SELECT payer_telegram_id FROM kashbit_telegram_demo_claims')).rows[0];
    assert.equal(Number(owner.payer_telegram_id),888888);
  });

  it('does not send expired invite links, even if queued earlier',async()=>{
    const sourceId=randomId(),requester=777777,amount=1050;
    await inbox.append(message(sourceId,requester,'/solicitar 10.50'));
    const claim=await inbox.claim({leaseSeconds:90});
    const token='ki_'+crypto.createHmac('sha256',Buffer.from(TOKEN_KEY,'hex'))
      .update('demo-invite-v1:'+sourceId+':'+requester+':'+amount).digest('base64url');
    const digest=crypto.createHmac('sha256',Buffer.from(TOKEN_KEY,'hex'))
      .update('demo-lookup-v1:'+token).digest('hex');
    await pool.query(
      'INSERT INTO kashbit_telegram_demo_invites '+
      '(invite_id,source_update_id,token_digest,requester_telegram_id,amount_cents,created_at,expires_at) '+
      "VALUES ($1::uuid,$2,$3,$4,$5,now()-interval '20 min',now()-interval '5 min')",
      [crypto.randomUUID(),sourceId,digest,requester,amount]);
    await outbox.enqueueForClaim({
      updateId:sourceId,inboxLeaseId:claim.leaseId,actionKey:ACTION,
      message:{chatId:requester,text:renderDemoLink(BOT,token)},
    });
    await inbox.ack(sourceId,claim.leaseId);
    let calls=0;
    await assert.rejects(sender(async()=>{calls++;}).dispatchOnce(),
      e=>e.code==='OUTBOX_ACTION_NOT_APPROVED');
    assert.equal(calls,0);
    assert.equal((await pool.query(
      'SELECT state FROM kashbit_telegram_outbox')).rows[0].state,'UNKNOWN');
  });

  it('survives crash after redeemed claim committed but before inbox acknowledgement',async()=>{
    const sourceId=await issue();
    const claimedLink=await outbox.claimForSend();
    const token=tokenFromDemoLink(claimedLink.message.text,BOT);
    const redemptionId=sourceId+1;
    await inbox.append(message(redemptionId,444444,'/start '+token));
    const first=await inbox.claim({leaseSeconds:90});
    await handler()(first.update,{updateId:first.updateId,inboxLeaseId:first.leaseId});
    await pool.query("UPDATE kashbit_telegram_inbox SET leased_until=now()-interval '1 second' "+
      'WHERE update_id=$1',[redemptionId]);
    const second=await inbox.claim({leaseSeconds:90});
    assert.equal(second.updateId,redemptionId);
    await handler()(second.update,{updateId:second.updateId,inboxLeaseId:second.leaseId});
    assert.equal(await inbox.ack(second.updateId,second.leaseId),true);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_claims')).rows[0].n,1);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM kashbit_telegram_outbox WHERE action_key=$1',
      [REDEEM_ACTION])).rows[0].n,1);
  });
});
