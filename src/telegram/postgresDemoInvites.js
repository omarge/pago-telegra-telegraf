'use strict';

const crypto = require('node:crypto');

class DemoInviteError extends Error {
  constructor(code) { super(code); this.name='DemoInviteError'; this.code=code; }
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^ki_[A-Za-z0-9_-]{43}$/;
function int(v,zero=false) {return Number.isSafeInteger(v) && (zero?v>=0:v>0);}
function validateClaim(input) {
  if (!input || !int(input.updateId,true) || !UUID.test(input.inboxLeaseId||'')) {
    throw new DemoInviteError('DEMO_INVITE_INPUT_INVALID');
  }
}
function validateAmount(n) {
  if(!int(n) || n>100000000) throw new DemoInviteError('DEMO_INVITE_INPUT_INVALID');
}
function material(key,updateId,requesterId,amountCents) {
  return 'ki_'+crypto.createHmac('sha256',key)
    .update('demo-invite-v1:'+updateId+':'+requesterId+':'+amountCents)
    .digest('base64url');
}
function digestToken(key,token) {
  return crypto.createHmac('sha256',key).update('demo-lookup-v1:'+token).digest('hex');
}

class PostgresDemoInviteAuthority {
  constructor({enabled=false,pool,tokenKeyHex}={}) {
    this.enabled=enabled===true;
    if (!this.enabled) return;
    if(!pool || typeof pool.connect!=='function' ||
       typeof tokenKeyHex!=='string' || !/^[0-9a-f]{64}$/i.test(tokenKeyHex)) {
      throw new DemoInviteError('DEMO_INVITE_NOT_CONFIGURED');
    }
    this.pool=pool;
    this.key=Buffer.from(tokenKeyHex,'hex');
  }
  guard() {if(!this.enabled) throw new DemoInviteError('DEMO_INVITE_DISABLED');}
  async inTransaction(work) {
    this.guard();
    let client;
    try {
      client=await this.pool.connect();
      await client.query('BEGIN');
      const result=await work(client);
      await client.query('COMMIT');
      return result;
    } catch(e) {
      if(client) {try {await client.query('ROLLBACK');}catch(_){}}
      if(e instanceof DemoInviteError)throw e;
      // Do not disclose any SQL, tokens, Telegram user PII or credentials.
      throw new DemoInviteError('DEMO_INVITE_DATABASE_UNAVAILABLE');
    } finally {
      if(client) client.release();
    }
  }
  async assertLiveInbox(client,updateId,leaseId) {
    const row=await client.query(
      'SELECT update_id FROM kashbit_telegram_inbox '+
      "WHERE update_id=$1 AND lease_id=$2::uuid AND state='PROCESSING' "+
      'AND leased_until>now() FOR UPDATE',[updateId,leaseId]);
    if(row.rows.length!==1)throw new DemoInviteError('DEMO_INBOX_AUTHORITY_LOST');
  }

  async createForClaim({updateId,inboxLeaseId,requesterTelegramId,amountCents}={}) {
    this.guard();
    validateClaim({updateId,inboxLeaseId});
    if(!int(requesterTelegramId) || !int(updateId,true)) {
      throw new DemoInviteError('DEMO_INVITE_INPUT_INVALID');
    }
    validateAmount(amountCents);
    const token=material(this.key,updateId,requesterTelegramId,amountCents);
    const digest=digestToken(this.key,token);
    return this.inTransaction(async client=>{
      await this.assertLiveInbox(client,updateId,inboxLeaseId);
      const uuid=crypto.randomUUID();
      const inserted=await client.query(
        'INSERT INTO kashbit_telegram_demo_invites '+
        '(invite_id,source_update_id,token_digest,requester_telegram_id,amount_cents) '+
        'VALUES ($1::uuid,$2,$3,$4,$5) ON CONFLICT DO NOTHING '+
        'RETURNING invite_id,source_update_id,token_digest,requester_telegram_id,amount_cents,expires_at',
        [uuid,updateId,digest,requesterTelegramId,amountCents]);
      const row=inserted.rows[0] || (await client.query(
        'SELECT invite_id,source_update_id,token_digest,requester_telegram_id,amount_cents,expires_at '+
        'FROM kashbit_telegram_demo_invites WHERE source_update_id=$1',
        [updateId])).rows[0];
      if(!row || row.token_digest!==digest ||
         Number(row.requester_telegram_id)!==requesterTelegramId ||
         Number(row.amount_cents)!==amountCents) {
        throw new DemoInviteError('DEMO_INVITE_CONFLICT');
      }
      return Object.freeze({
        demoInviteId:row.invite_id,
        token,
        requesterTelegramId,
        amountCents,
        expiresAt:new Date(row.expires_at).toISOString(),
        created:inserted.rows.length===1,
        status:'DEMO_INVITE_ONLY_NO_PAYMENT',
      });
    });
  }

