# F06a — Telegram payer identity ↔ Security Engine ↔ CustomerVault preflight

Status: DRAFT / NO_GO. Contract/preflight only; disabled by default and NOT
wired to the bot, public HTTP routes, payment dispatcher, Fraud Engine, or a
real CustomerVault service.

## Verified Java source boundaries

- Security Engine actually implements `POST /internal/security/v1/external-identity/authorize`
  in `ExternalIdentityAuthorizationController`. ServiceCredential authentication
  is required. `identityProviderId + externalSubject` is merely a lookup key:
  Security Engine resolves an existing canonical user binding and membership,
  evaluates RBAC and returns the authoritative actor, tenant, target and
  membership. Unknown/unbound users are **denied**, never auto-provisioned.
- The Security Engine has an `ExternalIdentityLink` mapping
  `(IdentityProviderId, ExternalSubject) -> UserId`. No Telegram provider
  namespace, identity link, service audience or grant was provisioned here.
- Payment Engine's CustomerVault is implemented through Java-internal
  `CustomerVaultRepository` and `StoredCardRepository`. Its
  `CustomerVaultCustomer` uses a canonical `CustomerId`, `TenantId`,
  `PaymentProviderAccountId`, provider reference and lifecycle status.
  `StoredCard` has separate tenant/customer/provider account, charge
  permissions and lifecycle status. **These Java repositories do NOT
  constitute an authenticated, external HTTP CustomerVault API**.
  No endpoint path or customer-to-Security actor association is invented.

## New fail-closed implementation

- `src/businessos/telegramIdentityPreflight.js` can be instantiated only
  with explicit `enabled=true`, a real bot token, and four independent
  server-owned ports. It is not instantiated by `src/index.js`.
- Verify fresh Telegram Mini App HMAC data BEFORE loading any customer
  information; compare signed `user.id` with the payer ID in the
  **previously redeemed immutable PostgreSQL invitation claim**.
- Load merchant/tenant intent ONLY from an separately certified
  `merchantAuthority.resolve({demoInviteId})` port. Demo invitations are
  NOT tenant-scoped payment contracts and cannot supply this authority.
- Ask Security Gateway to authorize the signed subject for that specific
  merchant target and enforce actor USER, exact tenant, target type,
  target ID and nonempty membership. The Security Gateway itself binds
  audience, provider namespace, tenant and permission to service configuration.
  F06a currently requires one tenant-specific, appropriately scoped Gateway
  per configured authority; do NOT use a global gateway for arbitrary tenants.
- Ask an independently certified CustomerVault customer association port
  for the authoritative `customerId`, provider account, tenant, merchant,
  actor and ACTIVE lifecycle. Reject cross-tenant, wrong actor/merchant,
  missing canonical customer, missing provider account, UNKNOWN/DELETED.
- The returned preflight result reports ONLY
  `IDENTITY_PREFLIGHT_ONLY_NO_PAYMENT` with `financialAuthorization=false`.
  It never returns actorId, customerId, vault references, service bearer or
  a payment authorization; it never calls Openpay/PSP or Fraud.

## Still blocking real F06

1. An approved way to provision and independently audit Security Engine
   Telegram identity links, tenant membership, scoped permission grants and
   least-privilege credential for the *dedicated* UAT bot.
2. A **published, versioned, authenticated BusinessOS merchant ownership and
   actor-to-CustomerVault mapping API**. F06a ports remain **unbound** until
   such real backend contracts exist and are independently certified. No
   direct query of private Payment Engine tables is permitted.
3. StoredCard status `ACTIVE`, `allowsCharges=true`, actual payment method
   reference, merchant/provider account and expiry must be checked via a
   separate certified service. The internal Java `StoredCard` model does
   not supply Fraud's required BIN and device fingerprint. Do not fabricate.
4. Tenant-bound authenticated Fraud ingress, Payment Engine CEPR owner fence,
   UNKNOWN reconciliation, Financial Subledger, full sandbox E2E/UAT and
   production runbooks/monitoring still require certification.
5. Never convert `/start ki_TOKEN` demo acceptance into a financial
   operation. Before any payment intent, the payer must independently
   authorize the real, immutable economic request.

CI:
- `tests/telegramIdentityPreflight.test.js` uses fake Security and Vault
  authorities to test signed identity, demo claim binding, cross-tenant,
  cross-actor, merchant, RBAC and inactive-customer rejections.
- PostgreSQL 18 tests obtain a real immutable redeemed demo claim from the
  disposable database and verify the preflight checks it before calling
  any downstream financial authority.
- Tests do not certify an actual Security Engine ↔ CustomerVault integration.

No changes to BusinessOS repos, main/master, credentials, server infrastructure
or financial signatures. No actual provider messages or charges.
`PRODUCTION_GO=NO_GO`.
