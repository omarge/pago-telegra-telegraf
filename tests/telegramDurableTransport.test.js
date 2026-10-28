'use strict';

const {describe,it,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,randomBytes}=require('node:crypto');
const {PostgresTelegramInbox}=require('../src/telegram/postgresInbox');
const {DurableTelegramTransport,acquirePollerOwner,runDurableTelegram}=require('../src/telegram/durableTransport');

const KEY=randomBytes(32).toString('hex');
const sample=(id,label='hello')=>({
  update_id:id,message:{message_id:id,from:{id:101,is_bot:false,first_name:'Fixture'},
    chat:{id:101,type:'private'},date:1761680000,text:label},
});
const makeInbox=pool=>new PostgresTelegramInbox({enabled:true,pool,encryptionKeyHex:KEY});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

describe('F05c durable transport input safety and ordering',()=>{
  it('will not advance local Telegram offset unless every update was durably appended',async()=>{
    let appended=[];
    const transport=new DurableTelegramTransport({
      inbox:{
        maxPersistedId:async()=>null,
        append:async u=>{if(u.update_id===21)throw new Error('DB lost');
          appended.push(u.update_id);},
        claim:async()=>null,ack:async()=>true,release:async()=>true,renew:async()=>true,
      },
      getUpdates:async offset=>{
        assert.equal(offset,0);
        return {ok:true,result:[sample(20),sample(21),sample(22)]};
      },
      handleUpdate:async()=>{},
    });
    await assert.rejects(transport.pollOnce(),/DB lost/);
    assert.deepEqual(appended,[20]);
    assert.equal(transport.offset,21);
  });

  it('rejects malformed/unsorted Telegram responses BEFORE any DB writes',async()=>{
    let calls=0;
    const transport=new DurableTelegramTransport({
      inbox:{
        maxPersistedId:async()=>null,
        append:async()=>{calls++;},
        claim:async()=>null,ack:async()=>true,release:async()=>true,renew:async()=>true,
      },
      getUpdates:async()=>({ok:true,result:[sample(30),sample(29)]}),
      handleUpdate:async()=>{},
    });
    await assert.rejects(transport.pollOnce(),e=>e.code==='TELEGRAM_POLL_UNTRUSTED');
    assert.equal(calls,0);
    assert.equal(transport.offset,0);
  });

  it('does not acknowledge errors from the actual handler and releases the lease',async()=>{
    let acknowledgements=0,releases=0;
    const transport=new DurableTelegramTransport({
      inbox:{
        maxPersistedId:async()=>null,append:async()=>{},
        claim:async()=>({updateId:12,leaseId:randomUUID(),update:sample(12)}),
        ack:async()=>{acknowledgements++;return true;},
        release:async()=>{releases++;return true;},
        renew:async()=>true,
      },getUpdates:async()=>({ok:true,result:[]}),
      handleUpdate:async()=>{throw new Error('secret-containing-runtime-error');},
    });
    await assert.rejects(transport.deliverOnce(),
      e=>e.code==='TELEGRAM_HANDLER_FAILED'&&!e.message.includes('secret'));
    assert.equal(acknowledgements,0);
    assert.equal(releases,1);
  });

  it('renews lease during slow handler and fails closed if heartbeat loses ownership',async()=>{
    let renews=0,ack=0;
    const transport=new DurableTelegramTransport({
      inbox:{
        maxPersistedId:async()=>null,append:async()=>{},
        claim:async()=>({updateId:13,leaseId:randomUUID(),update:sample(13)}),
        ack:async()=>{ack++;return true;},
        release:async()=>true,
        renew:async()=>{renews++;return false;},
      },getUpdates:async()=>({ok:true,result:[]}),
      handleUpdate:async()=>wait(250),leaseSeconds:6,heartbeatMs:100,
    });
    await assert.rejects(transport.deliverOnce(),e=>e.code==='INBOX_LEASE_LOST');
    assert.ok(renews>=1);
    assert.equal(ack,0);
  });
});

