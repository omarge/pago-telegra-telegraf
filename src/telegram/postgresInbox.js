'use strict';

const crypto = require('node:crypto');

class TelegramInboxError extends Error {
  constructor(code) { super(code); this.name = 'TelegramInboxError'; this.code = code; }
}
function validId(id) {
  return Number.isSafeInteger(id) && id >= 0;
}
function canonical(value, depth = 0) {
  if (depth > 30) throw new TelegramInboxError('INBOX_ENVELOPE_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(x => canonical(x, depth + 1));
  if (typeof value !== 'object' || !value ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TelegramInboxError('INBOX_ENVELOPE_INVALID');
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new TelegramInboxError('INBOX_ENVELOPE_INVALID');
    }
    out[key] = canonical(value[key], depth + 1);
  }
  return out;
}
function serialize(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update) ||
      !validId(update.update_id)) throw new TelegramInboxError('INBOX_ENVELOPE_INVALID');
  const payload = JSON.stringify(canonical(update));
  if (Buffer.byteLength(payload, 'utf8') > 65536) {
    throw new TelegramInboxError('INBOX_ENVELOPE_INVALID');
  }
  return payload;
}

class PostgresTelegramInbox {
  constructor({enabled = false, pool, encryptionKeyHex} = {}) {
    this.enabled = enabled === true;
    if (!this.enabled) return;
    if (!pool || typeof pool.query !== 'function' ||
        typeof encryptionKeyHex !== 'string' ||
        !/^[a-fA-F0-9]{64}$/.test(encryptionKeyHex)) {
      throw new TelegramInboxError('INBOX_NOT_CONFIGURED');
    }
    this.pool = pool;
    this.key = Buffer.from(encryptionKeyHex, 'hex');
  }
  guard() {
    if (!this.enabled) throw new TelegramInboxError('INBOX_DISABLED');
  }
  async execute(sql, values) {
    try {
      return await this.pool.query(sql, values);
    } catch (_) {
      // NEVER expose ciphertext, keys, DB credentials, or raw Telegram payload.
      throw new TelegramInboxError('INBOX_DATABASE_UNAVAILABLE');
    }
  }

  async append(update) {
    this.guard();
    const payload = serialize(update);
    const id = update.update_id;
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(String(id), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const written = await this.execute(
      'INSERT INTO kashbit_telegram_inbox (update_id, digest, iv, tag, ciphertext) ' +
      'VALUES ($1, $2, $3, $4, $5) ON CONFLICT (update_id) DO NOTHING RETURNING update_id',
      [id, digest, iv, tag, ciphertext]
    );
    if (written.rows.length === 1) return Object.freeze({inserted: true, updateId: id});
    const existing = await this.execute(
      'SELECT digest FROM kashbit_telegram_inbox WHERE update_id = $1', [id]);
    if (existing.rows.length !== 1 || existing.rows[0].digest !== digest) {
      throw new TelegramInboxError('INBOX_IDENTITY_CONFLICT');
    }
    return Object.freeze({inserted: false, updateId: id});
  }

  // Safe for advancing the Telegram offset ONLY after all fetched updates
  // have individually been successfully appended. Keep processing independent.
  async maxPersistedId() {
    this.guard();
    const r = await this.execute('SELECT max(update_id)::text AS id FROM kashbit_telegram_inbox', []);
    if (!r.rows[0] || r.rows[0].id === null) return null;
    const id = Number(r.rows[0].id);
    if (!validId(id)) throw new TelegramInboxError('INBOX_DATABASE_UNAVAILABLE');
    return id;
  }

  async claim({leaseSeconds = 30} = {}) {
    this.guard();
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300) {
      throw new TelegramInboxError('INBOX_LEASE_INVALID');
    }
    const lease = crypto.randomUUID();
    const r = await this.execute(
      'WITH candidate AS (SELECT i.update_id FROM kashbit_telegram_inbox AS i ' +
      "WHERE (i.state = 'PENDING' OR (i.state = 'PROCESSING' AND i.leased_until < now())) " +
      'AND i.attempts < 12 AND NOT EXISTS (SELECT 1 FROM kashbit_telegram_inbox AS older ' +
      "WHERE older.update_id < i.update_id AND older.state NOT IN ('DONE', 'QUARANTINED')) " +
      'ORDER BY i.update_id LIMIT 1 FOR UPDATE OF i SKIP LOCKED) ' +
      'UPDATE kashbit_telegram_inbox AS i ' +
      "SET state = 'PROCESSING', lease_id = $1::uuid, " +
      "leased_until = now() + ($2::integer * interval '1 second'), " +
      'attempts = i.attempts + 1 FROM candidate AS c ' +
      'WHERE i.update_id = c.update_id ' +
      'RETURNING i.update_id, i.iv, i.tag, i.ciphertext, i.attempts',
      [lease, leaseSeconds]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const id = Number(row.update_id);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, row.iv);
      decipher.setAAD(Buffer.from(String(id), 'utf8'));
      decipher.setAuthTag(row.tag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      const update = JSON.parse(plaintext.toString('utf8'));
      if (!validId(id) || update.update_id !== id) throw Error('invalid id');
      return Object.freeze({updateId: id, leaseId: lease, attempts: row.attempts, update});
    } catch (_) {
      // Never deliver unauthenticated/tampered Telegram payload; quarantine by
      // this lease rather than blindly retry an undecryptable row.
      await this.quarantine(id, lease);
      throw new TelegramInboxError('INBOX_PAYLOAD_UNTRUSTED');
    }
  }

  async ack(updateId, leaseId) {
    this.guard();
    this.checkLease(updateId, leaseId);
    const r = await this.execute(
      "UPDATE kashbit_telegram_inbox SET state='DONE', lease_id=NULL, " +
      'leased_until=NULL, finished_at=now() ' +
      "WHERE update_id=$1 AND lease_id=$2::uuid AND state='PROCESSING' " +
      'AND leased_until > now() RETURNING update_id',
      [updateId, leaseId]
    );
    return r.rows.length === 1;
  }

  async release(updateId, leaseId) {
    this.guard();
    this.checkLease(updateId, leaseId);
    const r = await this.execute(
      "UPDATE kashbit_telegram_inbox SET " +
      "state=CASE WHEN attempts >= 12 THEN 'QUARANTINED' ELSE 'PENDING' END, " +
      'lease_id=NULL, leased_until=NULL ' +
      "WHERE update_id=$1 AND lease_id=$2::uuid AND state='PROCESSING' " +
      'AND leased_until > now() RETURNING update_id',
      [updateId, leaseId]
    );
    return r.rows.length === 1;
  }

  async quarantine(updateId, leaseId) {
    this.guard();
    this.checkLease(updateId, leaseId);
    const r = await this.execute(
      "UPDATE kashbit_telegram_inbox SET state='QUARANTINED', " +
      'lease_id=NULL, leased_until=NULL ' +
      "WHERE update_id=$1 AND lease_id=$2::uuid AND state='PROCESSING' " +
      'RETURNING update_id',
      [updateId, leaseId]
    );
    return r.rows.length === 1;
  }

  checkLease(id, lease) {
    if (!validId(id) || typeof lease !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lease)) {
      throw new TelegramInboxError('INBOX_LEASE_INVALID');
    }
  }
}
module.exports = {PostgresTelegramInbox, TelegramInboxError};
