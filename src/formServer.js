const express = require('express');
const { requireTelegramMiniAppIdentity } = require('./telegram/miniAppIdentity');

// F01: these are PUBLIC Openpay.js browser configuration values only.
const MERCHANT = process.env.OPENPAY_MERCHANT_ID || '';
const PUBLIC_KEY = process.env.OPENPAY_PUBLIC_KEY || '';

function createFormApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/pay/one-time', (_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(oneTimeForm());
  });

  app.get('/cards/enroll', (_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(enrollForm());
  });

  app.get('/nip/change', (_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(nipChangeForm());
  });

  // Fail closed until BusinessOS Payment, CustomerVault and Security Engine
  // have authorized endpoints and independently validated business identities.
  // Every state-changing Mini App endpoint verifies signed Telegram initData.
  const verifyIdentity = requireTelegramMiniAppIdentity({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
  });
  for (const route of ['/pay/charge', '/cards/enroll', '/nip/change']) {
    app.post(route, verifyIdentity, (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(503).json({ error: 'BUSINESSOS_INTEGRATION_NOT_YET_ENABLED' });
    });
  }

  app.get('/healthz', (_req, res) => res.send('ok'));
  return app;
}

function startFormServer(port = 8765) {
  const app = createFormApp();
  app.listen(port, '0.0.0.0', () => {
    console.log('Form server listening on 0.0.0.0:' + port + '/pay/one-time');
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
const miniAppInitData = tg && tg.initData ? tg.initData : '';
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
  if (!miniAppInitData) { say('Abre esta microaplicación desde Telegram.'); return; }
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
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': miniAppInitData },
        body: JSON.stringify({ token_id: tokenId, holder, request_id: requestId })
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
const miniAppInitData = tg && tg.initData ? tg.initData : '';
if (tg) { tg.ready(); say('Telegram listo.'); }
if (window.OpenPay) {
  OpenPay.setId(root.dataset.mid);
  OpenPay.setApiKey(root.dataset.pk);
  OpenPay.setSandboxMode(true);
  say('Openpay.js listo.');
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!miniAppInitData) { say('Abre esta microaplicación desde Telegram.'); return; }
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
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': miniAppInitData },
      body: JSON.stringify({ token_id: tokenId, holder, last4 })
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
function say(m){ status.textContent = m; }
const tg = window.Telegram && window.Telegram.WebApp;
const miniAppInitData = tg && tg.initData ? tg.initData : '';
if (tg) { tg.ready(); say('Telegram listo.'); }
else { say('Abre desde Telegram.'); }
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const oldP = (document.getElementById('old').value || '').replace(/\D/g, '');
  const n1 = (document.getElementById('n1').value || '').replace(/\D/g, '');
  const n2 = (document.getElementById('n2').value || '').replace(/\D/g, '');
  if (n1 !== n2) { say('Los NIP nuevos no coinciden.'); return; }
  if (n1.length !== 4) { say('El NIP debe ser 4 dígitos. Recibido: ' + n1.length); return; }
  if (!miniAppInitData) { say('Abre esta microaplicación desde Telegram.'); return; }
  say('Verificando…');
  try {
    const r = await fetch('/nip/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': miniAppInitData },
      body: JSON.stringify({ old_pin: oldP, new_pin: n1 })
    });
    const j = await r.json();
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

module.exports = { createFormApp, startFormServer };