describe('F05c PostgreSQL 18 durable Telegram ingress/worker certification',{
  skip:!process.env.F05_POSTGRES_URL,
},()=>{
  let admin,pool,schema,inbox;
  before(async()=>{
    const {Pool}=require('pg');
    admin=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:2});
    schema='f05c_'+randomUUID().replaceAll('-','');
    await admin.query('CREATE SCHEMA "'+schema+'"');
    // Dedicated search_path prevents concurrent GitHub node:test workers
    // from TRUNCATE-ing each other's inbox tables.
    pool=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:15,
      options:'-c search_path='+schema,connectionTimeoutMillis:5000});
    const migration=fs.readFileSync(path.join(__dirname,'..','sql','f05b_telegram_durable_inbox.sql'),'utf8');
    await pool.query(migration);
    inbox=makeInbox(pool);
  });
  after(async()=>{
    if(pool)await pool.end();
    if(admin){
      if(schema)await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
      await admin.end();
    }
  });

  it('persist-before-ack survives restart; duplicate Telegram replay stays single',async()=>{
    let batches=0,seen=[];
    const transport=new DurableTelegramTransport({
      inbox,getUpdates:async offset=>{
        batches++;
        assert.equal(offset,0);
        return {ok:true,result:[sample(1001,'first'),sample(1002,'second')]};
      },
      handleUpdate:async u=>seen.push(u.update_id),
    });
    assert.equal(await transport.initialize(),0);
    assert.equal(await transport.pollOnce(),2);
    assert.equal(transport.offset,1003);
    assert.deepEqual(seen,[]);
    const restarted=new DurableTelegramTransport({
      inbox:makeInbox(pool),
      getUpdates:async offset=>{assert.equal(offset,1003);return {ok:true,result:[]};},
      handleUpdate:async u=>{seen.push(u.update_id);},
    });
    assert.equal(await restarted.initialize(),1003);
    assert.equal(await restarted.pollOnce(),0);
    assert.equal(await restarted.deliverOnce(),true);
    assert.equal(await restarted.deliverOnce(),true);
    assert.equal(await restarted.deliverOnce(),false);
    assert.deepEqual(seen,[1001,1002]);
    assert.equal(batches,1);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM kashbit_telegram_inbox')).rows[0].n,2);
    assert.deepEqual(await inbox.append(sample(1002,'second')),{inserted:false,updateId:1002});
  });

  it('fences a second simultaneous Telegram poller at the DB session level',async()=>{
    const first=await acquirePollerOwner(pool);
    try{
      await first.verify();
      await assert.rejects(acquirePollerOwner(pool),
        e=>e.code==='POLLER_ALREADY_ACTIVE');
    }finally{await first.release();}
    const second=await acquirePollerOwner(pool);
    await second.verify();
    await second.release();
  });

  it('handler crash releases inbox item; after restart worker retries, never pretends exactly-once',async()=>{
    await pool.query('TRUNCATE kashbit_telegram_inbox');
    await inbox.append(sample(2001,'retry'));
    const first=new DurableTelegramTransport({
      inbox,getUpdates:async()=>({ok:true,result:[]}),
      handleUpdate:async()=>{throw Error('injected failure');},
    });
    await assert.rejects(first.deliverOnce(),e=>e.code==='TELEGRAM_HANDLER_FAILED');
    const state1=(await pool.query('SELECT state,attempts FROM kashbit_telegram_inbox WHERE update_id=2001')).rows[0];
    assert.equal(state1.state,'PENDING');
    assert.equal(state1.attempts,1);
    const seen=[];
    const next=new DurableTelegramTransport({
      inbox:makeInbox(pool),getUpdates:async()=>({ok:true,result:[]}),
      handleUpdate:async u=>seen.push(u.update_id),
    });
    assert.equal(await next.deliverOnce(),true);
    assert.deepEqual(seen,[2001]);
    assert.equal((await pool.query('SELECT state,attempts FROM kashbit_telegram_inbox WHERE update_id=2001')).rows[0].state,'DONE');
    assert.equal((await pool.query('SELECT attempts FROM kashbit_telegram_inbox WHERE update_id=2001')).rows[0].attempts,2);
  });

  it('renews a live lease and rejects an expired previous owner',async()=>{
    await pool.query('TRUNCATE kashbit_telegram_inbox');
    await inbox.append(sample(3001));
    const claim=await inbox.claim({leaseSeconds:6});
    assert.equal(await inbox.renew(claim.updateId,claim.leaseId,90),true);
    assert.equal(await inbox.renew(claim.updateId,randomUUID(),90),false);
    assert.equal(await inbox.ack(claim.updateId,claim.leaseId),true);
    assert.equal(await inbox.renew(claim.updateId,claim.leaseId,90),false);
  });

  it('quarantines exhausted crashed work and unblocks later update without dispatch',async()=>{
    await pool.query('TRUNCATE kashbit_telegram_inbox');
    await inbox.append(sample(4001,'exhausted'));
    await inbox.append(sample(4002,'later'));
    await pool.query(
      "UPDATE kashbit_telegram_inbox SET state='PROCESSING', attempts=12, " +
      "lease_id=$2::uuid, leased_until=now()-interval '5 seconds' WHERE update_id=$1",
      [4001,randomUUID()]);
    const claim=await inbox.claim({leaseSeconds:30});
    assert.equal(claim.updateId,4002);
    const exhausted=(await pool.query('SELECT state FROM kashbit_telegram_inbox WHERE update_id=4001')).rows[0];
    assert.equal(exhausted.state,'QUARANTINED');
    assert.equal(await inbox.ack(claim.updateId,claim.leaseId),true);
  });
  it('stops gracefully, drains worker and releases the poller owner',async()=>{
    await pool.query('TRUNCATE kashbit_telegram_inbox');
    const stop=new AbortController();
    let received=0,polls=0;
    const running=runDurableTelegram({
      pool,inbox,signal:stop.signal,
      getUpdates:async()=>{polls++;return {ok:true,result:[]};},
      handleUpdate:async()=>{received++;},
    });
    await wait(170);
    stop.abort();
    await running;
    assert.ok(polls>=1);
    assert.equal(received,0);
    const next=await acquirePollerOwner(pool);
    await next.verify();
    await next.release();
  });

  it('does not poll when shutdown was requested before initialization',async()=>{
    await pool.query('TRUNCATE kashbit_telegram_inbox');
    const stop=new AbortController();
    stop.abort();
    let polls=0;
    await runDurableTelegram({
      pool,inbox,signal:stop.signal,
      getUpdates:async()=>{polls++;return {ok:true,result:[]};},
      handleUpdate:async()=>{},
    });
    assert.equal(polls,0);
    const next=await acquirePollerOwner(pool);
    await next.release();
  });

});
