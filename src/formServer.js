const express = require('express');
const https = require('https');
const store = require('./store');
const {verifyTelegramInitData}=require('./telegramWebAuth');

const MERCHANT = process.env.OPENPAY_MERCHANT_ID || '';
const PRIVATE_KEY = process.env.OPENPAY_PRIVATE_KEY || '';
const PUBLIC_KEY = process.env.OPENPAY_PUBLIC_KEY || '';

let botInstance = null;

function setBot(bot) {
  botInstance = bot;
}

function startFormServer(port = 8765, {webSessions=null, paymentGate=null, pinService=null, tenant=process.env.KASHBIT_TENANT_ID, publicOrigin=process.env.FORM_PUBLIC_ORIGIN} = {}) {
  const app = express();
  app.use(express.json());

  // Do not render a legacy credential-capture form without authenticated
  // Telegram initData and a server-side session bound to the payment request.
  for (const route of ['/pay/one-time', '/cards/enroll', '/nip/change']) {
    app.get(route, (_req,res) => res.status(503).send('Formulario temporalmente no disponible: autenticación requerida.'));
  }

  // Read-only authentication exchange. No PIN data, financial authorization,
  // session issuance, card token, or PSP call is performed here.
  app.post('/pay/auth/telegram', async (req,res) => {
    try {
      const verified=verifyTelegramInitData(req.body?.initData,process.env.TELEGRAM_BOT_TOKEN);
      if (!webSessions || typeof tenant!=='string' || !tenant) {
        return res.status(503).json({code:'SESSION_SERVICE_UNAVAILABLE'});
      }
      const session=await webSessions.issue({tenant,actorId:verified.actorId});
      res.set('Cache-Control','no-store');
      res.cookie('kashbit_tg_session',session.token,{
        httpOnly:true,secure:true,sameSite:'strict',path:'/pay',maxAge:session.expiresIn*1000
      });
      return res.json({authenticated:true,expiresIn:session.expiresIn});
    } catch (_) {
      return res.status(401).json({code:'TELEGRAM_AUTH_INVALID'});
    }
  });

  // Session identity comes ONLY from the server-issued cookie, never request body.
  // Exact Origin and JSON content-type are mandatory for state-changing requests.
  app.post('/pay/consent/verify-pin', async (req,res) => {
    res.set('Cache-Control','no-store');
    const expected=typeof publicOrigin==='string'?publicOrigin.replace(/\\/$/,''):null;
    if(!expected || req.get('origin')!==expected || !/^application\\/json(?:;|$)/i.test(req.get('content-type')||''))
      return res.status(403).json({code:'ORIGIN_DENIED'});
    if(!webSessions||!paymentGate||!pinService||!tenant)
      return res.status(503).json({code:'SECURE_CONSENT_UNAVAILABLE'});
    const cookie=(req.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('kashbit_tg_session='));
    const token=cookie?cookie.slice('kashbit_tg_session='.length):null;
    try {
      const session=await webSessions.requireSession({tenant,token});
      if(!session)return res.status(401).json({code:'SESSION_INVALID'});
      const operationId=req.body?.operationId, pin=req.body?.pin;
      if(typeof operationId!=='string'||!/^[-_A-Za-z0-9]{8,128}$/.test(operationId)||
         typeof pin!=='string'||!/^\\d{4}$/.test(pin))
        return res.status(400).json({code:'CONSENT_INPUT_INVALID'});
      const outcome=await paymentGate.confirmWithVerifiedPin({
        tenant,operationId,actorId:session.actorId,pin,
        verifyPin:args=>pinService.verify(args)
      });
      return res.status(outcome.state==='AUTHORIZED'?200:403).json({
        state:outcome.state
      });
    } catch (_) {
      return res.status(503).json({code:'CONSENT_UNAVAILABLE'});
    }
  });

  // Security hold: legacy unauthenticated financial and enrollment routes must
  // never make PSP calls, store raw tokens or accept caller-selected identity.
  for (const route of ['/pay/charge', '/cards/enroll', '/nip/change']) {
    app.post(route, (_req, res) => res.status(503).json({
      code: 'SECURE_AUTHORIZATION_REQUIRED',
      message: 'Operación deshabilitada hasta contar con autenticación HTTPS y autorización financiera.'
    }));
  }

  app.get('/healthz', (_req, res) => res.send('ok'));

  return app.listen(port, '0.0.0.0', () => {
    console.log(`Form server listening on 0.0.0.0:${port}/pay/one-time`);
  });
}

