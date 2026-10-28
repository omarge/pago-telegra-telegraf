'use strict';

// Contract-only adapter. Nothing invokes it from the Telegram or Express handlers.
// Financial dispatch remains disabled unless an authorized caller explicitly enables it.
const AUTHORIZATION_PATH = '/internal/v1/payment-authorizations';
const AUTHORIZATION_FIELDS = [
  'tenantId', 'paymentIntentId', 'paymentAttemptId', 'amount', 'currency',
  'paymentMethodType', 'paymentChannel', 'businessReferenceType',
  'businessReference', 'idempotencyKey', 'paymentMethodReferenceProvider',
  'paymentMethodReference', 'description', 'fraudDeviceSessionReference',
  'clientIpAddress', 'fraudAssessmentId', 'fraudDecision', 'customerId',
];
const REQUIRED = [
  'tenantId', 'paymentIntentId', 'paymentAttemptId', 'currency',
  'businessReferenceType', 'businessReference', 'idempotencyKey',
  'paymentMethodReferenceProvider', 'paymentMethodReference',
  'clientIpAddress', 'fraudAssessmentId', 'customerId',
];
const RESPONSE_STATUS = new Map([
  [200, new Set(['AUTHORIZED', 'DECLINED', 'UNKNOWN'])],
  [409, new Set(['CONFLICT'])],
  [422, new Set(['PRE_EXECUTION_FAILED', 'DENIED'])],
]);

class BusinessOsIntegrationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BusinessOsIntegrationError';
    this.code = code;
  }
}

function validateAuthorization(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new BusinessOsIntegrationError('INVALID_CONTRACT');
  }
  for (const field of REQUIRED) {
    if (typeof request[field] !== 'string' || !request[field].trim()) {
      throw new BusinessOsIntegrationError('INVALID_CONTRACT');
    }
  }
  // Exact decimal string: never derive money from JavaScript floating-point input.
  if (typeof request.amount !== 'string' ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(request.amount) ||
      Number(request.amount) <= 0 || !Number.isFinite(Number(request.amount))) {
    throw new BusinessOsIntegrationError('INVALID_CONTRACT');
  }
  if (request.paymentMethodType !== 'CARD' ||
      !['PAYMENT_LINK', 'WEB'].includes(request.paymentChannel) ||
      request.fraudDecision !== 'APPROVE') {
    throw new BusinessOsIntegrationError('INVALID_CONTRACT');
  }
  // Only send the Java PaymentAuthorizationRequest field allowlist.
  // A browser-supplied PAN/CVV or untrusted fraud decision must never be passed here.
  return Object.fromEntries(
    AUTHORIZATION_FIELDS.filter((field) => request[field] !== undefined)
      .map((field) => [field, request[field]])
  );
}

class BusinessOsPaymentAuthorizationClient {
  constructor({
    enabled = false,
    baseUrl,
    delegatedBearerToken,
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
  } = {}) {
    this.enabled = enabled === true;
    if (!this.enabled) return;
    let url;
    try {
      url = new URL(baseUrl);
    } catch (_) {
      throw new BusinessOsIntegrationError('INVALID_ENDPOINT');
    }
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      throw new BusinessOsIntegrationError('INVALID_ENDPOINT');
    }
    if (typeof delegatedBearerToken !== 'string' || !delegatedBearerToken.trim()) {
      throw new BusinessOsIntegrationError('AUTH_NOT_CONFIGURED');
    }
    if (typeof fetchImpl !== 'function' ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      throw new BusinessOsIntegrationError('INVALID_CONFIGURATION');
    }
    this.endpoint = new URL(AUTHORIZATION_PATH, url).toString();
    this.delegatedBearerToken = delegatedBearerToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async authorize(request) {
    if (!this.enabled) throw new BusinessOsIntegrationError('INTEGRATION_DISABLED');
    const body = validateAuthorization(request);
    let response;
    try {
      // Exactly one POST. NEVER blindly retry a request with an uncertain PSP outcome.
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.delegatedBearerToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (_) {
      throw new BusinessOsIntegrationError('UNKNOWN_REMOTE_OUTCOME');
    }

    if (response.status === 401 || response.status === 403) {
      throw new BusinessOsIntegrationError('AUTH_DENIED');
    }
    if (!RESPONSE_STATUS.has(response.status)) {
      // 5xx, unexpected HTTP statuses and transport ambiguity are never PAID/DECLINED.
      throw new BusinessOsIntegrationError('UNKNOWN_REMOTE_OUTCOME');
    }

    let result;
    try {
      result = await response.json();
    } catch (_) {
      throw new BusinessOsIntegrationError('UNKNOWN_REMOTE_OUTCOME');
    }
    if (!result || !RESPONSE_STATUS.get(response.status).has(result.status)) {
      throw new BusinessOsIntegrationError('UNKNOWN_REMOTE_OUTCOME');
    }
    // An authorization is NOT a settlement confirmation. Keep status semantic intact.
    return Object.freeze({
      authorizationStatus: result.status,
      paymentIntentId: result.paymentIntentId || null,
      paymentAttemptId: result.paymentAttemptId || null,
      providerReference: result.providerReference || null,
      correlationId: result.correlationId || null,
      unknownReconciliationReference: result.unknownReconciliationReference || null,
    });
  }
}

module.exports = {
  BusinessOsPaymentAuthorizationClient,
  BusinessOsIntegrationError,
  validateAuthorization,
};
