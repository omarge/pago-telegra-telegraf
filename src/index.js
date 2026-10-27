const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const bot = require('./bot');
const { startFormServer, setBot } = require('./formServer');

setBot(bot);
const PORT = process.env.FORM_PORT || 8765;
startFormServer(PORT);

console.log('Starting KashBitPay Telegraf bot (manual polling)...');

let offset = 0;
async function poll() {
  try {
    const updates = await bot.telegram.getUpdates(offset, 30, 100, ['message', 'callback_query']);
    for (const u of updates) {
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
console.log('Polling started');

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
