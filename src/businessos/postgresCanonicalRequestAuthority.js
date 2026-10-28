'use strict';

// F05: immutable, PostgreSQL-backed server-side payment request authority.
// This is NOT activated in the current Telegram bot. No credentials or DB
// connection are created here. A validated pg Pool is injected by trusted
// runtime wiring only after migration/readiness checks are authorized.

class CanonicalRequestError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CanonicalRequestError';
    this.code = code;
  }
}
function required(value, max = 128) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= max && value.trim() === value &&
    !/[\r\n\x00]/.test(value);
}
function validId(value) {
  return required(value) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}
const SELECT_COLUMNS =
  'request_id, tenant_id, merchant_id, payer_actor_id, amount_cents, currency, occurred_at, risk_idempotency_key';
const SELECT_BY_ID = 'SELECT ' + SELECT_COLUMNS +
  ' FROM kashbit_telegram_payment_requests WHERE request_id = $1';

function normalizeRequest(value) {
  const fail = () => { throw new CanonicalRequestError('CANONICAL_REQUEST_INVALID'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !validId(value.id) || !required(value.tenantId) ||
      !required(value.merchantId) || !required(value.payerActorId) ||
      !required(value.riskIdempotencyKey) ||
      !Number.isSafeInteger(value.amountCents) || value.amountCents <= 0 ||
      value.currency !== 'MXN' ||
      typeof value.occurredAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.occurredAt)) fail();

  const date = new Date(value.occurredAt);
  if (!Number.isFinite(date.getTime())) fail();
  return Object.freeze({
    id: value.id,
    tenantId: value.tenantId,
    merchantId: value.merchantId,
    payerActorId: value.payerActorId,
    amountCents: value.amountCents,
    currency: 'MXN',
    occurredAt: date.toISOString(),
    riskIdempotencyKey: value.riskIdempotencyKey,
  });
}

function fromRow(row) {
  if (!row) return null;
  const cents = Number(row.amount_cents);
  const occurredAt = row.occurred_at instanceof Date
    ? row.occurred_at.toISOString()
    : new Date(row.occurred_at).toISOString();
  return normalizeRequest({
    id: row.request_id,
    tenantId: row.tenant_id,
    merchantId: row.merchant_id,
    payerActorId: row.payer_actor_id,
    amountCents: cents,
    currency: row.currency,
    occurredAt,
    riskIdempotencyKey: row.risk_idempotency_key,
  });
}
function same(a, b) {
  return a && b && Object.keys(a).every(key => a[key] === b[key]);
}

class PostgresCanonicalRequestAuthority {
  constructor({ pool, enabled = false } = {}) {
    this.enabled = enabled === true;
    if (!this.enabled) return;
    if (!pool || typeof pool.query !== 'function') {
      throw new CanonicalRequestError('CANONICAL_DB_NOT_CONFIGURED');
    }
    this.pool = pool;
  }

  async loadById(id) {
    if (!this.enabled) throw new CanonicalRequestError('CANONICAL_DB_DISABLED');
    if (!validId(id)) throw new CanonicalRequestError('CANONICAL_REQUEST_INVALID');
    try {
      const result = await this.pool.query(SELECT_BY_ID, [id]);
      return result.rows.length === 0 ? null : fromRow(result.rows[0]);
    } catch (_) {
      throw new CanonicalRequestError('CANONICAL_DB_UNAVAILABLE');
    }
  }

  async create(request) {
    if (!this.enabled) throw new CanonicalRequestError('CANONICAL_DB_DISABLED');
    const expected = normalizeRequest(request);
    // Single SQL atomic insert. The globally unique request_id and tenant/risk
    // key protect concurrent identical submits and identity/key collisions.
    // A duplicate with any different economic payload is ALWAYS a conflict.
    const sql = 'INSERT INTO kashbit_telegram_payment_requests ' +
      '(request_id, tenant_id, merchant_id, payer_actor_id, amount_cents,' +
      ' currency, occurred_at, risk_idempotency_key) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ' +
      'ON CONFLICT DO NOTHING RETURNING ' + SELECT_COLUMNS;
    const params = [expected.id, expected.tenantId, expected.merchantId,
      expected.payerActorId, String(expected.amountCents), expected.currency,
      expected.occurredAt, expected.riskIdempotencyKey];
    let result;
    try {
      result = await this.pool.query(sql, params);
    } catch (_) {
      throw new CanonicalRequestError('CANONICAL_DB_UNAVAILABLE');
    }
    if (result.rows.length === 1) {
      let stored;
      try { stored = fromRow(result.rows[0]); } catch (_) {
        throw new CanonicalRequestError('CANONICAL_DB_UNAVAILABLE');
      }
      if (!same(stored, expected)) throw new CanonicalRequestError('CANONICAL_DB_UNAVAILABLE');
      return stored;
    }
    // READ COMMITTED creates a fresh snapshot after an ON CONFLICT loser
    // waits for the winner to commit. No local mutex is relied on.
    const existing = await this.loadById(expected.id);
    if (!same(existing, expected)) {
      throw new CanonicalRequestError('CANONICAL_REQUEST_CONFLICT');
    }
    return existing;
  }
}
module.exports = {
  PostgresCanonicalRequestAuthority, CanonicalRequestError,
  normalizeRequest,
};
