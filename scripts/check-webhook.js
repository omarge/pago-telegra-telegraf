#!/usr/bin/env node
require('dotenv').config();
const https = require('https');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

https.get(`https://api.telegram.org/bot${token}/getWebhookInfo`, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log(d);
  });
});
