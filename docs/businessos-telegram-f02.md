# F02 — Telegram callback authority gate (no simulated payments)

Status: **Draft, NO_GO**. Stacked on F01 (PR #2).

- Removed local callback paths that marked a request PAID, fabricated SIM tracking
  identifiers and recorded financial movements without a PSP/BusinessOS result.
- PIN keypad callbacks and saved-card payment selection are disabled, not redirected
  to local plaintext PIN storage.
- Reject/confirm/statement actions cannot mutate financial state while BusinessOS
  is not an authorized, certified source of truth.
- Menu actions require that the Telegram callback actor owns the local request
  (the local request is still a demo request and MUST migrate to durable identity).
- The original Openpay and local card/NIP Express POSTs are also blocked by F01.
- Tests simulate Telegram callbacks locally; no Telegram API, Openpay, or BusinessOS
  requests are sent.
- No changes to BusinessOS master, Telegram main, credentials, or deployments.

Remaining gates:
1. Signed identity -> verified tenant/customer ownership via Security Engine.
2. Durable request, inbox and identity mapping in PostgreSQL.
3. Fraud facts issued by Fraud Engine; BusinessOS authorize() receives only
   verified internal attributes and a single stable idempotency key.
4. UNKNOWN recovery and economic state observation; no blind retry.
5. Financial statement via Subledger; CustomerVault and NIP delegated to
   authorized BusinessOS services.
6. Independent sandbox and CEPR E2E certification, before any Production GO.
