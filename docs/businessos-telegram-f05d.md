# F05d — Telegram outbound intent outbox (no automatic resend)

Status: **DRAFT / NOT DEPLOYED / NO_GO**.
Branch: `feature/businessos-telegraf-integration-20261028`.

## Verified risk and strategy

Telegram `sendMessage` does NOT expose a caller-supplied idempotency
key comparable to BusinessOS Payment Engine's persisted idempotency
contract. If a send succeeds and the process crashes before recording
the success, retrying can deliver the message twice.

F05d therefore chooses **at most one automatic send attempt** for a
persisted outbound intent. This trades guaranteed delivery for
not duplicating an ambiguously delivered notification.
It is NOT exactly-once end-to-end delivery and must never be described
as such. A business-facing notification in UNKNOWN requires manual
reconciliation or a separate explicitly authorized remediation policy.

## Added implementation (isolated)

- `sql/f05d_telegram_outbox.sql`: append-only encrypted outbound
  message intent per `(update_id, action_key)` referencing the F05b
  PostgreSQL inbox. Strict state machine:
  `READY -> IN_FLIGHT -> SENT | UNKNOWN`. Database constraints and
  trigger prevent payload mutation, reverting an attempt to READY,
  deleting an intent or rewriting terminal status.
- `src/telegram/postgresOutbox.js`: explicitly enabled, injected Pool
  and 256-bit AES-GCM key; no default DB connection or token.
  `enqueueForClaim()` transactionally verifies the active inbox
  `update_id + lease_id` under row lock before inserting. It persists
  a canonical, allowlisted plaintext-text notification using encrypted
  ciphertext and keyed HMAC digest; the same update/action/message is a
  harmless replay, while different content with the same identity fails
  closed. No parse_mode or arbitrary Telegram method is accepted.
- `claimForSend()` atomically changes exactly one READY intent to
  IN_FLIGHT and increments attempts to one BEFORE the caller is allowed
  to perform an external send. Concurrent claims cannot each send.
- `markSent()` requires a Telegram response with a valid message ID
  and matching chat ID. `finishUnknown()` records ambiguous outcomes;
  `sealStaleAsUnknown()` is an explicit operations-only action that
  NEVER resends. No automatic transition from IN_FLIGHT/UNKNOWN to READY.
- No HTTP route, bot handler, Telegram API, Payment Engine or PSP
  code calls the new outbox: **this is a standalone, tested persistence
  boundary, not an activated notification dispatcher**.

## GitHub Actions evidence

`tests/telegramOutboxPg.test.js` runs in an independently named schema
on real disposable PostgreSQL 18. It exercises:
- Disabled-by-default configuration and malformed payloads;
- Source-inbox lease authorization and stale/forged owner denial;
- 32 concurrent same-key enqueue attempts -> exactly one intent;
- Change of notification payload with same identity -> explicit conflict;
- 32 concurrent dispatch claims -> exactly one IN_FLIGHT attempt;
- Durable SENT state, terminal UNKNOWN, no duplicate claim on restart;
- Simulated crash after a remote send but before recording its result:
  the original attempt remains IN_FLIGHT and is never blindly retried;
- Database-level immutability and terminal transition checks.

These are **synthetic delivery tests**; no message was sent to Telegram
or any provider. A real sender/reconciler and all associated security
reviews are not implemented.

## Before wiring the actual bot

1. Replace the process-local invite/request mutations in `src/bot.js`
   with durable commands tied to certified BusinessOS tenant, merchant,
   payer and idempotency authorities.
2. Refactor each existing direct `ctx.reply`, `ctx.editMessageText`,
   `ctx.answerCbQuery` and `ctx.telegram.sendMessage` use into
   explicitly classified, replay-safe operations. Telegram callback
   acknowledgements and edits have different reconciliation semantics;
   do not pretend they are equivalent to a simple text send.
3. Persist the inbound command state and outbound effects in a single
   properly fenced transaction wherever applicable. The current
   enqueueForClaim gate verifies the inbox lease but does not by itself
   guarantee atomicity with arbitrary legacy Map mutations.
4. Implement an audited sender with bounded timeout and **no
   automatic retransmission after remote ambiguity**. Create a
   controlled operator view for UNKNOWN and business reconciliation.
5. Validate secrets/key rotation, retention, database HA, throughput,
   rate limits, queue age, stale IN_FLIGHT alerts and disaster recovery.
6. Certify independent BusinessOS CustomerVault/StoredCard, Security,
   Fraud tenant isolation, CEPR PSP owner fences, unknown recovery and
   Financial Subledger. F05d is not an authorization to charge.

No database migrations were applied outside disposable GitHub Actions.
No host, secret, `main`, BusinessOS `master`, live card, bank or PSP
was changed. `PRODUCTION_GO=NO_GO`.
