'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BusinessOsPaymentPreparation, PaymentPreparationError, centsToDecimal,
} = require('../src/businessos/paymentPreparation');

function fixture(changes = {}) {
  let riskCalled = 0, authCalled = 0, customerCalled = 0, methodCalled = 0;
  const record = {
    id: 'KPR-immut-01', tenantId: 'tenant-1', merchantId: 'merchant-1',
    payerActorId: 'actor-1', amountCents: 1050, currency: 'MXN',
    occurredAt: '2026-10-28T12:00:00Z',
    riskIdempotencyKey: 'risk-tenant-1-KPR-immut-01',
    ...changes.record,
  };
  const actor = { actorId: 'actor-1', tenantId: 'tenant-1',
    targetId: 'merchant-1', actorType: 'USER', ...changes.actor };
  const customer = { customerId: 'customer-verified-1', actorId: 'actor-1',
    tenantId: 'tenant-1', ...changes.customer };
  const method = { tenantId: 'tenant-1', customerId: 'customer-verified-1',
    vaultToken: 'token-in-vault', bin: '411111', last4: '1111',
    deviceFingerprint: 'device-from-authority', clientIp: '192.0.2.1',
    ...changes.method };
  const risk = { decision: 'APPROVE', assessmentId: 'fraud-assessment-1', ...changes.risk };
  const ports = {
    securityGateway: {
      authorizeTelegramInitData: async (raw, merchantId) => {
        authCalled++;
        assert.equal(raw, 'signed-fixture');
        assert.equal(merchantId, record.merchantId);
        return actor;
      },
    },
    requestAuthority: { loadById: async id => {
      assert.equal(id, 'KPR-immut-01');
      return record;
    } },
    customerAuthority: { resolve: async data => {
      customerCalled++;
      assert.deepEqual(data, {
        tenantId: record.tenantId, actorId: actor.actorId, merchantId: record.merchantId,
      });
      return customer;
    } },
    methodAuthority: { resolve: async data => {
      methodCalled++;
      assert.deepEqual(data, {
        tenantId: record.tenantId, customerId: customer.customerId,
        merchantId: record.merchantId, requestId: record.id,
      });
      return method;
    } },
    fraudClient: { assess: async (request, idempotencyKey) => {
      riskCalled++;
      assert.equal(idempotencyKey, record.riskIdempotencyKey);
      assert.deepEqual(request, {
        paymentId: 'KPR-immut-01', merchantId: record.merchantId,
        customerId: customer.customerId,
        amount: { value: centsToDecimal(record.amountCents), currency: 'MXN' },
        method: { type: 'CARD', vaultToken: method.vaultToken,
          bin: method.bin, last4: method.last4 },
        device: { fingerprint: method.deviceFingerprint, ip: method.clientIp },
        occurredAt: record.occurredAt,
      });
      if (changes.riskFailure) throw new Error('risk unavailable');
      return risk;
    } },
  };
  return { gate: new BusinessOsPaymentPreparation({ enabled: true, ...ports }),
    counters: () => ({riskCalled,authCalled,customerCalled,methodCalled}) };
}
const input = (extra = {}) => ({
  signedTelegramInitData: 'signed-fixture', requestId: 'KPR-immut-01', ...extra,
});

describe('F04 canonical payment preparation (no Payment Engine PSP call)', () => {
  it('is disabled by default and cannot contact any service', async () => {
    const gate = new BusinessOsPaymentPreparation();
    await assert.rejects(gate.prepare(input()), e => e.code === 'PREPARATION_DISABLED');
  });

  it('requires independent server-owned identity, request, customer, method and fraud ports', () => {
    assert.throws(() => new BusinessOsPaymentPreparation({enabled: true}),
      e => e.code === 'PREPARATION_PORTS_NOT_CONFIGURED');
  });

  it('prepares only, with amount from durable server record; ignores forged browser economics', async () => {
    const { gate, counters } = fixture();
    const prepared = await gate.prepare(input({
      amountCents: 1, currency: 'USD', tenantId: 'tenant-attacker',
      merchantId: 'merchant-attacker', fraudDecision: 'APPROVE',
      actorId: 'actor-attacker', customerId: 'customer-attacker',
    }));
    assert.deepEqual(prepared, {
      status: 'RISK_APPROVED_NOT_AUTHORIZED',
      riskDecision: 'APPROVE',
      fraudAssessmentId: 'fraud-assessment-1',
      paymentReference: 'KPR-immut-01',
      tenantId: 'tenant-1',
    });
    assert.deepEqual(counters(), {
      riskCalled: 1, authCalled: 1, customerCalled: 1, methodCalled: 1,
    });
    assert.ok(!JSON.stringify(prepared).includes('token-in-vault'));
    assert.ok(!Object.hasOwn(prepared, 'paid'));
    assert.equal(Object.isFrozen(prepared), true);
  });

  it('all CHALLENGE, REVIEW and DECLINE hold without payment authority', async () => {
    for (const decision of ['CHALLENGE', 'REVIEW', 'DECLINE']) {
      const { gate } = fixture({ risk: { decision } });
      const out = await gate.prepare(input());
      assert.equal(out.status, 'RISK_HOLD_NO_PAYMENT');
      assert.equal(out.riskDecision, decision);
    }
  });

  it('rejects payer, tenant and resource substitution BEFORE accessing card and risk', async () => {
    for (const changes of [
      { actor: { actorId: 'other-actor' } },
      { actor: { tenantId: 'other-tenant' } },
      { actor: { targetId: 'wrong-merchant' } },
      { record: { payerActorId: '' } },
      { record: { amountCents: -1 } },
      { record: { amountCents: 10.5 } },
      { record: { currency: 'USD' } },
      { record: { riskIdempotencyKey: '' } },
    ]) {
      const { gate, counters } = fixture(changes);
      await assert.rejects(gate.prepare(input()), e =>
        ['PAYMENT_ACTOR_NOT_AUTHORIZED', 'CANONICAL_PAYMENT_INVALID'].includes(e.code));
      assert.equal(counters().riskCalled, 0);
    }
  });

  it('rejects mismatched customer and card ownership BEFORE fraud', async () => {
    for (const changes of [
      { customer: { actorId: 'wrong-actor' } },
      { customer: { tenantId: 'wrong-tenant' } },
      { customer: { customerId: '' } },
      { method: { customerId: 'wrong-customer' } },
      { method: { tenantId: 'wrong-tenant' } },
      { method: { bin: '' } },
      { method: { last4: '123' } },
      { method: { vaultToken: '' } },
      { method: { clientIp: '' } },
    ]) {
      const { gate, counters } = fixture(changes);
      await assert.rejects(gate.prepare(input()), e =>
        ['CUSTOMER_BINDING_UNVERIFIED', 'CUSTOMER_METHOD_NOT_VERIFIED'].includes(e.code));
      assert.equal(counters().riskCalled, 0);
    }
  });

  it('never maps risk outage or malformed result to APPROVE', async () => {
    for (const changes of [
      { riskFailure: true },
      { risk: { decision: 'FAKE_APPROVE' } },
      { risk: { assessmentId: '' } },
    ]) {
      const { gate } = fixture(changes);
      await assert.rejects(gate.prepare(input()));
    }
  });

  it('keeps integer-cent conversion exact without floating arithmetic', () => {
    assert.equal(centsToDecimal(1), '0.01');
    assert.equal(centsToDecimal(1050), '10.50');
    assert.equal(centsToDecimal(2000000001), '20000000.01');
    for (const n of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => centsToDecimal(n), e => e.code === 'CANONICAL_PAYMENT_INVALID');
    }
  });
});
