#!/usr/bin/env node
require('dotenv').config();
const https = require('https');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

function get(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({}); }
      });
    }).on('error', () => resolve({}));
  });
}

(async () => {
  let offset = 0;
  let total = 0;
  for (let i = 0; i < 100; i++) {
    const r = await get(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=1`);
    if (!r.result || r.result.length === 0) {
      console.log('Queue empty');
      break;
    }
    const last = r.result[r.result.length - 1];
    if (!last || !last.update_id) break;
    offset = last.update_id + 1;
    total += r.result.length;
    console.log(`Cleared ${r.result.length} updates, next offset: ${offset}`);
  }
  console.log(`Done. Total cleared: ${total}. Next offset: ${offset}`);
})();
