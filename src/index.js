const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const https = require('https');
const bot = require('./bot');
const { startFormServer } = require('./formServer');
const { processTelegramUpdatesInOrder } = require('./telegram/processUpdates');
const { PostgresTelegramInbox } = require('./telegram/postgresInbox');
const { PostgresTelegramOutbox } = require('./telegram/postgresOutbox');
const { PostgresDemoInviteAuthority } = require('./telegram/postgresDemoInvites');
const { createUatCommandHandler } = require('./telegram/uatCommandHandler');
const { usernameValid } = require('./telegram/demoLinkPolicy');
const { runOutboxDispatcher } = require('./telegram/outboxDispatcher');
const { runDurableTelegram } = require('./telegram/durableTransport');

const mode = process.env.TELEGRAM_DELIVERY_MODE || 'legacy';
if (!['legacy','durable-uat'].includes(mode)) {
  throw new Error('TELEGRAM_DELIVERY_MODE_INVALID');
}
if (mode === 'durable-uat' && (
  process.env.NODE_ENV === 'production' ||
  process.env.KASHBIT_INTEGRATION_UAT_ACK !== 'YES_ISOLATED_UAT' ||
  process.env.KASHBIT_FINANCIAL_GO === 'true' ||
  !process.env.TELEGRAM_INBOX_DATABASE_URL ||
  !process.env.TELEGRAM_INBOX_KEY_HEX)) {
  throw new Error('DURABLE_TELEGRAM_UAT_NOT_AUTHORIZED');
}

const demoInvitesEnabled = process.env.TELEGRAM_DEMO_INVITES_ENABLED === 'true';
const demoLinksEnabled = process.env.TELEGRAM_DEMO_LINKS_ENABLED === 'true';
if (demoInvitesEnabled && (
  mode !== 'durable-uat' || !process.env.TELEGRAM_DEMO_INVITE_KEY_HEX)) {
  throw new Error('UAT_DEMO_INVITES_NOT_AUTHORIZED');
}
const senderEnabled = process.env.TELEGRAM_OUTBOX_SENDER_ENABLED === 'true';
if (senderEnabled && (
  mode !== 'durable-uat' ||
  process.env.KASHBIT_OUTBOX_UAT_ACK !== 'YES_ISOLATED_UAT_TELEGRAM_SEND')) {
  throw new Error('UAT_TELEGRAM_OUTBOUND_NOT_AUTHORIZED');
}
if(demoLinksEnabled && (
  mode!=='durable-uat' || !demoInvitesEnabled || !senderEnabled ||
  process.env.KASHBIT_DEMO_LINKS_UAT_ACK!=='YES_DEMO_LINKS_NO_PAYMENT' ||
  !usernameValid(process.env.TELEGRAM_UAT_BOT_USERNAME))) {
  throw new Error('UAT_DEMO_LINKS_NOT_AUTHORIZED');
}
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED');
const PORT = process.env.FORM_PORT || 8765;
const formServer = startFormServer(PORT);

function getUpdates(offset) {
  return new Promise((resolve, reject) => {
    // Reuse the existing Telegram GET transport. Log only fixed failure codes:
    // Telegram errors and request URL may embed the bot token.
    const url = 'https://api.telegram.org/bot' + token + '/getUpdates?offset=' +
      offset + '&timeout=30&allowed_updates=["message","callback_query"]';
    https.get(url, (res) => {
      let d = '';
      res.on('data', c => {
        d += c;
        if (d.length > 1048576) {
          res.destroy(new Error('TELEGRAM_RESPONSE_TOO_LARGE'));
        }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (_) {
          reject(new Error('TELEGRAM_RESPONSE_INVALID'));
        }
      });
      res.on('error', () => reject(new Error('TELEGRAM_TRANSPORT_FAILED')));
    }).on('error', () => reject(new Error('TELEGRAM_TRANSPORT_FAILED')));
  });
}

