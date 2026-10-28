'use strict';

const {describe,it,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,randomBytes,randomInt,createHmac}=require('node:crypto');
const {PostgresTelegramInbox}=require('../src/telegram/postgresInbox');
const {PostgresDemoInviteAuthority}=require('../src/telegram/postgresDemoInvites');

const ENC=randomBytes(32).toString('hex'),SECRET=randomBytes(32).toString('hex');
const eventId=()=>randomInt(100000000,1900000000);
const event=id=>({update_id:id,message:{
  message_id:id,from:{id:12345,is_bot:false,first_name:'CI'},
  chat:{id:12345,type:'private'},date:1761680000,text:'/solicitar 10.50',
}});

describe('F05e02 non-financial invitation boundary',()=>{
  it('is disabled and requires injected pool and strong invite key',async()=>{
    let calls=0;
    const authority=new PostgresDemoInviteAuthority({
      pool:{connect:()=>{calls++;throw Error('network');}},
    });
    await assert.rejects(authority.createForClaim({}),e=>e.code==='DEMO_INVITE_DISABLED');
    await assert.rejects(authority.redeemForClaim({}),e=>e.code==='DEMO_INVITE_DISABLED');
    assert.equal(calls,0);
    for(const opts of [{enabled:true,pool:null,tokenKeyHex:SECRET},
      {enabled:true,pool:{connect(){}},tokenKeyHex:'weak'}]){
      assert.throws(()=>new PostgresDemoInviteAuthority(opts),
        e=>e.code==='DEMO_INVITE_NOT_CONFIGURED');
    }
  });
  it('rejects fake IDs, oversized amounts and malformed tokens before DB',async()=>{
    let calls=0;
    const authority=new PostgresDemoInviteAuthority({enabled:true,tokenKeyHex:SECRET,
      pool:{connect:()=>{calls++;throw Error('DB accessed');}}});
    const good={updateId:1,inboxLeaseId:randomUUID(),requesterTelegramId:123,amountCents:1050};
    for(const delta of [
      {updateId:-1},{updateId:1.2},{inboxLeaseId:'fake'},
      {requesterTelegramId:0},{requesterTelegramId:'123'},
      {amountCents:0},{amountCents:100000001},{amountCents:1.05},
    ]) await assert.rejects(authority.createForClaim({...good,...delta}),
      e=>e.code==='DEMO_INVITE_INPUT_INVALID');
    await assert.rejects(authority.redeemForClaim({
      updateId:1,inboxLeaseId:good.inboxLeaseId,
      payerTelegramId:456,token:'insecure-small-token',
    }),e=>e.code==='DEMO_INVITE_INPUT_INVALID');
    assert.equal(calls,0);
  });
});

