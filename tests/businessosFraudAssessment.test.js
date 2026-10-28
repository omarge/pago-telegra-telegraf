'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BusinessOsFraudAssessmentClient, validateAssessmentRequest,
  FraudContractError,
} = require('../src/businessos/fraudAssessmentClient');

const payment = () => ({
  paymentId: 'payment-immutable-1',
  merchantId: 'merchant-immutable-1',
  customerId: 'canonical-businessos-customer-1',
  amount: { value: '10.50', currency: 'MXN' },
  method: { type: 'CARD', vaultToken: 'vault-reference', bin: '411111', last4: '1111' },
  device: { fingerprint: 'trusted-device-fingerprint', ip: '192.0.2.17' },
  occurredAt: '2026-10-28T20:00:00Z',
});

const result = (overrides = {}) => ({
  assessmentId: '54d5a3f5-ea4e-4e3c-99ce-82ca4e7aa037',
  decision: 'REVIEW', score: 0.5,
  reasons: [{ code: 'NO_SIGNALS', description: 'No signals' }],
  modelVersion: 'risk-v1', ...overrides,
});

function client(fetchImpl, overrides = {}) {
  return new BusinessOsFraudAssessmentClient({
    enabled: true, baseUrl: 'https://fraud.uat.example',
    tenantId: 'tenant-authoritative',
    fetchImpl, ...overrides,
  });
}
const ok = (value) => new Response(JSON.stringify(value), { status: 200 });

describe('F04 Fraud Engine contract certification, fake transport only', () => {
  it('disables all network calls by default', async () => {
    let n = 0;
    const gateway = new BusinessOsFraudAssessmentClient({
      fetchImpl: async () => { n++; throw new Error('MUST NOT CONNECT'); },
    });
    await assert.rejects(gateway.assess(payment(), 'risk-key'),
      e => e.code === 'FRAUD_DISABLED');
    assert.equal(n, 0);
  });

  it('enforces HTTPS, server tenant and valid timeout', () => {
    for (const changes of [
      { baseUrl: 'http://fraud.uat.example' }, { baseUrl: 'https://fraud.uat.example/other' },
      { tenantId: '' }, { timeoutMs: 0 }, { timeoutMs: 40000 },
    ]) assert.throws(() => client(async () => ok(result()), changes),
      e => e.code === 'FRAUD_CONFIG_INVALID');
  });

  it('serializes exact Java REST contract with original stable idempotency key', async () => {
    let n = 0;
    const gateway = client(async (url, opts) => {
      n++;
      assert.equal(url, 'https://fraud.uat.example/v1/fraud/assessments');
      assert.equal(opts.method, 'POST');
      assert.equal(opts.headers['X-Tenant-Id'], 'tenant-authoritative');
      assert.equal(opts.headers['Idempotency-Key'], 'risk-tenant-payment-immutable-1');
      assert.deepEqual(JSON.parse(opts.body), payment());
      assert.equal(Object.hasOwn(JSON.parse(opts.body), 'telegramUserId'), false);
      return ok(result());
    });
    const assessed = await gateway.assess({ ...payment(), telegramUserId: 'fake',
      pan: 'should-never-leak', cvv: '123' }, 'risk-tenant-payment-immutable-1');
    assert.deepEqual(assessed, {
      assessmentId: '54d5a3f5-ea4e-4e3c-99ce-82ca4e7aa037',
      decision: 'REVIEW', score: 0.5, modelVersion: 'risk-v1',
    });
    assert.equal(Object.isFrozen(assessed), true);
    assert.equal(n, 1);
  });

  it('fails closed if a card assessment lacks a vaultToken, BIN or last4', () => {
    for (const bad of [
      { ...payment(), method: { type: 'CARD', vaultToken: '', bin: '411111', last4: '1111' } },
      { ...payment(), method: { type: 'CARD', vaultToken: 'vt', bin: '', last4: '1111' } },
      { ...payment(), method: { type: 'CARD', vaultToken: 'vt', bin: '411111', last4: '' } },
      { ...payment(), amount: { value: '10.501', currency: 'MXN' } },
      { ...payment(), amount: { value: 10.50, currency: 'MXN' } },
      { ...payment(), method: { type: 'CODI' } },
      { ...payment(), occurredAt: 'invalid' },
    ]) assert.throws(() => validateAssessmentRequest(bad),
      e => e.code === 'FRAUD_CONTRACT_INVALID');
  });

  it('does not promote REVIEW, CHALLENGE or DECLINE to approval', async () => {
    for (const decision of ['REVIEW', 'CHALLENGE', 'DECLINE', 'APPROVE']) {
      const gateway = client(async () => ok(result({ decision })));
      const assessed = await gateway.assess(payment(), 'risk-key-1');
      assert.equal(assessed.decision, decision);
      assert.equal(Object.hasOwn(assessed, 'approved'), false);
    }
  });

  it('rejects fabricated or noncanonical 200 decisions', async () => {
    for (const patched of [
      { decision: 'AUTHORIZED' }, { decision: 'PAID' },
      { assessmentId: 'no-uuid' }, { assessmentId: null },
      { score: -1 }, { score: 1.5 }, { reasons: null },
      { modelVersion: null },
    ]) {
      const gateway = client(async () => ok(result(patched)));
      await assert.rejects(gateway.assess(payment(), 'risk-key-1'),
        e => e.code === 'FRAUD_RESPONSE_INVALID');
    }
  });

  it('uses NO retry on timeout, 500, 429 or malformed response', async () => {
    for (const fake of [
      async () => { throw new Error('timeout with raw token'); },
      async () => new Response('error', { status: 500 }),
      async () => new Response('error', { status: 429 }),
      async () => new Response('{', { status: 200 }),
    ]) {
      let n = 0;
      const gateway = client(async (...args) => { n++; return fake(...args); });
      await assert.rejects(gateway.assess(payment(), 'risk-key-1'),
        e => e.code === 'FRAUD_OUTCOME_UNKNOWN' && !e.message.includes('token'));
      assert.equal(n, 1);
    }
  });

  it('treats conflict, invalid payload and empty key as errors, not approvals', async () => {
    let n = 0;
    const gateway = client(async () => { n++; return new Response('{}', { status: 409 }); });
    await assert.rejects(gateway.assess(payment(), 'risk-key-1'),
      e => e.code === 'FRAUD_IDEMPOTENCY_CONFLICT');
    assert.equal(n, 1);
    await assert.rejects(gateway.assess(payment(), ''),
      e => e.code === 'FRAUD_CONTRACT_INVALID');
    assert.equal(n, 1);
    assert.throws(() => validateAssessmentRequest(null),
      e => e.code === 'FRAUD_CONTRACT_INVALID');
  });
});
