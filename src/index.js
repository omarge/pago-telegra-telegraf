const bot = require('./bot');

console.log('Starting KashBitPay Telegraf bot...');
bot.launch().then(() => {
  console.log('KashBitPay Telegraf bot started (polling)');
}).catch((err) => {
  console.error('Launch failed:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
