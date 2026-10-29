const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const https = require('https');
const bot = require('./bot');
const { startFormServer, setBot } = require('./formServer');

setBot(bot);
const PORT = process.env.FORM_PORT || 8765;
// The auth endpoint is disabled unless both durable PostgreSQL and tenant
// configuration exist. Database migrations are applied separately.
let webSessions=null,paymentGate=null,pinService=null;
if (process.env.DATABASE_URL && process.env.KASHBIT_TENANT_ID) {
  const {Pool}=require('pg');
  const {createPgWebSession}=require('./pgWebSession');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5});
  webSessions=createPgWebSession({pool});
  const {createPgPaymentGate}=require('./pgPaymentGate');
  paymentGate=createPgPaymentGate(pool);
  if(process.env.KASHBIT_PIN_PEPPER){
    const {createPgPinService}=require('./pgPinService');
    pinService=createPgPinService({pool});
  }
}
startFormServer(PORT,{webSessions,paymentGate,pinService,tenant:process.env.KASHBIT_TENANT_ID});

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
  try {
    const r = await getUpdates(-1);
    if (r.result && r.result.length > 0) {
      offset = r.result[r.result.length - 1].update_id + 1;
      console.log('Dropped pending, starting from', offset);
    } else {
      console.log('No pending updates');
    }
  } catch (e) {
    console.log('drop error:', e.message);
  }

  async function poll() {
    try {
      const r = await getUpdates(offset);
      if (r.result) {
        for (const u of r.result) {
          offset = u.update_id + 1;
          bot.handleUpdate(u);
        }
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
