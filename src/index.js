const bot = require('./bot');

bot.launch().then(() => {
  console.log('KashBitPay Telegraf bot started');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