  async authorizeLinkDelivery({sourceUpdateId,requesterTelegramId,token}={}) {
    this.guard();
    if(!int(sourceUpdateId,true) || !int(requesterTelegramId) ||
       typeof token!=='string' || !TOKEN.test(token)) {
      throw new DemoInviteError('DEMO_INVITE_INPUT_INVALID');
    }
    const digest=digestToken(this.key,token);
    // Recheck the owner, live expiry and absence of redemption immediately
    // before a one-shot Telegram send. The redeem operation validates expiry
    // again independently even if this read races the delivery.
    return this.inTransaction(async client=>{
      const r=await client.query(
        'SELECT i.invite_id FROM kashbit_telegram_demo_invites AS i '+
        'WHERE i.source_update_id=$1 AND i.requester_telegram_id=$2 '+
        'AND i.token_digest=$3 AND i.expires_at>now() AND NOT EXISTS '+
        '(SELECT 1 FROM kashbit_telegram_demo_claims AS c '+
        'WHERE c.invite_id=i.invite_id)',
        [sourceUpdateId,requesterTelegramId,digest]);
      if(r.rows.length!==1)throw new DemoInviteError('DEMO_LINK_NOT_AUTHORIZED');
      return true;
    });
  }

  async redeemForClaim({updateId,inboxLeaseId,payerTelegramId,token}={}) {
    this.guard();
    validateClaim({updateId,inboxLeaseId});
    if(!int(payerTelegramId) || typeof token!=='string' ||
       !TOKEN.test(token))throw new DemoInviteError('DEMO_INVITE_INPUT_INVALID');
    const digest=digestToken(this.key,token);
    return this.inTransaction(async client=>{
      await this.assertLiveInbox(client,updateId,inboxLeaseId);
      const invite=(await client.query(
        'SELECT invite_id,requester_telegram_id,amount_cents,expires_at, (expires_at > now()) AS still_valid '+
        'FROM kashbit_telegram_demo_invites WHERE token_digest=$1 FOR UPDATE',
        [digest])).rows[0];
      if(!invite) throw new DemoInviteError('DEMO_INVITE_NOT_FOUND');
      if(Number(invite.requester_telegram_id)===payerTelegramId) {
        throw new DemoInviteError('DEMO_SELF_REDEMPTION_DENIED');
      }
      const existing=(await client.query(
        'SELECT redemption_update_id,payer_telegram_id FROM kashbit_telegram_demo_claims '+
        'WHERE invite_id=$1::uuid',[invite.invite_id])).rows[0];
      if(existing) {
        if(Number(existing.redemption_update_id)!==updateId ||
           Number(existing.payer_telegram_id)!==payerTelegramId) {
          throw new DemoInviteError('DEMO_INVITE_ALREADY_CLAIMED');
        }
        return Object.freeze({
          demoInviteId:invite.invite_id,
          payerTelegramId,amountCents:Number(invite.amount_cents),
          created:false,status:'DEMO_REDEEMED_NO_PAYMENT',
        });
      }
      if(invite.still_valid !== true) {
        throw new DemoInviteError('DEMO_INVITE_EXPIRED');
      }
      // Lock of the parent invite serializes rival redeemers.
      const added=await client.query(
        'INSERT INTO kashbit_telegram_demo_claims '+
        '(invite_id,redemption_update_id,payer_telegram_id) '+
        'VALUES ($1::uuid,$2,$3) ON CONFLICT DO NOTHING RETURNING invite_id',
        [invite.invite_id,updateId,payerTelegramId]);
      if(added.rows.length!==1) {
        throw new DemoInviteError('DEMO_INVITE_ALREADY_CLAIMED');
      }
      return Object.freeze({
        demoInviteId:invite.invite_id,
        payerTelegramId,amountCents:Number(invite.amount_cents),
        created:true,status:'DEMO_REDEEMED_NO_PAYMENT',
      });
    });
  }
}
module.exports={PostgresDemoInviteAuthority,DemoInviteError};
