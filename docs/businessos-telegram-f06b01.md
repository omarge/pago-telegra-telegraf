# F06b-01 — Proposed CustomerVault association contract (consumer only)

**Status: DRAFT / contract-tested only / real BusinessOS integration BLOCKED / production NO_GO.**

## Verified existing Java implementation

Read-only inspection of \`omarge/businessos-payment-engine\`, \`master\`:

- \`payment-domain/.../CustomerVaultCustomer.java\` contains canonical
  \`customerId\`, \`tenantId\`, provider account/reference, status and version.
  \`CustomerVaultStatus\` is \`CREATING, ACTIVE, UNKNOWN, FAILED, DELETED\`.
- \`StoredCard.java\` is scoped to customer, tenant, provider account; it
  contains provider payment reference, status and \`allowsCharges\`.
- \`CustomerVaultRepository\` and \`StoredCardRepository\` are Java **domain
  ports**, not external HTTP operations.
- REST tree review found the separately guarded
  \`PaymentAuthorizationController\` (for payment dispatch), **not a published
  authenticated customer/actor-to-vault association controller**.

Do not create a Node client pointing at an invented
\`/customer-vault/... \` URL. Do not query the private Payment Engine tables.
Do not automatically provision CustomerVault customers from Telegram IDs.

## Proposed *future* API contract, not an already deployed API

A backend owner must implement and independently certify a secure **internal
read-only customer association** capability. The exact path/HTTP framework
remains **UNASSIGNED** until that owner publishes the approved interface.

Trust boundary:
1. The calling service authenticates with an approved, scoped service credential,
   over TLS with validated certificate. Authorization must be enforced on the
   server side for the requested tenant, actor and merchant, not inferred from
   the caller's JSON or \`X-Tenant-Id\`.
2. Security Engine independently resolves the signed Telegram Mini App subject
   to canonical user/actor + tenant membership. The requested merchant/tenant
   pair is validated by the source-of-truth server.
3. Customer association authority resolves and checks the exact canonical
   actor/tenant/merchant tuple and its current, active association.
4. CustomerVault authority checks \`CustomerVaultCustomer.status == ACTIVE\`,
   canonical tenant, customer and provider-account association.
5. No PAN, CVV, PIN, raw provider/customer token, payment method, stored card,
   account secret or economic status leaves this read-only boundary.

Proposed versioned *logical* input (server-owned, not browser-supplied):
\`\`\`json
{"tenantId":"tenant-A","actorId":"actor-A","merchantId":"merchant-A"}
\`\`\`

Proposed exact logical response fields consumed by
\`CustomerVaultAssociationPort\`:
\`\`\`json
{
  "contractVersion":"businessos.customer-vault.association.v1",
  "tenantId":"tenant-A",
  "actorId":"actor-A",
  "merchantId":"merchant-A",
  "customerId":"customer-A",
  "providerAccountId":"provider-A",
  "status":"ACTIVE",
  "associationStatus":"ACTIVE",
  "associationVersion":3,
  "validatedAt":"2026-10-28T22:00:00.000Z"
}
\`\`\`

The above is a **design proposal**, not verified server wire output.
The Java \`CustomerVaultCustomer\` model does not itself implement
\`actorId\`, \`merchantId\` or \`associationStatus\`: these must come from
a separate *authoritative* relation owned and certified by BusinessOS.
A merchant relationship must NOT be inferred merely from provider references.

## Consumer implementation

\`src/businessos/customerVaultAssociationPort.js\`:
- Disabled by default; no URL, login, network transport or env-based
  activation. \`src/index.js\` and payment execution **do not instantiate it**.
- Requires an injected \`reader.lookupCustomerAssociation\` implementation
  that a separate future review must prove to be authenticated and tenant-bound.
- The \`resolve\` input is reduced to exact \`tenantId\`, \`actorId\`,
  \`merchantId\` properties and frozen. All other caller attributes are ignored.
- Only ONE read is attempted. 401/403/404/5xx, timeout, null or malformed
  responses fail closed (no self-provision, fallback or blind retries).
- Requires exact authority tuple, contract version, ACTIVE vault and
  association, positive association version, provider-account ID, and
  validatedAt timestamp no older than 30s (configurable up to 5 minutes).
  Future timestamps beyond 30s and impossible calendar dates are rejected.
- It exposes only allowlisted customer reference metadata to the server-side
  F06a preflight, and never sends it to Telegram.
- \`tests/customerVaultAssociationPort.test.js\` uses fake authorized backend
  responses, including a pipeline into F06a signed Mini App preflight, and
  exercises cross-tenant, different actor/merchant, stale/bogus data,
  disabled status and failed authority. **These tests are NOT live backend
  certification.**

## Future separate stored-card method endpoint

Do NOT equate a confirmed customer association with a usable charge method.
Before any card payment, an independently certified authorization layer
must check \`StoredCard.status=ACTIVE\`, \`allowsCharges=true\`,
customer + tenant + provider-account + merchant ownership, current
nonexpired card reference, server-sourced Fraud device/BIN facts and
Payment Engine's PSP owner-fenced idempotent authorization. No such method
query is implemented here; nothing can mark \`PAID\` or call PSP.

## Gate and operational limits

F06b-01 **consumer contract tests GREEN** is distinct from F06b **real
backend API NOT IMPLEMENTED/NOT CERTIFIED**. Do not claim F06b is
operationally GREEN until the actual backend API is built, secured and
tested with Security Engine and CustomerVault. It must have independent
tenant-crossing, credential, revocation, service outage and concurrency
E2E evidence. CEPR Payment Engine and Subledger still block production.

No changes to BusinessOS Payment/Security repositories, \`main/master\`,
hosts, secrets, runtime, Telegram sends, card data, financial crypto or
real Openpay charges.
