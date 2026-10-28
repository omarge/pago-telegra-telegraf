# F05b — Telegram ingress durability gate

Status: **DRAFT / NO_GO** on
`feature/businessos-telegraf-integration-20261028`. No server deployment,
database migration or Telegram webhook/polling switch was performed.

## Implemented

1. `src/index.js`: removed the destructive `getUpdates(-1)` startup call
   and stopped fire-and-forget handling. The legacy poller now awaits each
   Telegraf handler before advancing its in-memory offset. This is a narrow
   mitigation: it is still not a durable or exactly-once poller.
2. `src/telegram/processUpdates.js`: testable sequential dispatch boundary,
   with explicit callback when processing has completed.
3. `sql/f05b_telegram_durable_inbox.sql`: separate PostgreSQL table for
   encrypted Telegram event envelopes and lease-fenced processing states
   PENDING/PROCESSING/DONE/QUARANTINED.
4. `src/telegram/postgresInbox.js`: **disabled-by-default** PostgreSQL
   inbox requiring an injected pool and an explicit 256-bit AES-GCM key.
   Deduplication uses Telegram update_id and an immutable canonical-body digest.
   A different payload with the same ID is a conflict. All envelopes are
   authenticated/encrypted with fresh IV and update_id AAD; no raw PIN,
   Telegram user text, or initData is stored in PostgreSQL plaintext by
   this repository. Credentials and key material are never logged.
5. Strict update_id ordering across concurrent claimers, lease UUID fencing,
   expired lease recovery, stale worker acknowledgement rejection, explicit
   release and tampered-payload quarantine.
6. `tests/telegramPostgresInbox.test.js` and
   `tests/telegramPollingSemantics.test.js`: real PostgreSQL 18 tests
   for encryption/dedup/order/reclaim/forged/stale leases, plus unit-level
   tests of the legacy polling correction.

## Important limits (cannot be marked Enterprise/GO yet)

- **The encrypted PostgreSQL inbox is not wired to runtime Telegram ingress.**
  The existing poller still uses process-local offsets. F05c must connect
  fetch -> durable append/commit -> advance Telegram offset, and an inbox
  worker -> idempotent Telegram side-effect/outbox -> ack.
- Inbox processing is **at-least-once**, not exactly-once external effects:
  after a Telegram send succeeds but before the inbox lease is acknowledged,
  a crash can cause replay. The bot and any BusinessOS API must use dedicated
  idempotent commands/outbox and financial-state authority, not mark PAID.
- A single Telegram bot token must have a controlled polling owner or use
  webhook intake. Concurrent independent getUpdates pollers are not certified.
- Lease expiry during a long-running Telegram handler may cause replay;
  heartbeat/renew and bounded handlers are required before enabling workers.
- Plaintext Telegram payload still exists briefly in process memory. Payload
  encryption needs a secure secret manager, key rotation, retention controls,
  backups and documented incident response; do not commit real key material.
- CustomerVault/StoredCard are still internal Java repositories, not a
  verified published HTTP customer/method integration contract.
- Security external identity linking, authoritative merchant/tenant ownership,
  authenticated Fraud ingress and CEPR payment no-double-PSP remain blocked.
- Never activate the inbox or payment dispatch in production merely because
  contract/DB tests pass.

## Evidence

- `.github/workflows/f05-postgres.yml` runs the tests against isolated
  PostgreSQL 18 containers in GitHub Actions, with disposable CI-only values.
- No changes to the Payment Engine, Security Engine, Fraud Engine, master/main,
  production host, secrets, financial signatures, or encryption algorithms.
- The new GCM encryption protects only the new Telegram inbox envelopes,
  and does not alter any BusinessOS cryptography or payment signature contract.
