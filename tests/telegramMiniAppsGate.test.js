'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFormApp } = require('../src/formServer');

const TOKEN = '123456:only-ci-fixture';
function signedInitData() {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - 5),
    user: JSON.stringify({ id: 984321, first_name: 'Test' }),
  });
  const body = [...params.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  params.append('hash', crypto.createHmac('sha256', secret).update(body).digest('hex'));
  return params.toString();
}

describe('F01 Express Mini App identity gate + BusinessOS NO_GO', () => {
  it('blocks ALL legacy financial mutations with missing, forged or valid initData', async () => {
    const oldToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    const app = createFormApp();
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      if (server.listening) return resolve();
      server.once('listening', resolve);
      server.once('error', reject);
    });
    try {
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      const paths = ['/pay/charge', '/cards/enroll', '/nip/change'];
      const valid = signedInitData();
      for (const path of paths) {
        const options = (headers) => ({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            token_id: 'fake-token', user_id: 'attacker-id', payer_id: 'attacker-id',
            old_pin: '1234', new_pin: '0000',
          }),
        });
        const unauthenticated = await fetch(baseUrl + path, options({}));
        assert.equal(unauthenticated.status, 401, path + ' must reject unsigned requests');
        assert.equal((await unauthenticated.json()).error, 'TELEGRAM_IDENTITY_NOT_VERIFIED');
        const tampered = await fetch(baseUrl + path,
          options({ 'X-Telegram-Init-Data': valid.replace('984321', '984322') }));
        assert.equal(tampered.status, 401, path + ' must reject tampering');
        const authenticated = await fetch(baseUrl + path,
          options({ 'X-Telegram-Init-Data': valid }));
        assert.equal(authenticated.status, 503, path + ' must fail closed until BusinessOS GO');
        assert.equal((await authenticated.json()).error, 'BUSINESSOS_INTEGRATION_NOT_YET_ENABLED');
        assert.equal(authenticated.headers.get('cache-control'), 'no-store');
      }
      for (const path of ['/pay/one-time', '/cards/enroll', '/nip/change']) {
        const response = await fetch(baseUrl + path);
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.ok(html.includes('X-Telegram-Init-Data'));
        assert.ok(html.includes('tg.initData'));
        assert.ok(!html.includes('initDataUnsafe'));
        assert.ok(!html.includes("console.log('[nip] old="));
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
