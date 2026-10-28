'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BusinessOsPaymentAuthorizationClient,
  BusinessOsIntegrationError,
  validateAuthorization,
} = require('../src/businessos/paymentAuthorizationClient');

const validRequest = () => ({
  tenantId: 'tenant-uat',
  paymentIntentId: 'int-kpr-1',
  paymentAttemptId: 'att-kpr-1',
  amount: '10.00',
  currency: 'MXN',
  paymentMethodType: 'CARD',
  paymentChannel: 'PAYMENT_LINK',
  businessReferenceType: 'TELEGRAM_REQUEST',
  businessReference: 'KPR-1',
  idempotencyKey: 'tg-tenant-uat-KPR-1',
  paymentMethodReferenceProvider: 'OPENPAY',
  paymentMethodReference: 'sandbox-token-reference',
  description: 'Sandbox payment',
  fraudDeviceSessionReference: 'sandbox-session',
  clientIpAddress: '192.0.2.1',
  fraudAssessmentId: 'assessment-from-risk-engine',
  fraudDecision: 'APPROVE',
  customerId: 'businessos-customer-1',
});

function client(fetchImpl, other = {}) {
  return new BusinessOsPaymentAuthorizationClient({
    enabled: true,
    baseUrl: 'https://businessos-uat.example',
    delegatedBearerToken: 'test-delegated-authority',
    fetchImpl,
    ...other,
  });
}

describe('BusinessOS authorization boundary F00 (no live PSP calls)', () => {
  it('is disabled by default and never makes a network call', async () => {
    let calls = 0;
    const adapter = new BusinessOsPaymentAuthorizationClient({
      fetchImpl: async () => { calls++; throw Error('should not call'); },
    });
    await assert.rejects(adapter.authorize(validRequest()),
      (e) => e.code === 'INTEGRATION_DISABLED');
    assert.equal(calls, 0);
  });

  it('requires HTTPS and delegated service authority when enabled', () => {
    assert.throws(
      () => client(async () => {}, { baseUrl: 'http://localhost:8080' }),
      (e) => e.code === 'INVALID_ENDPOINT'
    );
    assert.throws(
      () => client(async () => {}, { delegatedBearerToken: '' }),
      (e) => e.code === 'AUTH_NOT_CONFIGURED'
    );
  });

  it('does not accept fabricated/missing fraud approval or Telegram enum not supported by BusinessOS', () => {
    assert.throws(
      () => validateAuthorization({ ...validRequest(), fraudDecision: 'UNKNOWN' }),
      (e) => e.code === 'INVALID_CONTRACT'
    );
    assert.throws(
      () => validateAuthorization({ ...validRequest(), paymentChannel: 'TELEGRAM' }),
      (e) => e.code === 'INVALID_CONTRACT'
    );
    assert.throws(
      () => validateAuthorization({ ...validRequest(), amount: 10.001 }),
      (e) => e.code === 'INVALID_CONTRACT'
    );
  });

  it('sends the exact Payment Engine path, delegated authority and allowlisted fields', async () => {
    let calls = 0;
    const adapter = client(async (url, init) => {
      calls++;
      assert.equal(url, 'https://businessos-uat.example/internal/v1/payment-authorizations');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer test-delegated-authority');
      const body = JSON.parse(init.body);
      assert.equal(body.amount, '10.00');
      assert.equal(body.idempotencyKey, 'tg-tenant-uat-KPR-1');
      assert.equal(body.paymentChannel, 'PAYMENT_LINK');
      assert.ok(!Object.hasOwn(body, 'pan'));
      assert.ok(!Object.hasOwn(body, 'cvv'));
      return new Response(JSON.stringify({
        status: 'AUTHORIZED', paymentIntentId: 'int-from-businessos',
        paymentAttemptId: 'att-from-businessos',
      }), { status: 200 });
    });
    const result = await adapter.authorize({
      ...validRequest(), pan: 'DO_NOT_SEND', cvv: 'DO_NOT_SEND',
    });
    assert.equal(result.authorizationStatus, 'AUTHORIZED');
    assert.equal(calls, 1);
  });

  it('preserves UNKNOWN without converting to PAID', async () => {
    const adapter = client(async () => new Response(JSON.stringify({
      status: 'UNKNOWN', unknownReconciliationReference: 'rec-1',
    }), { status: 200 }));
    const outcome = await adapter.authorize(validRequest());
    assert.equal(outcome.authorizationStatus, 'UNKNOWN');
    assert.equal(outcome.unknownReconciliationReference, 'rec-1');
    assert.equal(Object.hasOwn(outcome, 'paid'), false);
  });

  it('classifies forbidden delegated authority without attempting a retry', async () => {
    let calls = 0;
    const adapter = client(async () => { calls++; return new Response('', { status: 403 }); });
    await assert.rejects(adapter.authorize(validRequest()), (e) => e.code === 'AUTH_DENIED');
    assert.equal(calls, 1);
  });

  it('treats timeout, 503 and malformed responses as unknown outcomes; no retries', async () => {
    for (const fake of [
      async () => { throw Error('timeout'); },
      async () => new Response('', { status: 503 }),
      async () => new Response('not-json', { status: 200 }),
    ]) {
      let calls = 0;
      const adapter = client(async (...args) => { calls++; return fake(...args); });
      await assert.rejects(adapter.authorize(validRequest()),
        (e) => e.code === 'UNKNOWN_REMOTE_OUTCOME');
      assert.equal(calls, 1);
    }
  });

  it('accepts only documented conflict and pre-execution statuses', async () => {
    for (const [http, status] of [[409, 'CONFLICT'], [422, 'PRE_EXECUTION_FAILED']]) {
      const adapter = client(async () => new Response(JSON.stringify({ status }), { status: http }));
      assert.equal((await adapter.authorize(validRequest())).authorizationStatus, status);
    }
    const mismatch = client(async () => new Response(
      JSON.stringify({ status: 'AUTHORIZED' }), { status: 409 }));
    await assert.rejects(mismatch.authorize(validRequest()),
      (e) => e.code === 'UNKNOWN_REMOTE_OUTCOME');
  });
});
