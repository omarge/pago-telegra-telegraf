'use strict';

const { verifyTelegramMiniAppInitData } = require('../telegram/miniAppIdentity');

const EXTERNAL_PATH = '/internal/security/v1/external-identity/authorize';
const DELEGATION_PATH = '/internal/security/v1/service/authorize';

class SecurityBoundaryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SecurityBoundaryError';
    this.code = code;
  }
}

function requireString(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 ||
      /[\r\n]/.test(value)) {
    throw new SecurityBoundaryError('SECURITY_CONFIGURATION_INVALID');
  }
  return value;
}

function checkDecision(decision, fields, service) {
  const err = () => { throw new SecurityBoundaryError('SECURITY_RESPONSE_INVALID'); };
  if (!decision || decision.allowed !== true ||
      decision.decisionCode !== 'ALLOW' || decision.reasonCode !== null ||
      !requireNonblank(decision.actorId) || !requireNonblank(decision.tenantId) ||
      decision.tenantId !== fields.targetTenantId ||
      decision.audience !== fields.audience ||
      decision.permission !== fields.permission ||
      decision.scopeType !== 'TENANT' || decision.scopeValue !== null ||
      decision.scopeTenantId !== fields.targetTenantId) err();
  if (service) {
    if (!requireNonblank(decision.actorType) ||
        !requireNonblank(decision.token)) err();
  } else {
    if (decision.actorType !== 'USER' ||
        !requireNonblank(decision.membershipId) ||
        decision.organizationId !== null ||
        decision.targetType !== fields.targetType ||
        decision.targetId !== fields.targetId ||
        !requireNonblank(decision.validatedAt) ||
        !Number.isFinite(Date.parse(decision.validatedAt))) err();
  }
}
function requireNonblank(v) { return typeof v === 'string' && v.trim().length > 0; }

class BusinessOsSecurityGateway {
  constructor({
    enabled = false, baseUrl, serviceCredential, telegramBotToken,
    identityProviderId, targetTenantId, audience, permission,
    targetType, servicePermission, serviceAudience,
    fetchImpl = globalThis.fetch, timeoutMs = 5000,
  } = {}) {
    this.enabled = enabled === true;
    if (!this.enabled) return;
    let endpoint;
    try { endpoint = new URL(baseUrl); } catch (_) {
      throw new SecurityBoundaryError('SECURITY_CONFIGURATION_INVALID');
    }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
        endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      throw new SecurityBoundaryError('SECURITY_CONFIGURATION_INVALID');
    }
    for (const v of [serviceCredential, telegramBotToken, identityProviderId,
      targetTenantId, audience, permission, targetType, servicePermission, serviceAudience]) {
      requireString(v);
    }
    if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 || timeoutMs > 30000) {
      throw new SecurityBoundaryError('SECURITY_CONFIGURATION_INVALID');
    }
    this.endpoint = endpoint;
    this.serviceCredential = serviceCredential;
    this.telegramBotToken = telegramBotToken;
    this.identityProviderId = identityProviderId;
    this.targetTenantId = targetTenantId;
    this.audience = audience;
    this.permission = permission;
    this.targetType = targetType;
    this.servicePermission = servicePermission;
    this.serviceAudience = serviceAudience;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async _request(path, payload) {
    let response;
    try {
      response = await this.fetchImpl(new URL(path, this.endpoint).toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + this.serviceCredential,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (_) {
      // Do not reveal credentials, signed initData or raw upstream error bodies.
      throw new SecurityBoundaryError('SECURITY_UNAVAILABLE');
    }
    if (response.status === 401 || response.status === 403) {
      throw new SecurityBoundaryError('SECURITY_DENIED');
    }
    if (response.status !== 200) {
      throw new SecurityBoundaryError('SECURITY_UNAVAILABLE');
    }
    let result;
    try { result = await response.json(); } catch (_) {
      throw new SecurityBoundaryError('SECURITY_RESPONSE_INVALID');
    }
    return result;
  }

  // The Telegram actor is derived exclusively from signed initData; caller
  // cannot supply externalSubject or a trusted tenant/actor/customer identity.
  async authorizeTelegramInitData(rawInitData, targetId) {
    if (!this.enabled) throw new SecurityBoundaryError('SECURITY_DISABLED');
    requireString(targetId);
    let identity;
    try {
      identity = verifyTelegramMiniAppInitData(rawInitData, this.telegramBotToken);
    } catch (_) {
      throw new SecurityBoundaryError('TELEGRAM_IDENTITY_NOT_VERIFIED');
    }
    const request = {
      identityProviderId: this.identityProviderId,
      externalSubject: identity.telegramUserId,
      audience: this.audience,
      permission: this.permission,
      scopeType: 'TENANT',
      scopeValue: null,
      targetTenantId: this.targetTenantId,
      targetType: this.targetType,
      targetId,
    };
    const decision = await this._request(EXTERNAL_PATH, request);
    checkDecision(decision, request, false);
    return Object.freeze({
      actorId: decision.actorId,
      actorType: decision.actorType,
      tenantId: decision.tenantId,
      membershipId: decision.membershipId,
      targetType: decision.targetType,
      targetId: decision.targetId,
      // Actor is NOT a CustomerVault/customerId; a separate authorized binding is required.
    });
  }

  // A service delegation is independent of the user's identity decision.
  // The Payment Engine authenticates this short-lived token through Security Engine.
  async requestServiceDelegation(targetId) {
    if (!this.enabled) throw new SecurityBoundaryError('SECURITY_DISABLED');
    requireString(targetId);
    const request = {
      targetTenantId: this.targetTenantId,
      audience: this.serviceAudience,
      permission: this.servicePermission,
      scopeType: 'TENANT',
      scopeValue: null,
      scopeTenantId: this.targetTenantId,
      targetType: this.targetType,
      targetId,
    };
    const decision = await this._request(DELEGATION_PATH, request);
    // The reply's audience and permission must match the SERVICE request.
    checkDecision(decision, {
      ...request,
      audience: this.serviceAudience,
      permission: this.servicePermission,
    }, true);
    // NEVER send the delegated token to a Telegram browser, logs or a user.
    return Object.freeze({ tenantId: decision.tenantId, delegatedBearerToken: decision.token });
  }
}

module.exports = { BusinessOsSecurityGateway, SecurityBoundaryError };
