# F03 — Telegraf to Security Engine (contract-only)

Status: **DRAFT / NO_GO**. Source branch: feature/businessos-telegraf-integration-20261028.
No deployment, no real credentials, no PSP calls or financial-state changes.

## Confirmed Java Security Engine contracts
- External identity: POST /internal/security/v1/external-identity/authorize
  from ExternalIdentityAuthorizationController.java.
- Delegated service authority: POST /internal/security/v1/service/authorize
  from ServiceAuthorizationController.java.
- Both require a ServiceCredential bearer, protected tenant intent and scoped
  audience/permission. Identity resolution and RBAC decisions are authoritative
  inside Security Engine; the Telegram caller cannot create them.
- A granted external identity has actorType USER, validated membership, scope,
  actorId, target coherence and a trusted tenant. Its actorId is **NOT**
  the canonical Payment Engine customerId/CustomerVault key.
- A granted service delegation contains a SECRET token. Never expose it to a
  Telegram browser or persist/log it. Payment Engine validates that delegated
  bearer separately via POST /internal/security/v1/service/validate.

## Added adapter
src/businessos/securityGateway.js

Enabled only when explicitly instantiated with enabled=true, an HTTPS URL,
a real ServiceCredential and Telegram bot token, a provisioned identityProviderId
namespace, the intended tenant, target type, and separately approved permissions.
The adapter does not read these from browser parameters or invent defaults.

authorizeTelegramInitData(rawSignedInitData, trustedTargetId) verifies Telegram's
signature and freshness BEFORE constructing the Security Engine lookup key.
The exact Java flat wire DTO uses scopeType TENANT and canonical scopeValue null.
An authoritative 200 ALLOW must match requested tenant, permission, audience,
target, scope and membership; malformed and suspicious replies fail closed.
No retry occurs for any network error.

requestServiceDelegation(trustedTargetId) requests a separate bounded payment
service token, which must be consumed SERVER-SIDE only.

Express exposes only POST /api/businessos/identity-check behind the exact
BUSINESSOS_SECURITY_ENABLED=true flag; the default is an unconditional 503.
When explicitly configured, it calls authorizeTelegramInitData with signed
X-Telegram-Init-Data and a server-owned targetId, ignores any browser-supplied
tenant/target/actor/customer fields and returns only {authorized:true} or a
generic 401/403/503 error. It never exposes actor, membership or tokens.
All three financial POST routes remain 503; this is not payment enablement.

Required server runtime configuration names (do not commit real values):
- BUSINESSOS_SECURITY_ENABLED (default false)
- BUSINESSOS_SECURITY_BASE_URL (HTTPS)
- BUSINESSOS_SECURITY_SERVICE_CREDENTIAL (opaque secret)
- TELEGRAM_BOT_TOKEN (existing secret)
- BUSINESSOS_SECURITY_IDENTITY_PROVIDER_ID (provisioned bot namespace)
- BUSINESSOS_SECURITY_TENANT_ID, BUSINESSOS_SECURITY_AUDIENCE
- BUSINESSOS_SECURITY_PERMISSION, BUSINESSOS_SECURITY_TARGET_TYPE
- BUSINESSOS_SECURITY_TARGET_ID (trusted merchant account)
- BUSINESSOS_PAYMENT_PERMISSION, BUSINESSOS_PAYMENT_AUDIENCE

These values are deliberately unset in GitHub and runtime by this PR.
The gateway has only fake transport tests and does not call live Security.

## Outstanding operational gates
1. Provision a bot-scoped ExternalIdentity provider namespace and persisted
   Telegram-user -> canonical user link in Security Engine through its authorized
   identity provisioning process. Do NOT assume TELEGRAM is preconfigured.
2. Provision a dedicated least-privilege ServiceCredential and audience/permissions.
   NEVER create credentials in a repository, a script, or a public log.
3. Determine server-authoritative tenant/merchant-account selection from an
   owned, durable payment request; never trust request_id from Mini App alone.
4. Verify the canonical CustomerVault customerId through a separate authorized
   identity/account mapping. No inference from Security actorId.
5. The BFF identity-check endpoint is wired but DISABLED until actual Security
   environment readiness. All financial HTTP routes remain 503 / NO_GO.
6. Validate the exact audience and permission policy with Security Engine
   independently before runtime operations.
