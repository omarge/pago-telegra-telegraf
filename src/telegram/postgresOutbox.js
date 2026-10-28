'use strict';

const crypto = require('node:crypto');

// F05d: intentionally NOT connected to src/bot.js or production transport.
// Telegram sendMessage has no caller-supplied idempotency key; after any
// uncertain outcome the message MUST NOT be automatically sent again.

class TelegramOutboxError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TelegramOutboxError';
    this.code = code;
  }
}

const LEASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION = /^[a-zA-Z][a-zA-Z0-9_-]{0,95}$/;
const ID_COLS = 'update_id, action_key, state, digest';

function validUpdateId(id) { return Number.isSafeInteger(id) && id >= 0; }
function requireAction(actionKey) {
  if (!ACTION.test(actionKey || '')) throw new TelegramOutboxError('OUTBOX_INPUT_INVALID');
}
function requireLease(leaseId) {
  if (typeof leaseId !== 'string' || !LEASE.test(leaseId)) {
    throw new TelegramOutboxError('OUTBOX_INPUT_INVALID');
  }
}
function encodeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      !Number.isSafeInteger(message.chatId) || message.chatId === 0 ||
      typeof message.text !== 'string' ||
      !message.text.trim() || [...message.text].length > 4096 ||
      Buffer.byteLength(message.text, 'utf8') > 16384) {
    throw new TelegramOutboxError('OUTBOX_INPUT_INVALID');
  }
  // Strict allowlist: no unsanitized parse_mode, user-defined HTML, PAN or CVV.
  return JSON.stringify({ chatId: message.chatId, text: message.text });
}

class PostgresTelegramOutbox {
  constructor({enabled = false, pool, encryptionKeyHex} = {}) {
    this.enabled = enabled === true;
    if (!this.enabled) return;
    if (!pool || typeof pool.query !== 'function' ||
        typeof pool.connect !== 'function' ||
        typeof encryptionKeyHex !== 'string' ||
        !/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
      throw new TelegramOutboxError('OUTBOX_NOT_CONFIGURED');
    }
    this.pool = pool;
    this.key = Buffer.from(encryptionKeyHex, 'hex');
  }

  guard() {
    if (!this.enabled) throw new TelegramOutboxError('OUTBOX_DISABLED');
  }

  async query(sql, args) {
    try { return await this.pool.query(sql, args); }
    catch (_) { throw new TelegramOutboxError('OUTBOX_DATABASE_UNAVAILABLE'); }
  }

