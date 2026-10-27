const express = require('express');

function startFormServer(port = 8765) {
  const app = express();
  app.use(express.json());

  app.get('/pay/one-time', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(oneTimeForm());
  });

  app.get('/healthz', (_req, res) => res.send('ok'));

  app.listen(port, '0.0.0.0', () => {
    console.log(`Form server listening on 0.0.0.0:${port}/pay/one-time`);
  });
}

function oneTimeForm() {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago único · Sandbox</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://js.openpay.mx/openpay.v1.min.js"></script>
<style>
body{font:16px system-ui;background:#f3f5f8;padding:16px;color:#183044}
main{max-width:450px;margin:auto;background:white;padding:24px;border-radius:14px}
label{display:block;margin-top:14px}input{box-sizing:border-box;width:100%;padding:12px}
button{margin-top:20px;padding:14px;width:100%;border:0;border-radius:8px;background:#126b70;color:white}
#status{white-space:pre-wrap;margin-top:12px}
</style></head><body><main>
<h2>Pago único · Sandbox</h2>
<p>Importe: <strong>$10.00 MXN</strong></p>
<p id="status">Cargando…</p>
<form id="payment" autocomplete="off">
<label>Titular<input id="holder" required maxlength="80" autocomplete="off"></label>
<label>Número de tarjeta de prueba<input id="pan" required inputmode="numeric" autocomplete="off"></label>
<label>Mes<input id="month" required inputmode="numeric" placeholder="MM" maxlength="2"></label>
<label>Año<input id="year" required inputmode="numeric" placeholder="AA" maxlength="2"></label>
<label>CVV de prueba<input id="cvv" required inputmode="numeric" autocomplete="off" maxlength="4"></label>
<button type="submit">Tokenizar tarjeta de prueba</button>
</form>
<script>
const status = document.getElementById('status');
const form = document.getElementById('payment');
function say(m){ status.textContent = m; }
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); say('Telegram listo. Captura la tarjeta de prueba.'); }
else { say('Abre esta página desde Telegram.'); }
form.addEventListener('submit', (e) => {
  e.preventDefault();
  say('Tokenizando (demo)…');
  document.getElementById('pan').value = '';
  document.getElementById('cvv').value = '';
  setTimeout(() => say('Token demo generado. En producción aquí va Openpay.'), 500);
});
</script></main></body></html>`;
}

module.exports = { startFormServer };