async function runLegacyPolling() {
  let offset = 0;
  // Legacy is at-least-once, not durable. Never discard pending updates.
  console.log('Legacy polling preserving pending updates (NO_GO for finance)');
  while (true) {
    try {
      const r = await getUpdates(offset);
      if (!r || r.ok !== true || !Array.isArray(r.result)) {
        throw new Error('TELEGRAM_RESPONSE_INVALID');
      }
      await processTelegramUpdatesInOrder(
        r.result, update => bot.handleUpdate(update), offset,
        processedOffset => { offset = processedOffset; }
      );
    } catch (_) {
      console.error('TELEGRAM_LEGACY_POLL_FAILED');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

async function runUatDurablePolling(signal) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.TELEGRAM_INBOX_DATABASE_URL,
    max: 12,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
  });
  try {
    const inbox = new PostgresTelegramInbox({
      enabled: true, pool,
      encryptionKeyHex: process.env.TELEGRAM_INBOX_KEY_HEX,
    });
    const outbox = new PostgresTelegramOutbox({
      enabled: true, pool,
      encryptionKeyHex: process.env.TELEGRAM_INBOX_KEY_HEX,
    });
    const demoInvites = demoInvitesEnabled
      ? new PostgresDemoInviteAuthority({
          enabled:true,pool,
          tokenKeyHex:process.env.TELEGRAM_DEMO_INVITE_KEY_HEX,
        })
      : null;
    const handleUpdate = createUatCommandHandler({
      outbox,demoInvites,linksEnabled:demoLinksEnabled,
      telegramBotUsername:process.env.TELEGRAM_UAT_BOT_USERNAME,
    });
    if (!senderEnabled) {
      await runDurableTelegram({pool, inbox, getUpdates, signal, handleUpdate});
    } else {
      // Only a separately acknowledged isolated UAT may send actual Telegram
      // messages; never enable automatically from mere inbox activation.
      const halt = new AbortController();
      const stop = () => halt.abort();
      signal?.addEventListener('abort',stop,{once:true});
      if (signal?.aborted) stop();
      try {
        const tasks = [
          runDurableTelegram({
            pool,inbox,getUpdates,handleUpdate,signal:halt.signal,
          }).catch(e=>{stop();throw e;}),
          runOutboxDispatcher({
            outbox,demoInvites,linksEnabled:demoLinksEnabled,
            telegramBotUsername:process.env.TELEGRAM_UAT_BOT_USERNAME,
            sendMessage:(chatId,text)=>bot.telegram.sendMessage(chatId,text),
            signal:halt.signal,
          }).catch(e=>{stop();throw e;}),
        ];
        const outcomes = await Promise.allSettled(tasks);
        const failed = outcomes.find(x=>x.status==='rejected');
        if (failed) throw failed.reason;
      } finally {
        stop();
        signal?.removeEventListener('abort',stop);
      }
    }
  } finally {
    await pool.end();
  }
}

console.log('Starting KashBitPay Telegraf bot (delivery=' + mode + ')');
if (mode === 'durable-uat') {
  // Only an explicitly acknowledged isolated UAT may enable this. PostgreSQL
  // migrations and credentials MUST be provisioned externally.
  const stop = new AbortController();
  const task = runUatDurablePolling(stop.signal);
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    stop.abort();
    // Stop accepting HTTP requests while existing Telegram handler finishes.
    formServer.close(() => {});
    task.then(() => { process.exitCode = 0; }, () => {
      console.error('DURABLE_TELEGRAM_SHUTDOWN_FAILED');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  task.catch(() => {
    if (!exiting) {
      console.error('DURABLE_TELEGRAM_DELIVERY_FAILED_CLOSED');
      shutdown();
      process.exitCode = 1;
    }
  });
} else {
  runLegacyPolling().catch(() => {
    console.error('TELEGRAM_LEGACY_POLL_TERMINATED');
    process.exit(1);
  });
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));
}
