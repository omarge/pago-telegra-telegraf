'use strict';

const crypto = require('node:crypto');

// Telegram Mini Apps, bot-token validation:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// This module never logs the raw initData or bot token.
class TelegramIdentityError extends Error {
  constructor() {
    super('TELEGRAM_IDENTITY_NOT_VERIFIED');
    this.name = 'TelegramIdentityError';
    this.code = 'TELEGRAM_IDENTITY_NOT_VERIFIED';
  }
}

function verifyTelegramMiniAppInitData(raw, botToken, {
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 900,
  clockSkewSeconds = 30,
} = {}) {
  if (typeof botToken !== 'string' || !botToken ||
      typeof raw !== 'string' || raw.length === 0 ||
      Buffer.byteLength(raw, 'utf8') > 8192 ||
      !Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(maxAgeSeconds) ||
      maxAgeSeconds <= 0 || maxAgeSeconds > 86400 ||
      !Number.isSafeInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 300) {
    throw new TelegramIdentityError();
  }

  const fields = new Map();
  for (const [key, value] of new URLSearchParams(raw)) {
    // Reject duplicate or ambiguous fields, including duplicate hashes.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ||
        fields.has(key) || fields.size >= 32) {
      throw new TelegramIdentityError();
    }
    fields.set(key, value);
  }

  const hash = fields.get('hash');
  if (typeof hash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hash)) {
    throw new TelegramIdentityError();
  }

  // 'signature' is for third-party Ed25519 validation, not the bot-token HMAC.
  const checkString = [...fields.entries()]
    .filter(([key]) => key !== 'hash' && key !== 'signature')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData')
    .update(botToken, 'utf8').digest();
  const expected = crypto.createHmac('sha256', secret)
    .update(checkString, 'utf8').digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) {
    throw new TelegramIdentityError();
  }

  const authDateString = fields.get('auth_date');
  if (typeof authDateString !== 'string' || !/^[1-9][0-9]{8,11}$/.test(authDateString)) {
    throw new TelegramIdentityError();
  }
  const authDate = Number(authDateString);
  if (!Number.isSafeInteger(authDate) ||
      authDate > nowSeconds + clockSkewSeconds ||
      nowSeconds - authDate > maxAgeSeconds) {
    throw new TelegramIdentityError();
  }

  let user;
  try {
    user = JSON.parse(fields.get('user'));
  } catch (_) {
    throw new TelegramIdentityError();
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new TelegramIdentityError();
  }

  // Trusted Telegram identity does not grant a BusinessOS tenant or customer mapping.
  return Object.freeze({ telegramUserId: String(user.id), authDate });
}

function requireTelegramMiniAppIdentity({ botToken, nowSeconds, maxAgeSeconds = 900 } = {}) {
  return (req, res, next) => {
    try {
      const raw = req.headers['x-telegram-init-data'];
      req.telegramIdentity = verifyTelegramMiniAppInitData(raw, botToken, {
        nowSeconds: nowSeconds === undefined ? Math.floor(Date.now() / 1000) : nowSeconds,
        maxAgeSeconds,
      });
      res.setHeader('Cache-Control', 'no-store');
      next();
    } catch (_) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ error: 'TELEGRAM_IDENTITY_NOT_VERIFIED' });
    }
  };
}

module.exports = {
  verifyTelegramMiniAppInitData,
  requireTelegramMiniAppIdentity,
  TelegramIdentityError,
};
