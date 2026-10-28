# F01 — Telegram Mini App verified identity + fail-closed business boundary

Status: **DRAFT, NO_GO**. Branch stacked on F00; no merge or deployments.

## What changed
- Validate signed `Telegram.WebApp.initData` on the Express server
  (HMAC-SHA-256, constant-time comparison, expiry <=15 minutes, future skew <=30s,
  duplicate-key rejection, input bounds, verified user ID).
- The three Mini Apps send raw `initData` via `X-Telegram-Init-Data`.
  Browser `initDataUnsafe.user.id` is no longer treated as identity.
- `POST /pay/charge`, `POST /cards/enroll`, and `POST /nip/change`
  all require valid identity and then **return 503 unconditionally**.
  This removes the legacy direct Openpay charge and local card/PIN mutations
  from Express in the F01 branch. No env flag can enable a PSP dispatch.
- Remove plaintext PIN logging from the NIP Mini App.
- GET HTML Mini Apps remain available for iterative UI improvements.
- `src/bot.js` is NOT yet modified: its simulated `PAID` callbacks are still
  present and are a hard blocker to activation or deployment.

## Boundaries / unresolved dependencies
1. Signed Telegram user identity is **not** an authorization to act for a
   BusinessOS tenant, customer, saved card, or payment request.
2. F02 must resolve that identity through an authorized Security Engine
   mapping before calling Payment Engine. No client-supplied fraud approval.
3. F02 must remove legacy `PAID` button/NIP mutations and replace them
   with certified BusinessOS status projection. A Payment `AUTHORIZED`
   response is not automatically settlement or ledger posting.
4. The Mini Apps currently display static/demo amounts. F02 must retrieve
   the verified request/amount from BusinessOS, never accept an amount from
   the browser.
5. No alteration to bot credentials, Openpay keys, existing encryption/
   signatures, production deployment, BusinessOS master or Telegram main.
6. F01 unit/HTTP tests use only in-process signatures and fake data;
   they never call Telegram, Openpay or BusinessOS network services.

The webhook and Telegram bot polling transports are unchanged; F03 may
migrate ingress to a durable inbox. This draft must not be deployed.
