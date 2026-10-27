const bot = require('./bot');
const { startFormServer, setBot } = require('./formServer');

setBot(bot);
const PORT = process.env.FORM_PORT || 8765;
startFormServer(PORT);

console.log('Starting KashBitPay Telegraf bot...');
let launched = false;
bot.launch({
  dropPendingUpdates: true,
  allowedUpdates: ['message', 'callback_query'],
}).then(() => {
  launched = true;
  console.log('KashBitPay Telegraf bot started (polling)');
}).catch((err) => {
  console.error('Launch failed:', err);
  process.exit(1);
});

function shutdown(sig) {
  console.log('Stopping', sig);
  if (launched) {
    bot.stop(sig);
  } else {
    process.exit(0);
  }
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