  async enqueueForClaim({updateId, inboxLeaseId, actionKey, message} = {}) {
    this.guard();
    if (!validUpdateId(updateId)) throw new TelegramOutboxError('OUTBOX_INPUT_INVALID');
    requireLease(inboxLeaseId);
    requireAction(actionKey);
    const plaintext = encodeMessage(message);
    const digest = crypto.createHmac('sha256', this.key)
      .update(plaintext, 'utf8').digest('hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('tg-outbox:' + updateId + ':' + actionKey));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    let client;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      // Bind intent to a live, fenced inbox handler before committing.
      const claim = await client.query(
        "SELECT update_id FROM kashbit_telegram_inbox WHERE update_id=$1 " +
        "AND state='PROCESSING' AND lease_id=$2::uuid AND leased_until>now() FOR UPDATE",
        [updateId, inboxLeaseId]
      );
      if (claim.rows.length !== 1) {
        throw new TelegramOutboxError('OUTBOX_INBOX_AUTHORITY_LOST');
      }
      const added = await client.query(
        'INSERT INTO kashbit_telegram_outbox ' +
        '(update_id,action_key,digest,iv,tag,ciphertext) ' +
        'VALUES ($1,$2,$3,$4,$5,$6) ' +
        'ON CONFLICT (update_id,action_key) DO NOTHING RETURNING ' + ID_COLS,
        [updateId,actionKey,digest,iv,tag,ciphertext]
      );
      const existing = added.rows.length === 1 ? added.rows[0] :
        (await client.query(
          'SELECT ' + ID_COLS +
          ' FROM kashbit_telegram_outbox WHERE update_id=$1 AND action_key=$2',
          [updateId,actionKey]
        )).rows[0];
      if (!existing || existing.digest !== digest) {
        throw new TelegramOutboxError('OUTBOX_IDENTITY_CONFLICT');
      }
      await client.query('COMMIT');
      return Object.freeze({
        inserted: added.rows.length === 1,
        updateId, actionKey, status: existing.state,
      });
    } catch (e) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      if (e instanceof TelegramOutboxError) throw e;
      throw new TelegramOutboxError('OUTBOX_DATABASE_UNAVAILABLE');
    } finally {
      if (client) client.release();
    }
  }

  async claimForSend() {
    this.guard();
    const dispatchId = crypto.randomUUID();
    const r = await this.query(
      'WITH chosen AS (SELECT update_id,action_key FROM kashbit_telegram_outbox ' +
      "WHERE state='READY' ORDER BY update_id,action_key " +
      'LIMIT 1 FOR UPDATE SKIP LOCKED) ' +
      'UPDATE kashbit_telegram_outbox AS o SET ' +
      "state='IN_FLIGHT', attempts=1, dispatch_id=$1::uuid, started_at=now() " +
      'FROM chosen AS c WHERE o.update_id=c.update_id AND o.action_key=c.action_key ' +
      'RETURNING o.update_id,o.action_key,o.iv,o.tag,o.ciphertext,o.dispatch_id',
      [dispatchId]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const updateId = Number(row.update_id), actionKey = row.action_key;
    try {
      if (!validUpdateId(updateId)) throw Error('untrusted id');
      const decipher = crypto.createDecipheriv('aes-256-gcm',this.key,row.iv);
      decipher.setAAD(Buffer.from('tg-outbox:' + updateId + ':' + actionKey));
      decipher.setAuthTag(row.tag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext),decipher.final()]);
      const parsed = JSON.parse(plaintext.toString('utf8'));
      encodeMessage(parsed);
      return Object.freeze({
        updateId, actionKey, dispatchId, message: Object.freeze(parsed),
      });
    } catch (_) {
      // An unintelligible encrypted message is never sent.
      await this.finishUnknown(updateId,actionKey,dispatchId);
      throw new TelegramOutboxError('OUTBOX_PAYLOAD_UNTRUSTED');
    }
  }

  async markSent(claim, response) {
    this.guard();
    if (!claim || !validUpdateId(claim.updateId)) {
      throw new TelegramOutboxError('OUTBOX_INPUT_INVALID');
    }
    requireAction(claim.actionKey);
    requireLease(claim.dispatchId);
    if (!response || !Number.isSafeInteger(response.message_id) ||
        response.message_id <= 0 || !response.chat ||
        response.chat.id !== claim.message.chatId) {
      throw new TelegramOutboxError('OUTBOX_DELIVERY_UNKNOWN');
    }
    const r = await this.query(
      "UPDATE kashbit_telegram_outbox SET state='SENT', " +
      'telegram_message_id=$4, finished_at=now() ' +
      "WHERE update_id=$1 AND action_key=$2 AND dispatch_id=$3::uuid " +
      "AND state='IN_FLIGHT' RETURNING update_id",
      [claim.updateId,claim.actionKey,claim.dispatchId,response.message_id]
    );
    if (r.rows.length !== 1) throw new TelegramOutboxError('OUTBOX_DELIVERY_UNKNOWN');
    return Object.freeze({
      status:'SENT',updateId:claim.updateId,actionKey:claim.actionKey,
      telegramMessageId:response.message_id,
    });
  }

  async finishUnknown(updateId,actionKey,dispatchId) {
    this.guard();
    if (!validUpdateId(updateId)) throw new TelegramOutboxError('OUTBOX_INPUT_INVALID');
    requireAction(actionKey);
    requireLease(dispatchId);
    const r = await this.query(
      "UPDATE kashbit_telegram_outbox SET state='UNKNOWN', finished_at=now() " +
      "WHERE update_id=$1 AND action_key=$2 AND dispatch_id=$3::uuid " +
      "AND state='IN_FLIGHT' RETURNING update_id",
      [updateId,actionKey,dispatchId]
    );
    return r.rows.length===1;
  }

  // An explicit ops action; never invoked automatically to retry/re-send.
  async sealStaleAsUnknown({minAgeSeconds=600}={}) {
    this.guard();
    if (!Number.isSafeInteger(minAgeSeconds) ||
        minAgeSeconds < 60 || minAgeSeconds > 86400) {
      throw new TelegramOutboxError('OUTBOX_INPUT_INVALID');
    }
    const r = await this.query(
      "UPDATE kashbit_telegram_outbox SET state='UNKNOWN', finished_at=now() " +
      "WHERE state='IN_FLIGHT' AND started_at < now() - ($1::integer * interval '1 second') " +
      'RETURNING update_id,action_key', [minAgeSeconds]
    );
    return r.rows.map(row=>Object.freeze({
      updateId:Number(row.update_id),actionKey:row.action_key,status:'UNKNOWN',
    }));
  }

  // Intentionally no network sender in this repository/runtime. A future
  // certified dispatcher must call claimForSend exactly once then markSent
  // or finishUnknown. Never automatically replay IN_FLIGHT or UNKNOWN.
}

module.exports = { PostgresTelegramOutbox, TelegramOutboxError };
