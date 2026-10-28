'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { BusinessOsSecurityGateway } = require('../src/businessos/securityGateway');

const TOKEN = '1234567:non-production-ci-only';
const API_KEY = 'bos_svc_v1.fixture-credential';
function initData(userId = 97650001, authDate = Math.floor(Date.now() / 1000) - 5) {
  const query = new URLSearchParams({
    auth_date: String(authDate), user: JSON.stringify({ id: userId, first_name: 'CI' }),
  });
  const check = [...query.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  query.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return query.toString();
}

function createGateway(fetchImpl, options = {}) {
  return new BusinessOsSecurityGateway({
    enabled: true,
    baseUrl: 'https://security.uat.example',
    telegramBotToken: TOKEN,
    serviceCredential: API_KEY,
    identityProviderId: 'TELEGRAM:fixture-bot-id',
    targetTenantId: 'tenant-fixture',
    audience: 'KASHBIT_PAY',
    permission: 'KASHBIT_PAYMENT_REQUEST_CREATE',
    targetType: 'MERCHANT_ACCOUNT',
    serviceAudience: 'PAYMENT_ENGINE',
    servicePermission: 'PAYMENT_AUTHORIZE',
    fetchImpl,
    ...options,
  });
}
function externalAllow(overrides = {}) {
  return {
    allowed: true,
    actorId: 'canonical-actor-1',
    actorType: 'USER',
    tenantId: 'tenant-fixture',
    audience: 'KASHBIT_PAY',
    permission: 'KASHBIT_PAYMENT_REQUEST_CREATE',
    scopeType: 'TENANT',
    scopeValue: null,
    scopeTenantId: 'tenant-fixture',
    organizationId: null,
    membershipId: 'membership-1',
    decisionCode: 'ALLOW',
    reasonCode: null,
    targetType: 'MERCHANT_ACCOUNT',
    targetId: 'merchant-fixture-1',
    validatedAt: new Date().toISOString(),
    ...overrides,
  };
}
function serviceAllow(overrides = {}) {
  return {
    allowed: true,
    actorId: 'service-canonical-actor',
    actorType: 'INTEGRATION',
    tenantId: 'tenant-fixture',
    audience: 'PAYMENT_ENGINE',
    permission: 'PAYMENT_AUTHORIZE',
    scopeType: 'TENANT',
    scopeValue: null,
    scopeTenantId: 'tenant-fixture',
    decisionCode: 'ALLOW',
    reasonCode: null,
    token: 'bos_delegated_v1.fixture-only',
    ...overrides,
  };
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

describe('F03 Security Engine authority contracts, no network', () => {
  it('cannot call Security Engine without explicit enablement', async () => {
    let calls = 0;
    const gateway = new BusinessOsSecurityGateway({
      fetchImpl: async () => { calls++; throw Error('not allowed'); },
    });
    await assert.rejects(gateway.authorizeTelegramInitData(initData(), 'merchant-fixture-1'),
      e => e.code === 'SECURITY_DISABLED');
    await assert.rejects(gateway.requestServiceDelegation('merchant-fixture-1'),
      e => e.code === 'SECURITY_DISABLED');
    assert.equal(calls, 0);
  });

  it('requires HTTPS, service credential, and explicit provider namespace', () => {
    for (const changes of [
      { baseUrl: 'http://security.uat.example' },
      { baseUrl: 'https://security.uat.example/internal' },
      { serviceCredential: '' },
      { identityProviderId: '' },
      { telegramBotToken: '' },
      { targetTenantId: '' },
    ]) {
      assert.throws(() => createGateway(async () => ok(externalAllow()), changes),
        e => e.code === 'SECURITY_CONFIGURATION_INVALID');
    }
  });

  it('passes verified Telegram subject and exact flattened Security Engine contract', async () => {
    let calls = 0;
    const gateway = createGateway(async (url, options) => {
      calls++;
      assert.equal(url, 'https://security.uat.example/internal/security/v1/external-identity/authorize');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer ' + API_KEY);
      assert.deepEqual(JSON.parse(options.body), {
        identityProviderId: 'TELEGRAM:fixture-bot-id',
        externalSubject: '97650001',
        audience: 'KASHBIT_PAY',
        permission: 'KASHBIT_PAYMENT_REQUEST_CREATE',
        scopeType: 'TENANT',
        scopeValue: null,
        targetTenantId: 'tenant-fixture',
        targetType: 'MERCHANT_ACCOUNT',
        targetId: 'merchant-fixture-1',
      });
      return ok(externalAllow());
    });
    const actor = await gateway.authorizeTelegramInitData(initData(), 'merchant-fixture-1');
    assert.deepEqual(actor, {
      actorId: 'canonical-actor-1', actorType: 'USER',
      tenantId: 'tenant-fixture', membershipId: 'membership-1',
      targetType: 'MERCHANT_ACCOUNT', targetId: 'merchant-fixture-1',
    });
    assert.equal(Object.isFrozen(actor), true);
    assert.equal(Object.hasOwn(actor, 'customerId'), false);
    assert.equal(calls, 1);
  });

  it('rejects forged/stale Telegram identity BEFORE attempting HTTP', async () => {
    let calls = 0;
    const gateway = createGateway(async () => { calls++; return ok(externalAllow()); });
    const raw = initData();
    for (const bad of [raw.replace('97650001', '97650002'),
      initData(97650001, Math.floor(Date.now() / 1000) - 4000), '']) {
      await assert.rejects(gateway.authorizeTelegramInitData(bad, 'merchant-fixture-1'),
        e => e.code === 'TELEGRAM_IDENTITY_NOT_VERIFIED');
    }
    await assert.rejects(gateway.authorizeTelegramInitData(raw, ''),
      e => e.code === 'SECURITY_CONFIGURATION_INVALID');
    assert.equal(calls, 0);
  });

  it('never treats 401/403 as allow and does not retry', async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      const gateway = createGateway(async () => {
        calls++;
        return new Response('{"allowed":true}', { status });
      });
      await assert.rejects(gateway.authorizeTelegramInitData(initData(), 'merchant-fixture-1'),
        e => e.code === 'SECURITY_DENIED');
      assert.equal(calls, 1);
    }
  });

  it('maps 5xx/timeout, malformed JSON, and unrecognized HTTP to fail-closed', async () => {
    for (const fake of [
      async () => { throw new Error('network-token-leak-would-be-bad'); },
      async () => new Response('{}', { status: 503 }),
      async () => new Response('{}', { status: 429 }),
      async () => new Response('{', { status: 200 }),
    ]) {
      let calls = 0;
      const gateway = createGateway(async (...args) => { calls++; return fake(...args); });
      await assert.rejects(gateway.authorizeTelegramInitData(initData(), 'merchant-fixture-1'),
        e => ['SECURITY_UNAVAILABLE', 'SECURITY_RESPONSE_INVALID'].includes(e.code) &&
          !e.message.includes(API_KEY));
      assert.equal(calls, 1);
    }
  });

  it('rejects impersonation, tenant confusion and target substitution in HTTP 200', async () => {
    const substitutions = [
      { allowed: false }, { actorType: 'INTEGRATION' },
      { tenantId: 'other-tenant' }, { scopeTenantId: 'other-tenant' },
      { audience: 'WRONG' }, { permission: 'WRONG' },
      { targetId: 'wrong-merchant' }, { targetType: 'WRONG' },
      { scopeValue: '' }, { decisionCode: 'DENY' }, { reasonCode: 'some-reason' },
      { membershipId: null }, { organizationId: 'invented-org' },
      { validatedAt: 'broken' },
    ];
    for (const patch of substitutions) {
      const gateway = createGateway(async () => ok(externalAllow(patch)));
      await assert.rejects(
        gateway.authorizeTelegramInitData(initData(), 'merchant-fixture-1'),
        e => e.code === 'SECURITY_RESPONSE_INVALID', JSON.stringify(patch));
    }
  });

  it('requests actual service delegation with separate payment permission and returns opaque bearer', async () => {
    const gateway = createGateway(async (url, options) => {
      assert.equal(url, 'https://security.uat.example/internal/security/v1/service/authorize');
      assert.deepEqual(JSON.parse(options.body), {
        targetTenantId: 'tenant-fixture', audience: 'PAYMENT_ENGINE',
        permission: 'PAYMENT_AUTHORIZE', scopeType: 'TENANT', scopeValue: null,
        scopeTenantId: 'tenant-fixture', targetType: 'MERCHANT_ACCOUNT',
        targetId: 'merchant-fixture-1',
      });
      return ok(serviceAllow());
    });
    const result = await gateway.requestServiceDelegation('merchant-fixture-1');
    assert.equal(result.delegatedBearerToken, 'bos_delegated_v1.fixture-only');
    assert.equal(result.tenantId, 'tenant-fixture');
    assert.equal(Object.isFrozen(result), true);
  });

  it('rejects malformed delegated authority and never fabricates a bearer', async () => {
    for (const patch of [
      { token: null }, { token: '' }, { allowed: false },
      { audience: 'OTHER' }, { permission: 'OTHER' },
      { scopeValue: '' }, { tenantId: 'OTHER' }, { decisionCode: 'DENY' },
    ]) {
      const gateway = createGateway(async () => ok(serviceAllow(patch)));
      await assert.rejects(gateway.requestServiceDelegation('merchant-fixture-1'),
        e => e.code === 'SECURITY_RESPONSE_INVALID');
    }
  });
});
