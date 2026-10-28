# F04 — Fraud Engine contract + canonical payment preparation (NO_GO)

Status: **DRAFT / NO_GO**. This phase builds on F00–F03 on
`feature/businessos-telegraf-integration-20261028`.

## Verified authoritative APIs

**Fraud Engine** (source: `omarge/businessos-fraud-engine`):
- POST `/v1/fraud/assessments`.
- Headers: `X-Tenant-Id` and mandatory `Idempotency-Key`.
- Body: `paymentId`, `merchantId`, `customerId`, `amount`
  (`value`, `currency`), `method` (CARD, `vaultToken`, `bin`, `last4`),
  `device` (`fingerprint`, `ip`), `occurredAt`.
- Response: `assessmentId`, `decision` (APPROVE/CHALLENGE/REVIEW/DECLINE),
  `score` in [0,1], `reasons`, `modelVersion`.
- Source contract requires original stable idempotency key, permits idempotent
  replay, and rejects same key with different business payload (409).

**Payment Engine**:
- POST `/internal/v1/payment-authorizations` requires a verified business
  `customerId`, a genuine `fraudAssessmentId` and `fraudDecision=APPROVE`,
  valid payment method reference and delegated Security Engine authority.
- `PaymentChannel` currently has no TELEGRAM enum (PAYMENT_LINK can represent
  a link flow after semantic approval).
- Authorization results must never be promoted to settled/PAID by the bot.

## New isolated code

- `src/businessos/fraudAssessmentClient.js` implements the exact Fraud
  Assessment DTO, 200 response status/shape checks, bounded timeout, no retries,
  and UNKNOWN on ambiguous outcome. It is disabled by default.
- `src/businessos/paymentPreparation.js` requires server-authoritative
  request, canonical payer identity/RBAC, verified CustomerVault identity,
  verified payment method/device and real risk evidence before returning a
  readiness status. It does **NOT** request service delegation or call Payment
  Engine, issue PSP charges, or set paid/ledger state. It is disabled by default.
- HTTP routes `/pay/charge`, `/cards/enroll`, `/nip/change` remain 503.
- Browser-provided tenant, amount, customer, risk decision, method or actor must
  never be used as authority; incoming requestId is a mere locator.

## Security blocker discovered during audit

`fraud-app/.../filter/TenantFilter.java` takes `X-Tenant-Id` from a
request header into a scoped TenantContext. The reviewed filter itself does not
authenticate the caller. The F04 Fraud client likewise does not create
authority: a caller-controlled header alone CANNOT certify tenant isolation.
Before any real Fraud connection, investigate all upstream authenticated
ingress controls and certify a trusted service-to-service boundary (e.g.
through a certified API gateway, service mTLS or Security Engine authorization).
Do not call Fraud from untrusted/public frontend traffic.

## Missing authoritative adapters

1. Persisted payment request with immutable amount, requester/payer actor,
   merchant, tenant, riskIdempotencyKey and durable replay safety.
2. Canonical Telegram external identity to actor + tenant + merchant authority.
3. Canonical actor to CustomerVault customerId binding and confirmed method
   reference, BIN/last4 and fraud device evidence.
4. Authenticated service-to-Fraud transport and independently authorized
   Fraud Engine decision; risk failures must never turn into APPROVE.
5. Real delegated service authority for Payment Engine and Payment Engine
   CEPR/no-duplicate-PSP gate.
6. Economic status event delivery, reconciliation and Financial Subledger,
   with NO automated unknown-outcome redispatch from Telegram.
7. Sandbox E2E across real services before any production GO.

No secrets, backend engine modifications, deploy, provider calls or merge.
All tests run with fake in-process ports and HTTP stubs.
