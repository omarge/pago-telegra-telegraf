'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  PostgresCanonicalRequestAuthority,
  normalizeRequest,
} = require('../src/businessos/postgresCanonicalRequestAuthority');
const { BusinessOsPaymentPreparation } = require('../src/businessos/paymentPreparation');

function record(extra = {}) {
  const id = 'KPR-' + randomUUID();
  return {
    id, tenantId: 'tenant-ci',
    merchantId: 'merchant-ci', payerActorId: 'actor-ci',
    amountCents: 1050, currency: 'MXN',
    occurredAt: '2026-10-28T00:00:00.000Z',
    riskIdempotencyKey: 'risk-' + id,
    ...extra,
  };
}

describe('F05 canonical request input and fail-closed DB boundary (always)', () => {
  it('requires injection and explicit enablement', async () => {
    let calls = 0;
    const repo = new PostgresCanonicalRequestAuthority({
      pool: {query: async () => { calls++; return {rows: []}; }},
    });
    await assert.rejects(repo.create(record()), e => e.code === 'CANONICAL_DB_DISABLED');
    await assert.rejects(repo.loadById('KPR-one'), e => e.code === 'CANONICAL_DB_DISABLED');
    assert.equal(calls, 0);
    assert.throws(() => new PostgresCanonicalRequestAuthority({enabled: true}),
      e => e.code === 'CANONICAL_DB_NOT_CONFIGURED');
  });
  it('refuses invalid economic values before touching the DB', async () => {
    let calls = 0;
    const repo = new PostgresCanonicalRequestAuthority({
      enabled: true, pool: {query: async () => { calls++; return {rows: []}; }},
    });
    for (const bad of [
      {amountCents: 0}, {amountCents: -10}, {amountCents: 1.5},
      {amountCents: Number.MAX_SAFE_INTEGER+1}, {currency: 'USD'},
      {id: "x'; DROP TABLE kashbit_telegram_payment_requests;--"},
      {riskIdempotencyKey: ''}, {payerActorId: ''},
      {occurredAt: 'tomorrow'},
    ]) {
      await assert.rejects(repo.create(record(bad)),
        e => e.code === 'CANONICAL_REQUEST_INVALID');
    }
    await assert.rejects(repo.loadById("x' OR 1=1 --"),
      e => e.code === 'CANONICAL_REQUEST_INVALID');
    assert.equal(calls, 0);
  });
  it('converts database failures to opaque unavailability without leaking secrets', async () => {
    const repo = new PostgresCanonicalRequestAuthority({
      enabled: true, pool: { query: async () => {
        throw new Error('postgres://sensitive_user:secret_password@localhost:5432');
      }},
    });
    for (const op of [() => repo.create(record()), () => repo.loadById('KPR-one')]) {
      await assert.rejects(op(), e =>
        e.code === 'CANONICAL_DB_UNAVAILABLE' &&
        !e.message.includes('secret_password'));
    }
  });
  it('projects immutable JSON without trusting extra client fields', () => {
    const r = normalizeRequest({...record(), fraudDecision: 'APPROVE',
      customerId: 'fake', paid: true});
    assert.equal(Object.keys(r).length, 8);
    assert.ok(!Object.hasOwn(r, 'fraudDecision'));
    assert.ok(!Object.hasOwn(r, 'paid'));
    assert.equal(Object.isFrozen(r), true);
  });
});

