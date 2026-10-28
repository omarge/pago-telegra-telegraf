# F05e-02A — Durable nonfinancial Telegram demo invitation requests

Status: **DRAFT / NO_GO**, no live Telegram sends, migrations or deployments.

## Scope and actual behavior

The former bot creates invite bearer tokens using 6 random bytes and stores
them in in-process Maps; these do not survive restarts and cannot enforce
single consumption across instances. This phase introduces **separate demo
metadata**, without modifying Payment Engine, CustomerVault or financial
authorization authority.

New artifacts:
- `sql/f05e02_demo_invites.sql`: PostgreSQL 18 immutable demo invites
  (15-minute expiry, unique source Telegram inbox update, token HMAC digest,
  requester Telegram ID and integer-cent display amount). A second table
  stores at most one immutable redemption per invite, independently keyed
  to an inbox update. The rows are **not financial payment requests**.
- `src/telegram/postgresDemoInvites.js`: disabled by default; requires an
  injected pg Pool and separate 256-bit invite HMAC key. High-entropy bearer
  tokens are **derived deterministically** from a secret and immutable
  source Telegram actor/update/amount for crash-safe replay. Only keyed
  token digests, never raw invite tokens, enter PostgreSQL. The 15-minute
  expiration is enforced with PostgreSQL's own clock in a locked
  transaction. A valid, live inbox UUID lease is mandatory for both
  creation and redemption.
- A different amount/requester under the same update ID is a conflict;
  identical concurrent replay returns one original invite; competing
  recipients cannot both consume a token. The original requester cannot
  redeem their own invite. Only the first valid recipient can claim.
  Claiming an invite returns `DEMO_REDEEMED_NO_PAYMENT`, **never PAID**.
- `src/telegram/uatCommandHandler.js`: in isolated UAT, and only when
  `TELEGRAM_DEMO_INVITES_ENABLED=true`, accepts a **private** Telegram
  command `/solicitar 10.50` (strict decimal, maximum $1,000 MXN).
  It persists the demo invite and enqueues a static message stating that
  links and charges are disabled. The outbox allows only that exact
  informational message alongside the existing statement-not-available
  response, with no token embedded.
- `src/index.js` adds an explicit independent
  `TELEGRAM_DEMO_INVITE_KEY_HEX` requirement when demo invite registration
  is enabled. All existing UAT delivery and sender gates still apply.

**No shareable link or live `/start TOKEN` redemption handler has been
activated.** The repository can redeem one-use tokens through its internal
interface under a valid inbox lease, but does not yet expose those tokens
to the bot user. This is F05e-02A, NOT the complete F05e-02 end-user flow.

## Safety constraints

- A Telegram user ID obtained from a bot update is not a canonical
  BusinessOS actor, CustomerVault customer ID or a verified merchant tenant.
  Without authorized Security Engine identity binding, demo requests are
  isolated from Financial PaymentIntent, Fraud assessment and PSP execution.
- The amount is a **nonfinancial demo display amount**; it can never be
  used to authorize a charge. A real amount must later originate from an
  immutable, tenant-scoped BusinessOS payment request.
- Never expose the demo invite bearer token through logs or host consoles;
  key rotation will invalidate pending invites until migration/dual-key
  validation is explicitly designed and certified.
- PostgreSQL records persist and require an approved retention/erasure
  strategy. An immutable record is not a substitute for privacy controls.
- The default legacy Telegram mode is unchanged. UAT activation requires
  independent database migration, exclusive test bot, key provisioning
  and the previous F05c/F05d authorization gates.
- The `/solicitar` response does **not** include a payment link and does
  **not** accept any payment, card, PIN or PSP outcome.

## Certification and what remains

`tests/telegramDemoInvitesPg.test.js` exercises PostgreSQL 18
concurrency, exact replay, token secrecy, immutable fields, stale/forged
inbox leases, one-time redemption, self-claim rejection and expiration.
`tests/telegramDemoUatCommand.test.js` covers the new UAT command
through encrypted inbox, one immutable invite, and an outbox notice
with a mocked Telegram sender. No real Telegram/API/bank/PSP calls.

Next F05e-02B: provision and certify authorized BusinessOS identities,
a safe single-use link transport and `/start TOKEN` redemption, durable
request-to-tenant binding, notification reconciliation and confirmation
of ownership. The existing in-memory bot remains unconverted.

No changes to `main`, Payment Engine `master`, production hosts,
secret values, payment signatures or cryptography.
**PRODUCTION_GO=NO_GO**.
