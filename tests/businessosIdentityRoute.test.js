'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFormApp } = require('../src/formServer');

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    return await fn('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
const post = (base, data, body = {}) => fetch(base + '/api/businessos/identity-check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': data },
  body: JSON.stringify(body),
});

describe('F03 Express BusinessOS read-only identity check', () => {
  it('is 503 by default and makes no Security Engine requests', async () => {
    const previous = process.env.BUSINESSOS_SECURITY_ENABLED;
    delete process.env.BUSINESSOS_SECURITY_ENABLED;
    let called = 0;
    try {
      await withServer(createFormApp({ securityGateway: {
        authorizeTelegramInitData: async () => { called++; },
      } }), async base => {
        const r = await post(base, 'unsigned', {targetId: 'attacker'});
        assert.equal(r.status, 503);
        assert.deepEqual(await r.json(), { error: 'BUSINESSOS_IDENTITY_NOT_ENABLED' });
        assert.equal(r.headers.get('cache-control'), 'no-store');
      });
    } finally {
      if (previous === undefined) delete process.env.BUSINESSOS_SECURITY_ENABLED;
      else process.env.BUSINESSOS_SECURITY_ENABLED = previous;
    }
    assert.equal(called, 0);
  });

  it('uses only server-owned target and never exposes tenant/actor/delegated authority', async () => {
    const before = {
      enabled: process.env.BUSINESSOS_SECURITY_ENABLED,
      target: process.env.BUSINESSOS_SECURITY_TARGET_ID,
    };
    process.env.BUSINESSOS_SECURITY_ENABLED = 'true';
    process.env.BUSINESSOS_SECURITY_TARGET_ID = 'merchant-server-owned';
    const argumentsSeen = [];
    try {
      const app = createFormApp({ securityGateway: {
        authorizeTelegramInitData: async (...args) => {
          argumentsSeen.push(args);
          return { actorId: 'private-actor', tenantId: 'private-tenant',
            delegatedBearerToken: 'must-never-leak' };
        },
      } });
      await withServer(app, async base => {
        const r = await post(base, 'signed-telegram-opaque-fixture', {
          targetId: 'merchant-attacker', targetTenantId: 'tenant-attacker',
          actorId: 'actor-attacker', customerId: 'customer-attacker',
        });
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.deepEqual(body, { authorized: true });
        assert.ok(!JSON.stringify(body).includes('private'));
        assert.equal(r.headers.get('cache-control'), 'no-store');
      });
      assert.deepEqual(argumentsSeen, [['signed-telegram-opaque-fixture', 'merchant-server-owned']]);
    } finally {
      if (before.enabled === undefined) delete process.env.BUSINESSOS_SECURITY_ENABLED;
      else process.env.BUSINESSOS_SECURITY_ENABLED = before.enabled;
      if (before.target === undefined) delete process.env.BUSINESSOS_SECURITY_TARGET_ID;
      else process.env.BUSINESSOS_SECURITY_TARGET_ID = before.target;
    }
  });

  it('maps invalid identity, denied authorization and outage to 401/403/503', async () => {
    const before = {
      enabled: process.env.BUSINESSOS_SECURITY_ENABLED,
      target: process.env.BUSINESSOS_SECURITY_TARGET_ID,
    };
    process.env.BUSINESSOS_SECURITY_ENABLED = 'true';
    process.env.BUSINESSOS_SECURITY_TARGET_ID = 'merchant-server-owned';
    try {
      for (const [code, status] of [
        ['TELEGRAM_IDENTITY_NOT_VERIFIED', 401],
        ['SECURITY_DENIED', 403],
        ['SECURITY_UNAVAILABLE', 503],
      ]) {
        const app = createFormApp({ securityGateway: {
          authorizeTelegramInitData: async () => { throw Object.assign(new Error('secret'), { code }); },
        } });
        await withServer(app, async base => {
          const r = await post(base, 'fixture');
          assert.equal(r.status, status);
          assert.deepEqual(await r.json(), { authorized: false });
          assert.equal(r.headers.get('cache-control'), 'no-store');
        });
      }
    } finally {
      if (before.enabled === undefined) delete process.env.BUSINESSOS_SECURITY_ENABLED;
      else process.env.BUSINESSOS_SECURITY_ENABLED = before.enabled;
      if (before.target === undefined) delete process.env.BUSINESSOS_SECURITY_TARGET_ID;
      else process.env.BUSINESSOS_SECURITY_TARGET_ID = before.target;
    }
  });
});
