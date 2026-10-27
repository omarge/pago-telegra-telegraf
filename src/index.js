const bot = require('./bot');
const { startFormServer } = require('./formServer');

// Default to 8765 so host1 Caddy (reverse_proxy 10.77.0.2:8765) reaches it.
const PORT = process.env.FORM_PORT || 8765;
startFormServer(PORT);

console.log('Starting KashBitPay Telegraf bot...');
bot.launch().then(() => {
  console.log('KashBitPay Telegraf bot started (polling)');
}).catch((err) => {
  console.error('Launch failed:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
