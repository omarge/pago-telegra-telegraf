'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  verifyTelegramMiniAppInitData,
  requireTelegramMiniAppIdentity,
} = require('../src/telegram/miniAppIdentity');

const TOKEN = '123456:integration-fixture-only';
const NOW = 1761690000;

function signed(fields, token = TOKEN) {
  const encoded = new URLSearchParams(fields);
  const dataCheckString = [...encoded.entries()]
    .filter(([key]) => key !== 'hash' && key !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secret = crypto.createHmac('sha256', Buffer.from('WebAppData'))
    .update(Buffer.from(token)).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  encoded.append('hash', hash);
  return encoded.toString();
}

const fresh = (extra = {}) => ({
  auth_date: String(NOW - 10),
  query_id: 'AA123',
  user: JSON.stringify({ id: 777001, username: 'test-user' }),
  ...extra,
});
const verify = (raw, opts = {}) =>
  verifyTelegramMiniAppInitData(raw, TOKEN, { nowSeconds: NOW, ...opts });

function unauthorized(raw, token = TOKEN) {
  assert.throws(() =>
    verifyTelegramMiniAppInitData(raw, token, { nowSeconds: NOW }),
    (error) => error.code === 'TELEGRAM_IDENTITY_NOT_VERIFIED');
}

describe('F01 signed Telegram Mini App identity (no external connections)', () => {
  it('validates a signed actor and uses minimal immutable claims', () => {
    const actor = verify(signed(fresh()));
    assert.deepEqual(actor, { telegramUserId: '777001', authDate: NOW - 10 });
    assert.equal(Object.isFrozen(actor), true);
    assert.equal(Object.hasOwn(actor, 'username'), false);
  });

  it('accepts Telegram third-party signature field without treating it as HMAC input', () => {
    assert.equal(verify(signed(fresh({ signature: 'ed25519-data' }))).telegramUserId, '777001');
  });

  it('rejects fabricated and modified identities', () => {
    const raw = signed(fresh());
    unauthorized(raw.replace('777001', '777002'));
    unauthorized(raw, 'different-bot-token');
    unauthorized(new URLSearchParams(fresh()).toString());
  });

  it('rejects stale and future-dated credentials', () => {
    unauthorized(signed(fresh({ auth_date: String(NOW - 901) })));
    unauthorized(signed(fresh({ auth_date: String(NOW + 31) })));
    assert.equal(verify(signed(fresh({ auth_date: String(NOW - 900) }))).telegramUserId, '777001');
  });

  it('rejects duplicates and malformed hashes', () => {
    const raw = signed(fresh());
    unauthorized(raw + '&hash=' + '0'.repeat(64));
    unauthorized(raw + '&user=%7B%22id%22%3A1%7D');
    unauthorized(raw.replace(/hash=[^&]+/, 'hash=bogus'));
  });

  it('requires a valid, signed user id and protected time settings', () => {
    unauthorized(signed(fresh({ user: '{"id":"777001"}' })));
    unauthorized(signed(fresh({ user: 'invalid-json' })));
    assert.throws(() => verify(signed(fresh()), { maxAgeSeconds: 0 }));
    assert.throws(() => verify(signed(fresh()), { maxAgeSeconds: 86401 }));
    unauthorized('x'.repeat(8193));
  });

  it('returns 401 fail-closed before the handler when identity is absent or tampered', () => {
    let nextCalls = 0;
    const middleware = requireTelegramMiniAppIdentity({ botToken: TOKEN, nowSeconds: NOW });
    const response = () => {
      const r = { statusCode: null, body: null, headers: {} };
      r.setHeader = (k, v) => { r.headers[k] = v; };
      r.status = (code) => { r.statusCode = code; return r; };
      r.json = (body) => { r.body = body; return r; };
      return r;
    };
    const noHeader = { headers: {} };
    const res1 = response();
    middleware(noHeader, res1, () => nextCalls++);
    assert.equal(res1.statusCode, 401);
    assert.equal(nextCalls, 0);
    assert.equal(res1.headers['Cache-Control'], 'no-store');

    const validReq = { headers: { 'x-telegram-init-data': signed(fresh()) } };
    middleware(validReq, response(), () => nextCalls++);
    assert.equal(nextCalls, 1);
    assert.equal(validReq.telegramIdentity.telegramUserId, '777001');
  });
});
