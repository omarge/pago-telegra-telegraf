# KashBitPay Telegram -> BusinessOS | F00 contract gate

Status: **CONTRACT-ONLY / NO_GO** (sandbox integration preparation).
Source reviewed: BusinessOS Payment Engine `PaymentAuthorizationController`,
`PaymentAuthorizationRequest`, `PaymentAuthorizationStatus`, and
`PaymentAuthorizationSecurity` as of 2026-10-28.

## Scope
- A standalone, disabled-by-default, no-retry HTTP adapter was added at
  `src/businessos/paymentAuthorizationClient.js`. It is deliberately **not wired**
  to `src/bot.js`, `src/formServer.js` or any runtime entrypoint.
- The adapter has NO default endpoint or service token. Neither secrets nor credentials are committed.
- It requires HTTPS and a delegated service bearer supplied at runtime.
- `authorize()` accepts a server-validated PaymentAuthorizationRequest-shaped object;
  it never accepts raw PAN/CVV. All fields are allowlisted.
- The adapter maps authorization outcomes only. `AUTHORIZED` must **not** be interpreted
  by the Telegram channel as a final `PAID` or settled transaction.
- 401/403 fail closed. Timeout, 5xx, malformed and unrecognized responses yield
  `UNKNOWN_REMOTE_OUTCOME` with NO automatic retry.

## Verified upstream contract notes
- Endpoint: `POST /internal/v1/payment-authorizations`.
- Upstream activation requires `payment.authorization.inbound.enabled=true`
  **only in an authorized sandbox environment**; do not enable it as part of F00.
- Service-to-service authorization must be validated by Security Engine.
- `PaymentChannel` currently has no `TELEGRAM` value. For a Telegram payment
  link, the compatible existing channel is `PAYMENT_LINK`; confirm semantic
  acceptance with the Payment Engine owner before rollout.
- The upstream security gate requires nonempty `paymentIntentId`,
  `paymentAttemptId`, `idempotencyKey`, `clientIpAddress`,
  `fraudAssessmentId`, `customerId`, and a real fraud `APPROVE` decision.
  **Never mint a fake approval or pass an unverified browser identity.**
- Payment Engine derives deterministic execution identities from the
  (tenant, idempotencyKey); the channel must preserve the same key across
  re-delivery and retry/reconciliation workflows.

## Blocks before any end-to-end payment
1. Authenticate Telegram Mini App `initData` server-side and bind the user to
   an authorized BusinessOS customer/tenant; never trust `initDataUnsafe` IDs.
2. Provision genuine delegated authority through Security Engine.
3. Obtain a real Fraud & Risk assessment and PSP-safe stored-card/payment token
   reference via authorized BusinessOS interfaces.
4. Replace the existing `/pay/charge`, `confirm:yes` and NIP `PAID` mutations;
   these currently bypass financial confirmation. They are untouched in F00.
5. Implement durable deduplication, recovery, status projection and ledger
   reconciliation, then adversarial CI and sandbox E2E.
6. Require independent CEPR/Payment Engine certification before PRODUCTION_GO.

Do not modify `main`, BusinessOS `master`, PSP secrets, encryption, signature
code, or deployment configuration as part of this PR.

## Run existing tests
`npm test`. Tests for this adapter use fake transports; no network or PSP calls.
