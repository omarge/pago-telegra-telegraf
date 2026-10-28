# F05 — Immutable PostgreSQL canonical payment requests

Status: DRAFT / NO_GO. Branch: feature/businessos-telegraf-integration-20261028.
This change does NOT wire PostgreSQL to the currently running Telegram bot
or enable any financial POST.

## Why
The existing src/store.js uses ephemeral Map-based invites/requests, which
do not survive process restarts and cannot enforce cross-instance uniqueness.
The F04 payment preparation requires a canonical request authority that
does not take amount, tenant, actor, merchant or risk key from a browser.

## Implementation
- sql/f05_telegram_canonical_requests.sql: isolated table, global request_id
  primary key, unique (tenant_id, risk_idempotency_key), positive integer cents,
  strict MXN, and trigger forbidding UPDATE/DELETE. No mutation of BusinessOS
  Payment Engine schema or cryptography.
- src/businessos/postgresCanonicalRequestAuthority.js: opt-in repository with
  injected pg Pool. create() uses INSERT ... ON CONFLICT DO NOTHING and
  compares immutable fields for identical replay. A mismatch is an explicit
  CANONICAL_REQUEST_CONFLICT, never a new payment. No in-memory correctness
  authority, random fallback key or per-node lock.
- loadById() provides the F04 requestAuthority interface. All SQL inputs
  use bound parameters; failures are redacted and fail closed.
- tests/businessosCanonicalRequestPg.test.js: unit and real PostgreSQL tests,
  including 32 concurrent duplicate requests, restart-style new repo
  instance, tenant/amount/payer tampering, reused risk key, database-level
  immutability, and preparation that never converts REVIEW into PAID.
- .github/workflows/f05-postgres.yml: isolated PostgreSQL 18 container in
  GitHub Actions. It uses disposable CI-only credentials. It does not
  access external databases, Openpay, Telegram or BusinessOS environments.

## CustomerVault dependency (no invented REST contract)
Payment Engine currently has CustomerVaultRepository and StoredCardRepository
Java domain ports; these are *not* a verified externally accessible customer
mapping/enrollment API. Do not query or write Payment Engine private tables
from the Node channel. F04 customerAuthority/methodAuthority remain unbound.
An authorized, versioned CustomerVault/customer association API or adaptor
and an independent Security Engine identity binding are prerequisites.

## Remaining blockers
- This repo's current Telegraf bot still uses the original in-memory store
  for demo invitation/payer messaging. This F05 repository is currently
  isolated and not production active; do not mark runtime durability GREEN.
- A server-authoritative creation command must bind merchant, tenant and
  payer to Security Engine and a real durable request; browser fields must
  never provide these claims.
- Signed Telegram initData + authorized merchant scope; no self-provision.
- Secure customerId/vault/payment method API and real Fraud assessment.
- Authenticated Fraud ingress (X-Tenant-Id header alone is insufficient).
- Service delegated Payment Engine authority, economic event observation,
  UNKNOWN reconciliation, independent CEPR and UAT tests.
- No financial POST, payment dispatch or production deploy is enabled.

Do not merge to main, alter Payment Engine master, secrets or signed/encrypted
financial protocols. Production GO remains NO_GO.
