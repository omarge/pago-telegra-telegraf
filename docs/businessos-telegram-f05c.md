# F05c — Telegram PostgreSQL durable ingress / worker integration

Status: **DRAFT / NO_GO**. Current branch:
`feature/businessos-telegraf-integration-20261028`.
No deployment, schema migration, credential provisioning, or PSP call performed.

## Wired only with an explicit isolated UAT gate

`src/index.js` now supports two delivery modes:
- Default `TELEGRAM_DELIVERY_MODE=legacy`: existing polling with awaited
  handlers, no `getUpdates(-1)` truncation. This is NOT a certified production
  Telegram delivery mode.
- `TELEGRAM_DELIVERY_MODE=durable-uat`: activates durable encrypted PostgreSQL
  Telegram ingress + worker **only** when all of these conditions hold:
  `KASHBIT_INTEGRATION_UAT_ACK=YES_ISOLATED_UAT`,
  `NODE_ENV` is not `production`,
  `KASHBIT_FINANCIAL_GO` is not `true`,
  `TELEGRAM_INBOX_DATABASE_URL` is explicitly provided,
  and `TELEGRAM_INBOX_KEY_HEX` is an explicitly provisioned 32-byte hex key.
  Configuration must be reviewed, approved, and applied in isolated UAT.
  No defaults for database credentials or inbox encryption keys exist.

The SQL schema migration
`sql/f05b_telegram_durable_inbox.sql` **must** be applied separately
through an authorized migration process to the isolated UAT database.
Do not enable against production or any existing Payment Engine schema.

## F05c operational semantics

1. `acquirePollerOwner` acquires a session-scoped PostgreSQL advisory lock
   on the one Telegram poller. A second process fails closed; there is no
   concurrent `getUpdates` ownership by two sessions.
2. The initial Telegram offset is restored from the durable maximum
   `update_id + 1`. New Telegram updates must be strictly increasing.
3. Each update is encrypted with AES-256-GCM and durably inserted to PostgreSQL
   before advancing the in-process offset. Telegram is not called with the
   advanced offset until prior inserts committed.
4. Independent PostgreSQL worker receives an ordered row lease, decrypts and
   invokes the Telegraf handler. Heartbeat renewal prevents ordinary
   slow handlers from losing lease ownership.
5. Ack to DONE requires handler success AND a still-live, matching lease UUID.
   Handler errors release for replay; expired leases can be reclaimed with a
   new UUID; late owners cannot acknowledge reclaimed work.
6. A failed/expired handler after 12 attempts is quarantined. Envelope
   integrity failures are quarantined; there is no silent drop.
7. `bot.catch` now propagates a redacted generic error rather than swallowing
   handler failures and incorrectly reporting successful processing.

## Guarantee boundaries and blockers

**This design is at-least-once, NOT exactly-once for outbound Telegram
side effects.** In particular a process can send a Telegram notification and
then crash before acknowledging the inbox row; replay may send it again.
The legacy `src/bot.js` still creates invites and state in process-local Maps
and can emit non-idempotent outbound messages. Before activating beyond UAT,
migrate those commands to durable commands/outbox and prove their replay
behavior. Do not claim that F05c certifies end-to-end economic idempotency.

Additional work remains mandatory:
- OAuth/Telegram external identity binding and RBAC in Security Engine.
- Published, versioned and authorized CustomerVault/StoredCard API.
- Real authenticated Fraud Engine ingress; untrusted `X-Tenant-Id`
  header alone does not establish authority.
- Payment Engine CEPR owner fence, unknown-outcome recovery and reconciliation.
- Channel outbox, Telegram outbound replay treatment, key rotation, backups,
  alerting and retention/erasure policy for encrypted inbox payloads.
- Independent sandbox E2E/UAT certification across real services.

All F05c automated tests use fake transports, test-only key material
and isolated PostgreSQL 18 in GitHub Actions. Do not deploy
`main`/`master`, merge PRs, modify payment crypto, or run real PSP payments
for F05c.
