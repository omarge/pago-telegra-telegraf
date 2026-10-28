# F05e — UAT-only read-only command → encrypted outbox → controlled sender

Status: **DRAFT / NO_GO**. Not deployed. No external Telegram/PSP calls
executed by the change or its CI tests.

## Actual integration increment

F05c durable inbox now passes a trusted, immutable `updateId` and
`inboxLeaseId` into its handler. The isolated `durable-uat` mode no
longer invokes legacy `bot.handleUpdate`; it instead invokes
`src/telegram/uatCommandHandler.js`.

Exactly one command is supported in this pilot: a **private**
`/estado_cuenta` message where Telegram `from.id` equals `chat.id`.
The handler enqueues one immutable, encrypted, plain-text
`statement-unavailable-v1` notification under the still-valid inbox
lease. The text states Financial Subledger is unavailable; it never
reports a paid, authorized or settled transaction. The inbound row
is acknowledged only AFTER successful outbox enqueue.

Every other Telegram message/callback is rejected with
`UAT_COMMAND_NOT_MIGRATED` instead of reaching legacy
in-memory invites, payer state, locally saved cards or arbitrary
Telegram send/edit/callback methods. This intentionally makes the
isolated UAT mode **nonfunctional for legacy financial flows**.
Unsupported updates can be retried by the inbox and ultimately
quarantined; inspect/alert on these rather than interpreting them
as successful processing.

## Sender

`src/telegram/outboxDispatcher.js` consumes the previously persisted
outbox `READY` intent and commits `IN_FLIGHT` BEFORE one Telegram
send. It checks the exact action key, static response text and private
positive chat ID and NEVER sends any other content. A successful
response with matching chat and message ID is `SENT`.

All timeouts, network failures, malformed Telegram responses or
persistence ambiguity remain `UNKNOWN` or `IN_FLIGHT`, and neither
state is eligible for automatic redispatch. This is **at-most-one
automatic attempt**, NOT guaranteed delivery or exactly-once
external send. UNKNOWN requires operational reconciliation.

## Runtime gates

- `TELEGRAM_DELIVERY_MODE=durable-uat` requires
  `KASHBIT_INTEGRATION_UAT_ACK=YES_ISOLATED_UAT`, a reviewed isolated
  `TELEGRAM_INBOX_DATABASE_URL`, a secret
  `TELEGRAM_INBOX_KEY_HEX` and nonproduction runtime.
- The outbox is always instantiated behind that isolated delivery
  mode but remains **queued only** unless
  `TELEGRAM_OUTBOX_SENDER_ENABLED=true` AND
  `KASHBIT_OUTBOX_UAT_ACK=YES_ISOLATED_UAT_TELEGRAM_SEND`.
- Default mode remains `legacy`, with the sender disabled. No
  environment variables, secrets, DB migrations or deployments were
  changed by this PR. The sender opt-in is NOT production authorization.
- Both `sql/f05b_telegram_durable_inbox.sql` and
  `sql/f05d_telegram_outbox.sql` would need explicit independent
  migration review for UAT. Do not provision them on a production
  Payment Engine database.

## CI proof

`tests/telegramF05eProjection.test.js` uses independently named
disposable PostgreSQL 18 schema, synthetic Telegram envelopes and a
stub sendMessage to certify:
- A live UUID-fenced PostgreSQL inbox claim is required to enqueue;
- Unmigrated bot actions, financial requests and private-chat
  impersonation are rejected without side effects;
- Inbox → outbox → simulated sender yields one SENT notification,
  including two racing dispatcher instances;
- Crash after intent commit but before inbox ack yields identical
  replay with no duplicate outbound row;
- Timeout after possible remote acceptance is UNKNOWN and never
  automatically resent;
- Crash after the send claim but before any network call remains
  IN_FLIGHT, not automatically retried;
- Deliberate forged `paid-confirmation` record is rejected and never
  sent by the pilot dispatcher.

## Still required before any real payment GO

Durable authorized payment and invite commands (not legacy Maps),
idempotent BusinessOS Payment Engine operations, external
CustomerVault API, Security identity binding, authenticated Fraud
tenant boundary, audited financial status projection, unknown-outcome
reconciliation, Financial Subledger, real sandbox E2E, chaos tests,
monitoring, outbound rate limits and authorized UAT deployment.

No merge to `main` or BusinessOS `master`; no changes to Openpay
credentials, payment encryption/signatures, production hosts or banks.
**PRODUCTION_GO=NO_GO**.
