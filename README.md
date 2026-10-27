# pago-telegra-telegraf

KashBitPay Telegram bot in **Telegraf** (modular).

## Structure

```
src/
  index.js      entry
  bot.js        handlers (start, amount, callbacks)
  menus.js      menu projections + WebApp buttons
  store.js      invites + requests (in-memory)
  config.js     env
```

## Run

```bash
cp .env.example .env
# edit .env with TELEGRAM_BOT_TOKEN and PUBLIC_BASE_URL
npm install
npm start
```

## Flow

1. Requester `/start` → amount → invite link
2. Payer opens link → main menu
3. **Pagar con nueva tarjeta** → WebApp opens `/pay/one-time` (existing Openpay form)
4. Reject / statement / config available

Forms reuse the existing public entry at `https://pagos.kashbit.bond`.