describe('F05e02 PostgreSQL 18 durable demo invites and claims',{
  skip:!process.env.F05_POSTGRES_URL,
},()=>{
  let admin,pool,schema,inbox,invites;
  before(async()=>{
    const {Pool}=require('pg');
    admin=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:2});
    schema='f05e02_'+randomUUID().replaceAll('-','');
    await admin.query('CREATE SCHEMA "'+schema+'"');
    pool=new Pool({connectionString:process.env.F05_POSTGRES_URL,
      max:20,options:'-c search_path='+schema,connectionTimeoutMillis:5000});
    await pool.query(fs.readFileSync(path.join(__dirname,'..',
      'sql/f05b_telegram_durable_inbox.sql'),'utf8'));
    await pool.query(fs.readFileSync(path.join(__dirname,'..',
      'sql/f05e02_demo_invites.sql'),'utf8'));
    inbox=new PostgresTelegramInbox({enabled:true,pool,encryptionKeyHex:ENC});
    invites=new PostgresDemoInviteAuthority({enabled:true,pool,tokenKeyHex:SECRET});
  });
  beforeEach(async()=>await pool.query(
    'TRUNCATE kashbit_telegram_demo_claims,kashbit_telegram_demo_invites,kashbit_telegram_inbox'
  ));
  after(async()=>{
    if(pool)await pool.end();
    if(admin){if(schema)await admin.query('DROP SCHEMA "'+schema+'" CASCADE');
      await admin.end();}
  });

  async function claimEvent(id=eventId()){
    await inbox.append(event(id));
    const claim=await inbox.claim({leaseSeconds:90});
    assert.equal(claim.updateId,id);
    return claim;
  }
  const create=(c,amount=1050,requester=12345)=>invites.createForClaim({
    updateId:c.updateId,inboxLeaseId:c.leaseId,
    requesterTelegramId:requester,amountCents:amount,
  });
  const redeem=(c,token,payer=88888)=>invites.redeemForClaim({
    updateId:c.updateId,inboxLeaseId:c.leaseId,payerTelegramId:payer,token,
  });

  it('stores no invite bearer token and survives restarted repository instances',async()=>{
    const c=await claimEvent();
    const response=await create(c);
    assert.match(response.token,/^ki_[A-Za-z0-9_-]{43}$/);
    assert.equal(response.created,true);
    assert.equal(response.status,'DEMO_INVITE_ONLY_NO_PAYMENT');
    assert.equal(Object.hasOwn(response,'paid'),false);
    const stored=(await pool.query(
      'SELECT * FROM kashbit_telegram_demo_invites WHERE source_update_id=$1',
      [c.updateId])).rows[0];
    assert.ok(stored);
    assert.ok(!JSON.stringify(stored).includes(response.token));
    assert.equal(Number(stored.amount_cents),1050);
    const restarted=new PostgresDemoInviteAuthority({enabled:true,pool,tokenKeyHex:SECRET});
    const repeat=await restarted.createForClaim({
      updateId:c.updateId,inboxLeaseId:c.leaseId,requesterTelegramId:12345,
      amountCents:1050,
    });
    assert.equal(repeat.created,false);
    assert.equal(repeat.token,response.token);
    assert.equal(repeat.demoInviteId,response.demoInviteId);
    assert.equal(await inbox.ack(c.updateId,c.leaseId),true);
    await assert.rejects(create(c),e=>e.code==='DEMO_INBOX_AUTHORITY_LOST');
  });

  it('32 concurrent identical submissions persist exactly one invitation',async()=>{
    const c=await claimEvent();
    const outputs=await Promise.all(Array.from({length:32},()=>create(c)));
    assert.equal(outputs.filter(x=>x.created).length,1);
    assert.equal(new Set(outputs.map(x=>x.token)).size,1);
    assert.equal(new Set(outputs.map(x=>x.demoInviteId)).size,1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_invites')).rows[0].n,1);
    await assert.rejects(create(c,5000),e=>e.code==='DEMO_INVITE_CONFLICT');
    await assert.rejects(create(c,1050,99999),e=>e.code==='DEMO_INVITE_CONFLICT');
  });

  it('requires a live inbox lease, cannot forge creation or redeem using stale worker',async()=>{
    const c=await claimEvent();
    await assert.rejects(invites.createForClaim({
      updateId:c.updateId,inboxLeaseId:randomUUID(),requesterTelegramId:12345,amountCents:1050,
    }),e=>e.code==='DEMO_INBOX_AUTHORITY_LOST');
    const made=await create(c);
    await inbox.ack(c.updateId,c.leaseId);
    const payer=await claimEvent();
    await assert.rejects(redeem(payer,made.token,12345),
      e=>e.code==='DEMO_SELF_REDEMPTION_DENIED');
    await assert.rejects(redeem(payer,made.token+'X'),
      e=>e.code==='DEMO_INVITE_INPUT_INVALID');
    await assert.rejects(redeem(payer,'ki_'+'A'.repeat(43)),
      e=>e.code==='DEMO_INVITE_NOT_FOUND');
    await inbox.ack(payer.updateId,payer.leaseId);
    await assert.rejects(redeem(payer,made.token),
      e=>e.code==='DEMO_INBOX_AUTHORITY_LOST');
  });

  it('redeems only once, and replays same Telegram update without duplicating',async()=>{
    const c=await claimEvent();const made=await create(c);
    await inbox.ack(c.updateId,c.leaseId);
    const payer=await claimEvent();
    const first=await redeem(payer,made.token);
    assert.equal(first.created,true);
    assert.equal(first.status,'DEMO_REDEEMED_NO_PAYMENT');
    assert.equal(Object.hasOwn(first,'paid'),false);
    const replay=await redeem(payer,made.token);
    assert.equal(replay.created,false);
    assert.equal(replay.demoInviteId,first.demoInviteId);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_claims')).rows[0].n,1);
    await inbox.ack(payer.updateId,payer.leaseId);
    const other=await claimEvent();
    await assert.rejects(redeem(other,made.token,99999),
      e=>e.code==='DEMO_INVITE_ALREADY_CLAIMED');
  });

  it('database blocks rewriting invite amount, token and claim recipient',async()=>{
    const c=await claimEvent();const made=await create(c);
    for(const stmt of [
      'UPDATE kashbit_telegram_demo_invites SET amount_cents=1 WHERE invite_id=$1::uuid',
      'DELETE FROM kashbit_telegram_demo_invites WHERE invite_id=$1::uuid',
    ]) await assert.rejects(pool.query(stmt,[made.demoInviteId]),e=>e.code==='P0001');
    await inbox.ack(c.updateId,c.leaseId);
    const payer=await claimEvent();await redeem(payer,made.token);
    for(const stmt of [
      'UPDATE kashbit_telegram_demo_claims SET payer_telegram_id=1 WHERE invite_id=$1::uuid',
      'DELETE FROM kashbit_telegram_demo_claims WHERE invite_id=$1::uuid',
    ]) await assert.rejects(pool.query(stmt,[made.demoInviteId]),e=>e.code==='P0001');
  });

  it('expired token fails closed based on PostgreSQL time',async()=>{
    const source=await claimEvent();
    const made=await create(source);
    await inbox.ack(source.updateId,source.leaseId);
    const creator=12345;
    const token= 'ki_'+createHmac('sha256',Buffer.from(SECRET,'hex'))
      .update('demo-invite-v1:'+source.updateId+':'+creator+':1050').digest('base64url');
    assert.equal(token,made.token);
    // Insert another historical invite directly, using a distinct update id;
    // production immutability trigger is NEVER disabled or bypassed.
    const old=await claimEvent();
    const oldToken='ki_'+createHmac('sha256',Buffer.from(SECRET,'hex'))
      .update('demo-invite-v1:'+old.updateId+':'+creator+':1050').digest('base64url');
    const oldDigest=createHmac('sha256',Buffer.from(SECRET,'hex'))
      .update('demo-lookup-v1:'+oldToken).digest('hex');
    await pool.query('INSERT INTO kashbit_telegram_demo_invites '+
      '(invite_id,source_update_id,token_digest,requester_telegram_id,amount_cents,created_at,expires_at) '+
      "VALUES ($1::uuid,$2,$3,$4,$5,now()-interval '20 minutes',now()-interval '10 minutes')",
      [randomUUID(),old.updateId,oldDigest,creator,1050]);
    await inbox.ack(old.updateId,old.leaseId);
    const payer=await claimEvent();
    await assert.rejects(redeem(payer,oldToken),e=>e.code==='DEMO_INVITE_EXPIRED');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_claims')).rows[0].n,0);
  });
});