describe('F05 PostgreSQL 18 integration (GitHub Actions only)', {
  skip: !process.env.F05_POSTGRES_URL,
}, () => {
  let pool, db;
  before(async () => {
    const {Pool} = require('pg');
    pool = new Pool({
      connectionString: process.env.F05_POSTGRES_URL,
      max: 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
    });
    const script = fs.readFileSync(
      path.join(__dirname, '..', 'sql', 'f05_telegram_canonical_requests.sql'), 'utf8');
    await pool.query(script);
    db = new PostgresCanonicalRequestAuthority({enabled: true, pool});
  });
  after(async () => { if (pool) await pool.end(); });

  it('persists a canonical request, preserves cents, round trips after a new adapter instance', async () => {
    const request = record();
    const created = await db.create(request);
    assert.deepEqual(created, request);
    const afterRestart = new PostgresCanonicalRequestAuthority({enabled: true, pool});
    assert.deepEqual(await afterRestart.loadById(request.id), request);
  });

  it('serializes 32 concurrent identical replays to one durable request', async () => {
    const request = record();
    const results = await Promise.all(
      Array.from({length: 32}, () => db.create(request)));
    assert.ok(results.every(x => JSON.stringify(x) === JSON.stringify(request)));
    const found = await pool.query(
      'SELECT COUNT(*)::integer AS n FROM kashbit_telegram_payment_requests WHERE request_id = $1',
      [request.id]);
    assert.equal(found.rows[0].n, 1);
  });

  it('rejects same request key with altered tenant, payer, amount or merchant', async () => {
    const request = record();
    await db.create(request);
    for (const changes of [
      {amountCents: 1}, {tenantId: 'tenant-attacker'},
      {payerActorId: 'actor-attacker'}, {merchantId: 'merchant-attacker'},
      {riskIdempotencyKey: 'risk-attacker'},
    ]) {
      await assert.rejects(db.create({...request,...changes}),
        e => e.code === 'CANONICAL_REQUEST_CONFLICT');
    }
    assert.deepEqual(await db.loadById(request.id), request);
  });

  it('rejects a different request ID replaying the same tenant-risk key', async () => {
    const request = record();
    await db.create(request);
    await assert.rejects(db.create({...request,id: 'KPR-'+randomUUID()}),
      e => e.code === 'CANONICAL_REQUEST_CONFLICT');
  });

  it('keeps even 1-cent request immutable at the database layer', async () => {
    const request = record({amountCents: 1});
    await db.create(request);
    await assert.rejects(pool.query(
      'UPDATE kashbit_telegram_payment_requests SET amount_cents=99999 WHERE request_id=$1',
      [request.id]), e => e.code === 'P0001');
    await assert.rejects(pool.query(
      'DELETE FROM kashbit_telegram_payment_requests WHERE request_id=$1',
      [request.id]), e => e.code === 'P0001');
    assert.equal((await db.loadById(request.id)).amountCents, 1);
  });

  it('does not turn PostgreSQL request persistence into Payment or Risk authority', async () => {
    const request = record();
    await db.create(request);
    let riskCalls = 0;
    const prep = new BusinessOsPaymentPreparation({
      enabled: true,
      requestAuthority: db,
      securityGateway: {authorizeTelegramInitData: async () => ({
        actorId: request.payerActorId,
        tenantId: request.tenantId,
        actorType: 'USER', targetId: request.merchantId,
      })},
      customerAuthority: {resolve: async () => ({
        customerId: 'customer-ci', actorId: request.payerActorId, tenantId: request.tenantId,
      })},
      methodAuthority: {resolve: async () => ({
        customerId: 'customer-ci', tenantId: request.tenantId,
        vaultToken: 'not-a-real-card', bin: '411111', last4: '1111',
        deviceFingerprint: 'ci-fingerprint',clientIp: '192.0.2.8',
      })},
      fraudClient: {assess: async () => {
        riskCalls++; return {assessmentId:'assessment-ci',decision:'REVIEW'};
      }},
    });
    const outcome = await prep.prepare({
      signedTelegramInitData:'signed-CI-fixture', requestId:request.id,
      amountCents:1, tenantId:'tenant-attacker', paid:true,
    });
    assert.equal(outcome.status,'RISK_HOLD_NO_PAYMENT');
    assert.equal(riskCalls,1);
    assert.equal(Object.hasOwn(outcome,'paid'),false);
  });
});
