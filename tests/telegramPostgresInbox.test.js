'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomBytes,randomUUID,randomInt}=require('node:crypto');
const {PostgresTelegramInbox}=require('../src/telegram/postgresInbox');

const KEY=randomBytes(32).toString('hex');
const sample=(id,text='hello')=>({
  update_id:id,
  message:{message_id:3,from:{id:123,is_bot:false,first_name:'Fixture'},
    chat:{id:123,type:'private'},date:1761670000,text},
});
function create(pool,key=KEY){return new PostgresTelegramInbox({enabled:true,pool,encryptionKeyHex:key});}
function id(){return randomInt(100000000,1999999999);}

describe('F05b encrypted inbox core fail-closed contract',()=>{
  it('cannot access DB without opt-in and validated 256-bit encryption key',async()=>{
    let calls=0;
    const disabled=new PostgresTelegramInbox({pool:{query:()=>{calls++;}}});
    await assert.rejects(disabled.append(sample(11)),e=>e.code==='INBOX_DISABLED');
    await assert.rejects(disabled.claim(),e=>e.code==='INBOX_DISABLED');
    assert.equal(calls,0);
    for(const changes of [
      {pool:null,encryptionKeyHex:KEY},
      {pool:{query:()=>{}},encryptionKeyHex:'bad'},
      {pool:{query:()=>{}},encryptionKeyHex:''},
    ]) assert.throws(()=>new PostgresTelegramInbox({enabled:true,...changes}),
      e=>e.code==='INBOX_NOT_CONFIGURED');
  });
  it('validates envelopes and rejects malformed ids/data without DB access',async()=>{
    let calls=0;
    const box=create({query:()=>{calls++;return {rows:[]};}});
    for(const invalid of [null,{update_id:-1},{update_id:1.5},
      {update_id:1,object:undefined},
      {update_id:1,nested:{x:Infinity}},
      {update_id:1,tooLong:'A'.repeat(65536)},
      {update_id:1,prototype:new Date()}]){
      await assert.rejects(box.append(invalid),e=>e.code==='INBOX_ENVELOPE_INVALID');
    }
    assert.equal(calls,0);
  });
  it('redacts DB exceptions and protects against unknown lease',async()=>{
    const box=create({query:async()=>{throw new Error('super-secret-PG-password');}});
    await assert.rejects(box.append(sample(22)),
      e=>e.code==='INBOX_DATABASE_UNAVAILABLE'&&!e.message.includes('password'));
    await assert.rejects(box.ack(22,'bad'),e=>e.code==='INBOX_LEASE_INVALID');
  });
});