async function notifyPaid(bot, rid, payerId, chargeId, amount) {
  const req = store.getRequest(rid);
  const amountText = (amount / 100).toFixed(2) + ' MXN';
  const msg =
    `✅ <b>Pago completado</b>\n` +
    `Solicitud: <code>${rid}</code>\n` +
    `Importe: ${amountText}\n` +
    `Rastreo Openpay: <code>${chargeId}</code>`;
  try {
    await bot.telegram.sendMessage(payerId, msg, { parse_mode: 'HTML' });
  } catch (_) {}
  if (req && req.requesterId) {
    try {
      await bot.telegram.sendMessage(req.requesterId, msg, { parse_mode: 'HTML' });
    } catch (_) {}
  }
  store.setState(rid, 'PAID');
}

function openpayCharge(tokenId, amountCents, holder) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      source_id: tokenId,
      method: 'card',
      amount: amountCents / 100,
      currency: 'MXN',
      description: 'KashBitPay Sandbox',
      device_session_id: 'kashbit-demo',
      customer: {
        name: (holder || 'Cliente').split(' ')[0] || 'Cliente',
        last_name: (holder || 'Prueba').split(' ').slice(1).join(' ') || 'Prueba',
        email: 'test@kashbit.bond',
        phone_number: '5555555555',
      },
    });
    const auth = Buffer.from(PRIVATE_KEY + ':').toString('base64');
    const opts = {
      hostname: 'sandbox-api.openpay.mx',
      path: `/v1/${MERCHANT}/charges`,
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (r.statusCode >= 200 && r.statusCode < 300) resolve(j);
          else reject(new Error(j.description || j.error_code || 'openpay ' + r.statusCode));
        } catch (e) {
          reject(new Error('bad response'));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function oneTimeForm() {
  const pk = PUBLIC_KEY || 'pk_test_placeholder';
  const mid = MERCHANT || 'merchant_placeholder';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago único · Sandbox</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://js.openpay.mx/openpay.v1.min.js"></script>
<script src="https://js.openpay.mx/openpay-data.v1.min.js"></script>
<style>
body{font:16px system-ui;background:#f3f5f8;padding:16px;color:#183044}
main{max-width:450px;margin:auto;background:white;padding:24px;border-radius:14px}
label{display:block;margin-top:14px}input{box-sizing:border-box;width:100%;padding:12px}
button{margin-top:20px;padding:14px;width:100%;border:0;border-radius:8px;background:#126b70;color:white}
#status{white-space:pre-wrap;margin-top:12px}
</style></head><body><main data-mid="${mid}" data-pk="${pk}">
<h2>Pago único · Sandbox</h2>
<p>Importe: <strong>$10.00 MXN</strong></p>
<p id="status">Cargando…</p>
<form id="payment" autocomplete="off">
<label>Titular<input id="holder" required maxlength="80" autocomplete="off"></label>
<label>Número de tarjeta de prueba<input id="pan" required inputmode="numeric" autocomplete="off"></label>
<label>Mes<input id="month" required inputmode="numeric" placeholder="MM" maxlength="2"></label>
<label>Año<input id="year" required inputmode="numeric" placeholder="AA" maxlength="2"></label>
<label>CVV de prueba<input id="cvv" required inputmode="numeric" autocomplete="off" maxlength="4"></label>
<button type="submit">Tokenizar y cobrar</button>
</form>
<script>
const status = document.getElementById('status');
const form = document.getElementById('payment');
const root = document.querySelector('main');
function say(m){ status.textContent = m; console.log('[form]', m); }
const tg = window.Telegram && window.Telegram.WebApp;
const params = new URLSearchParams(location.search);
const requestId = params.get('rid') || '';
const payerId = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : '';
if (tg) { tg.ready(); say('Telegram listo.'); }
else { say('Abre desde Telegram.'); }
if (window.OpenPay) {
  OpenPay.setId(root.dataset.mid);
  OpenPay.setApiKey(root.dataset.pk);
  OpenPay.setSandboxMode(true);
  say('Openpay.js listo.');
} else { say('Openpay.js no cargó.'); }
form.addEventListener('submit', (e) => {
  e.preventDefault();
  say('Tokenizando…');
  const holder = document.getElementById('holder').value;
  const pan = document.getElementById('pan').value;
  const details = {
    holder_name: holder,
    card_number: pan,
    expiration_month: document.getElementById('month').value,
    expiration_year: document.getElementById('year').value,
    cvv2: document.getElementById('cvv').value
  };
  document.getElementById('pan').value = '';
  document.getElementById('cvv').value = '';
  OpenPay.token.create(details, async (resp) => {
    const tokenId = resp && resp.data && resp.data.id;
    if (!tokenId) { say('Openpay no devolvió token'); return; }
    say('Token: ' + tokenId + ' \u2014 cobrando…');
    try {
      const r = await fetch('/pay/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_id: tokenId, amount: 1000, holder, request_id: requestId, payer_id: payerId })
      });
      const j = await r.json();
      if (j.ok) {
        say('Pago completado. Cerrando…');
        if (tg) { setTimeout(() => tg.close(), 800); }
      } else say('Error: ' + (j.error || r.status));
    } catch (err) { say('Fetch error: ' + err.message); }
  }, (err) => {
    say('Tokenización rechazada: ' + (err && err.data && err.data.error_code || 'error'));
  });
});
</script></main></body></html>`;
}

function enrollForm() {
  const pk = PUBLIC_KEY || 'pk_test_placeholder';
  const mid = MERCHANT || 'merchant_placeholder';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Guardar tarjeta · Sandbox</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://js.openpay.mx/openpay.v1.min.js"></script>
<style>
body{font:16px system-ui;background:#f3f5f8;padding:16px;color:#183044}
main{max-width:450px;margin:auto;background:white;padding:24px;border-radius:14px}
label{display:block;margin-top:14px}input{box-sizing:border-box;width:100%;padding:12px}
button{margin-top:20px;padding:14px;width:100%;border:0;border-radius:8px;background:#126b70;color:white}
#status{white-space:pre-wrap;margin-top:12px}
</style></head><body><main data-mid="${mid}" data-pk="${pk}">
<h2>Guardar tarjeta</h2>
<p id="status">Cargando…</p>
<form id="enroll" autocomplete="off">
<label>Titular<input id="holder" required maxlength="80"></label>
<label>Número de tarjeta<input id="pan" required inputmode="numeric"></label>
<label>Mes<input id="month" required inputmode="numeric" placeholder="MM" maxlength="2"></label>
<label>Año<input id="year" required inputmode="numeric" placeholder="AA" maxlength="2"></label>
<label>CVV<input id="cvv" required inputmode="numeric" maxlength="4"></label>
<button type="submit">Guardar tarjeta</button>
</form>
<script>
const status = document.getElementById('status');
const form = document.getElementById('enroll');
const root = document.querySelector('main');
function say(m){ status.textContent = m; }
const tg = window.Telegram && window.Telegram.WebApp;
const userId = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? String(tg.initDataUnsafe.user.id) : '';
if (tg) { tg.ready(); say('Telegram listo.'); }
if (window.OpenPay) {
  OpenPay.setId(root.dataset.mid);
  OpenPay.setApiKey(root.dataset.pk);
  OpenPay.setSandboxMode(true);
  say('Openpay.js listo.');
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  say('Tokenizando…');
  const holder = document.getElementById('holder').value;
  const pan = document.getElementById('pan').value;
  const last4 = pan.slice(-4);
  const details = {
    holder_name: holder,
    card_number: pan,
    expiration_month: document.getElementById('month').value,
    expiration_year: document.getElementById('year').value,
    cvv2: document.getElementById('cvv').value
  };
  document.getElementById('pan').value = '';
  document.getElementById('cvv').value = '';
  OpenPay.token.create(details, async (resp) => {
    const tokenId = resp && resp.data && resp.data.id;
    if (!tokenId) { say('No se obtuvo token'); return; }
    say('Guardando…');
    const r = await fetch('/cards/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_id: tokenId, holder, last4, user_id: userId })
    });
    const j = await r.json();
    if (j.ok) {
      say('Tarjeta •••• ' + last4 + ' guardada. Cerrando…');
      if (tg) setTimeout(() => tg.close(), 800);
    } else say('Error: ' + (j.error || r.status));
  }, (err) => {
    say('Tokenización rechazada');
  });
});
</script></main></body></html>`;
}

function nipChangeForm() {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cambiar NIP</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
body{font:16px system-ui;background:#f3f5f8;padding:16px;color:#183044}
main{max-width:450px;margin:auto;background:white;padding:24px;border-radius:14px}
label{display:block;margin-top:14px}input{box-sizing:border-box;width:100%;padding:12px}
button{margin-top:20px;padding:14px;width:100%;border:0;border-radius:8px;background:#126b70;color:white}
#status{white-space:pre-wrap;margin-top:12px}
</style></head><body><main>
<h2>Cambiar NIP</h2>
<p id="status">Cargando…</p>
<form id="nipform" autocomplete="off">
<label>NIP actual<input id="old" type="password" inputmode="numeric" maxlength="4" required></label>
<label>NIP nuevo<input id="n1" type="password" inputmode="numeric" maxlength="4" required></label>
<label>Confirmar NIP nuevo<input id="n2" type="password" inputmode="numeric" maxlength="4" required></label>
<button type="submit">Cambiar NIP</button>
</form>
<script>
const status = document.getElementById('status');
const form = document.getElementById('nipform');
function say(m){ status.textContent = m; console.log('[nip]', m); }
const tg = window.Telegram && window.Telegram.WebApp;
const userId = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? String(tg.initDataUnsafe.user.id) : '';
if (tg) { tg.ready(); say('Telegram listo. user=' + userId); }
else { say('Abre desde Telegram.'); }
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const oldP = (document.getElementById('old').value || '').replace(/\D/g, '');
  const n1 = (document.getElementById('n1').value || '').replace(/\D/g, '');
  const n2 = (document.getElementById('n2').value || '').replace(/\D/g, '');
  console.log('[nip] old=', oldP, 'n1=', n1, 'n2=', n2, 'user=', userId);
  if (n1 !== n2) { say('Los NIP nuevos no coinciden.'); return; }
  if (n1.length !== 4) { say('El NIP debe ser 4 dígitos. Recibido: ' + n1.length); return; }
  if (!userId) { say('No se detectó usuario de Telegram.'); return; }
  say('Verificando…');
  try {
    const r = await fetch('/nip/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, old_pin: oldP, new_pin: n1 })
    });
    const j = await r.json();
    console.log('[nip] response', j);
    if (j.ok) {
      say('NIP actualizado. Cerrando…');
      if (tg) setTimeout(() => tg.close(), 800);
    } else say('Error: ' + (j.error || r.status));
  } catch (err) {
    say('Error de red: ' + err.message);
  }
});
</script></main></body></html>`;
}

module.exports = { startFormServer, setBot };
