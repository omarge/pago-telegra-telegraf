const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const https = require('https');
const bot = require('./bot');
const { startFormServer } = require('./formServer');
const { processTelegramUpdatesInOrder } = require('./telegram/processUpdates');

const PORT = process.env.FORM_PORT || 8765;
startFormServer(PORT);

console.log('Starting KashBitPay Telegraf bot...');

const token = process.env.TELEGRAM_BOT_TOKEN;

function getUpdates(offset) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message","callback_query"]`;
    https.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  let offset = 0;
  // Never discard unacknowledged updates on startup. Telegram retains them
  // until a subsequent getUpdates(offset) confirms a processed delivery.
  console.log('Polling will preserve pending Telegram updates');

  async function poll() {
    try {
      const r = await getUpdates(offset);
      if (!r || r.ok !== true || !Array.isArray(r.result)) {
        throw new Error('Invalid Telegram getUpdates response');
      }
      await processTelegramUpdatesInOrder(
        r.result,
        (update) => bot.handleUpdate(update),
        offset,
        (processedOffset) => { offset = processedOffset; }
      );
    } catch (e) {
      console.error('poll error:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
    setImmediate(poll);
  }
  poll();
  console.log('Polling started from offset', offset);
})();

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