describe('F05b PostgreSQL 18 encrypted inbox / lease fencing',{
  skip: !process.env.F05_POSTGRES_URL,
},()=>{
  let pool,inbox;
  before(async()=>{
    const {Pool}=require('pg');
    pool=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:20,connectionTimeoutMillis:5000});
    const script=fs.readFileSync(path.join(__dirname,'..','sql','f05b_telegram_durable_inbox.sql'),'utf8');
    await pool.query(script);
    inbox=create(pool);
  });
  after(async()=>{if(pool)await pool.end();});

  it('persists only AES-GCM encrypted payload, supports restart and exact retry',async()=>{
    const update=sample(id(),'sensitive-telegram-message-not-plaintext');
    assert.deepEqual(await inbox.append(update),{inserted:true,updateId:update.update_id});
    assert.deepEqual(await create(pool).append({
      message:{text:'sensitive-telegram-message-not-plaintext',
        date:1761670000,chat:{type:'private',id:123},
        from:{first_name:'Fixture',is_bot:false,id:123},message_id:3},
      update_id:update.update_id,
    }),{inserted:false,updateId:update.update_id});
    const stored=await pool.query(
      'SELECT ciphertext, iv, tag, digest FROM kashbit_telegram_inbox WHERE update_id=$1',
      [update.update_id]);
    assert.equal(stored.rows.length,1);
    assert.equal(stored.rows[0].iv.length,12);
    assert.equal(stored.rows[0].tag.length,16);
    assert.ok(!stored.rows[0].ciphertext.toString('utf8').includes('sensitive-telegram'));
    assert.equal((await inbox.maxPersistedId())>=update.update_id,true);
    const claim=await create(pool).claim();
    assert.equal(claim.updateId,update.update_id);
    assert.deepEqual(claim.update,update);
    assert.equal(await inbox.ack(claim.updateId,claim.leaseId),true);
    assert.equal(await inbox.ack(claim.updateId,claim.leaseId),false);
  });

  it('rejects duplicate update_id carrying a different telegram event',async()=>{
    const update=sample(id());
    await inbox.append(update);
    await assert.rejects(inbox.append(sample(update.update_id,'attacker-overwrite')),
      e=>e.code==='INBOX_IDENTITY_CONFLICT');
    const state=await pool.query('SELECT state FROM kashbit_telegram_inbox WHERE update_id=$1',
      [update.update_id]);
    assert.equal(state.rows[0].state,'PENDING');
  });

  it('enforces single ordered lease, not two concurrent handlers',async()=>{
    const first=sample(id()),second=sample(first.update_id+1);
    await inbox.append(first);
    await inbox.append(second);
    const [a,b]=await Promise.all([inbox.claim(),create(pool).claim()]);
    const active=[a,b].filter(Boolean);
    assert.equal(active.length,1);
    assert.equal(active[0].updateId,first.update_id);
    assert.equal(await inbox.ack(active[0].updateId,active[0].leaseId),true);
    const next=await create(pool).claim();
    assert.equal(next.updateId,second.update_id);
    assert.equal(await inbox.ack(next.updateId,next.leaseId),true);
  });

  it('reclaims expired lease with new token and fences stale ack',async()=>{
    const u=sample(id());
    await inbox.append(u);
    const claim1=await inbox.claim({leaseSeconds:1});
    assert.equal(claim1.updateId,u.update_id);
    await pool.query("UPDATE kashbit_telegram_inbox SET leased_until=now()-interval '1 second' WHERE update_id=$1",[u.update_id]);
    const claim2=await create(pool).claim({leaseSeconds:30});
    assert.equal(claim2.updateId,u.update_id);
    assert.notEqual(claim1.leaseId,claim2.leaseId);
    assert.equal(await inbox.ack(claim1.updateId,claim1.leaseId),false);
    assert.equal(await inbox.ack(claim2.updateId,claim2.leaseId),true);
    assert.equal(await inbox.claim(),null);
  });

  it('quarantines tampered encrypted payload and never delivers its contents',async()=>{
    const u=sample(id(),'sensitive-content');
    await inbox.append(u);
    await pool.query('UPDATE kashbit_telegram_inbox SET ciphertext=$2 WHERE update_id=$1',
      [u.update_id,Buffer.from('tampered-ciphertext')]);
    await assert.rejects(inbox.claim(),e=>e.code==='INBOX_PAYLOAD_UNTRUSTED');
    const s=await pool.query('SELECT state, lease_id FROM kashbit_telegram_inbox WHERE update_id=$1',[u.update_id]);
    assert.equal(s.rows[0].state,'QUARANTINED');
    assert.equal(s.rows[0].lease_id,null);
  });

  it('rejects release by stale lease and allows retry with a new lease',async()=>{
    const u=sample(id());
    await inbox.append(u);
    const c=await inbox.claim();
    assert.equal(c.updateId,u.update_id);
    assert.equal(await inbox.release(u.update_id,randomUUID()),false);
    assert.equal(await inbox.release(u.update_id,c.leaseId),true);
    const r=await create(pool).claim();
    assert.equal(r.updateId,u.update_id);
    assert.equal(r.attempts,2);
    assert.equal(await inbox.ack(r.updateId,r.leaseId),true);
  });
});
