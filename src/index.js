const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const bot = require('./bot');
const { startFormServer, setBot } = require('./formServer');

setBot(bot);
const PORT = process.env.FORM_PORT || 8765;
startFormServer(PORT);

console.log('Starting KashBitPay Telegraf bot...');

const processed = new Set();

(async () => {
  let offset = 0;
  try {
    const updates = await bot.telegram.getUpdates(-1, 0, 1);
    if (updates.length > 0) {
      offset = updates[updates.length - 1].update_id + 1;
      console.log('Dropped pending updates, starting from', offset);
    } else {
      console.log('No pending updates');
    }
  } catch (e) {
    console.log('drop error:', e.message);
  }

  async function poll() {
    try {
      const updates = await bot.telegram.getUpdates(offset, 30, 100, ['message', 'callback_query']);
      for (const u of updates) {
        if (processed.has(u.update_id)) {
          console.log('skip duplicate', u.update_id);
          continue;
        }
        processed.add(u.update_id);
        if (processed.size > 1000) {
          const first = processed.values().next().value;
          processed.delete(first);
        }
        offset = u.update_id + 1;
        bot.handleUpdate(u);
      }
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
