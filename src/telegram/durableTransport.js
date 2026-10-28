'use strict';

// F05c, experimental UAT-only transport. Telegram update acknowledgement
// occurs AFTER a durable encrypted PostgreSQL insert. Worker delivery is
// at-least-once; neither Telegram outbound effects nor BusinessOS money
// transactions are exactly-once without a separately certified outbox.
const POLLER_LOCK = [1214998087, 5005];

class DurableTransportError extends Error {
  constructor(code) { super(code); this.name='DurableTransportError'; this.code=code; }
}
function validOffset(id) {return Number.isSafeInteger(id) && id >= 0;}

async function acquirePollerOwner(pool) {
  if (!pool || typeof pool.connect !== 'function')
    throw new DurableTransportError('POLLER_DB_NOT_CONFIGURED');
  let client,locked=false;
  try {
    client=await pool.connect();
    const response=await client.query('SELECT pg_try_advisory_lock($1,$2) AS acquired',POLLER_LOCK);
    locked=response.rows[0]?.acquired === true;
    if (!locked) throw new DurableTransportError('POLLER_ALREADY_ACTIVE');
    return {
      async verify() {
        try {await client.query('SELECT 1');}
        catch (_) {throw new DurableTransportError('POLLER_OWNERSHIP_UNAVAILABLE');}
      },
      async release() {
        try {
          if(locked) await client.query('SELECT pg_advisory_unlock($1,$2)',POLLER_LOCK);
        } finally {
          locked=false;
          client.release();
        }
      },
    };
  } catch(e) {
    if(client) client.release(true);
    if(e instanceof DurableTransportError) throw e;
    throw new DurableTransportError('POLLER_OWNERSHIP_UNAVAILABLE');
  }
}

class DurableTelegramTransport {
  constructor({inbox,getUpdates,handleUpdate,leaseSeconds=90,heartbeatMs=12000}={}) {
    if(!inbox || typeof inbox.append!=='function' ||
       typeof inbox.maxPersistedId!=='function' ||
       typeof inbox.claim!=='function' || typeof inbox.ack!=='function' ||
       typeof inbox.release!=='function' || typeof inbox.renew!=='function' ||
       typeof getUpdates!=='function' || typeof handleUpdate!=='function' ||
       !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 6 || leaseSeconds > 300 ||
       !Number.isSafeInteger(heartbeatMs) || heartbeatMs<100 ||
       heartbeatMs >= leaseSeconds*500) {
      throw new DurableTransportError('DURABLE_TRANSPORT_NOT_CONFIGURED');
    }
    this.inbox=inbox;
    this.getUpdates=getUpdates;
    this.handleUpdate=handleUpdate;
    this.leaseSeconds=leaseSeconds;
    this.heartbeatMs=heartbeatMs;
    this.offset=null;
  }

  async initialize() {
    const max=await this.inbox.maxPersistedId();
    if(max!==null && (!validOffset(max) || max === Number.MAX_SAFE_INTEGER)) {
      throw new DurableTransportError('INBOX_OFFSET_INVALID');
    }
    this.offset=max===null?0:max+1;
    return this.offset;
  }

  async pollOnce() {
    if(this.offset===null) await this.initialize();
    const requested=this.offset;
    const response=await this.getUpdates(requested);
    if(!response || response.ok!==true || !Array.isArray(response.result)) {
      throw new DurableTransportError('TELEGRAM_POLL_UNTRUSTED');
    }
    // Validate entire response before any durable writes.
    let previous=requested-1;
    for(const update of response.result) {
      if(!update || !validOffset(update.update_id) ||
          update.update_id<requested || update.update_id<=previous ||
          update.update_id===Number.MAX_SAFE_INTEGER) {
        throw new DurableTransportError('TELEGRAM_POLL_UNTRUSTED');
      }
      previous=update.update_id;
    }
    for(const update of response.result) {
      // Never advance Telegram's offset on an incomplete/failed DB commit.
      await this.inbox.append(update);
      this.offset=update.update_id+1;
    }
    return response.result.length;
  }

  async deliverOnce() {
    const claimed=await this.inbox.claim({leaseSeconds:this.leaseSeconds});
    if(!claimed) return false;
    let heartbeatFailure=null;
    let heartbeat=Promise.resolve();
    let busy=false;
    const tick=()=>{
      if(busy || heartbeatFailure) return;
      busy=true;
      heartbeat=Promise.resolve()
        .then(()=>this.inbox.renew(claimed.updateId,claimed.leaseId,this.leaseSeconds))
        .then(ok=>{if(!ok)heartbeatFailure=new DurableTransportError('INBOX_LEASE_LOST');})
        .catch(()=>{heartbeatFailure=new DurableTransportError('INBOX_LEASE_LOST');})
        .finally(()=>{busy=false;});
    };
    const timer=setInterval(tick,this.heartbeatMs);
    let handlerFailed=false;
    try {
      try {await this.handleUpdate(claimed.update, Object.freeze({
        updateId: claimed.updateId, inboxLeaseId: claimed.leaseId,
      }));}
      catch (_) {handlerFailed=true;}
      // The handler may complete after a lost lease. Never acknowledge it.
      clearInterval(timer);
      await heartbeat;
      if(heartbeatFailure) throw heartbeatFailure;
      if(handlerFailed) {
        const released=await this.inbox.release(claimed.updateId,claimed.leaseId);
        if(!released) throw new DurableTransportError('INBOX_LEASE_LOST');
        throw new DurableTransportError('TELEGRAM_HANDLER_FAILED');
      }
      const acknowledged=await this.inbox.ack(claimed.updateId,claimed.leaseId);
      if(!acknowledged) throw new DurableTransportError('INBOX_LEASE_LOST');
      return true;
    } finally {
      clearInterval(timer);
    }
  }
}

async function sleep(ms,signal) {
  if(signal?.aborted) return;
  await new Promise(resolve=>{
    const timer=setTimeout(done,ms);
    function done(){if(signal)signal.removeEventListener('abort',done);clearTimeout(timer);resolve();}
    if(signal)signal.addEventListener('abort',done,{once:true});
  });
}

async function runDurableTelegram({pool,inbox,getUpdates,handleUpdate,signal}={}) {
  const owner=await acquirePollerOwner(pool);
  const localAbort=new AbortController();
  const stop=()=>localAbort.abort();
  if(signal)signal.addEventListener('abort',stop,{once:true});
  if(signal?.aborted)stop();
  const transport=new DurableTelegramTransport({inbox,getUpdates,handleUpdate});
  try {
    await transport.initialize();
    async function poll() {
      while(!localAbort.signal.aborted) {
        // If the advisory-lock session is gone, do not poll Telegram further.
        await owner.verify();
        const count=await transport.pollOnce();
        if(!count) await sleep(250,localAbort.signal);
      }
    }
    async function worker() {
      while(!localAbort.signal.aborted) {
        const delivered=await transport.deliverOnce();
        if(!delivered) await sleep(250,localAbort.signal);
      }
    }
    const results=await Promise.allSettled([poll().catch(e=>{stop();throw e;}),
      worker().catch(e=>{stop();throw e;})]);
    const failure=results.find(x=>x.status==='rejected');
    if(failure)throw failure.reason;
  } finally {
    stop();
    if(signal)signal.removeEventListener('abort',stop);
    await owner.release();
  }
}

module.exports={DurableTelegramTransport,DurableTransportError,acquirePollerOwner,runDurableTelegram};
