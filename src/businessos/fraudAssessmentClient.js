'use strict';

// Fraud Engine's verified, versioned REST contract:
// POST /v1/fraud/assessments, with X-Tenant-Id and Idempotency-Key.
// Intentionally not wired to the runtime. No actual assessment is initiated
// by Telegram or Express until the canonical payment request is available.

const ASSESSMENT_PATH = '/v1/fraud/assessments';
const DECISIONS = new Set(['APPROVE', 'CHALLENGE', 'REVIEW', 'DECLINE']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class FraudContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FraudContractError';
    this.code = code;
  }
}

function nonblank(value, limit = 256) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= limit && value.trim() === value && !/[\r\n]/.test(value);
}

function decimal(value) {
  return typeof value === 'string' &&
    /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value) &&
    Number.isFinite(Number(value)) && Number(value) > 0;
}

function validateAssessmentRequest(request) {
  const fail = () => { throw new FraudContractError('FRAUD_CONTRACT_INVALID'); };
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail();
  if (!nonblank(request.paymentId) || !nonblank(request.merchantId) ||
      !nonblank(request.customerId) || !request.amount ||
      !decimal(request.amount.value) || !/^[A-Z]{3}$/.test(request.amount.currency || '') ||
      !request.method || request.method.type !== 'CARD' ||
      !nonblank(request.method.vaultToken) ||
      !/^\d{6,8}$/.test(request.method.bin || '') ||
      !/^\d{4}$/.test(request.method.last4 || '') ||
      !request.device || !nonblank(request.device.fingerprint) ||
      !nonblank(request.device.ip) ||
      !nonblank(request.occurredAt) ||
      !Number.isFinite(Date.parse(request.occurredAt))) fail();

  // Send only the actual Java DTO; no Telegram, raw PAN, CVV or actor grants.
  return {
    paymentId: request.paymentId,
    merchantId: request.merchantId,
    customerId: request.customerId,
    amount: { value: request.amount.value, currency: request.amount.currency },
    method: {
      type: 'CARD', vaultToken: request.method.vaultToken,
      bin: request.method.bin, last4: request.method.last4,
    },
    device: { fingerprint: request.device.fingerprint, ip: request.device.ip },
    occurredAt: request.occurredAt,
  };
}

function validateAssessmentResponse(result) {
  if (!result || typeof result !== 'object' || !UUID_PATTERN.test(result.assessmentId || '') ||
      !DECISIONS.has(result.decision) || !Number.isFinite(result.score) ||
      result.score < 0 || result.score > 1 ||
      !nonblank(result.modelVersion) ||
      !Array.isArray(result.reasons) ||
      !result.reasons.every(x => x && nonblank(x.code) && nonblank(x.description, 1000))) {
    throw new FraudContractError('FRAUD_RESPONSE_INVALID');
  }
  // A positive HTTP 200 is not automatically an APPROVE.
  return Object.freeze({
    assessmentId: result.assessmentId,
    decision: result.decision,
    score: result.score,
    modelVersion: result.modelVersion,
  });
}

class BusinessOsFraudAssessmentClient {
  constructor({
    enabled = false, baseUrl, tenantId, fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
  } = {}) {
    this.enabled = enabled === true;
    if (!this.enabled) return;
    let endpoint;
    try { endpoint = new URL(baseUrl); } catch (_) {
      throw new FraudContractError('FRAUD_CONFIG_INVALID');
    }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
        endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
        !nonblank(tenantId) || !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 || timeoutMs > 30000 || typeof fetchImpl !== 'function') {
      throw new FraudContractError('FRAUD_CONFIG_INVALID');
    }
    this.url = new URL(ASSESSMENT_PATH, endpoint).toString();
    this.tenantId = tenantId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async assess(request, idempotencyKey) {
    if (!this.enabled) throw new FraudContractError('FRAUD_DISABLED');
    if (!nonblank(idempotencyKey, 128)) {
      throw new FraudContractError('FRAUD_CONTRACT_INVALID');
    }
    const body = validateAssessmentRequest(request);
    let response;
    try {
      // Exactly one POST: never invent a new key or silently retry a timeout.
      // Idempotency is the Fraud Engine's (tenantId, key) durable authority.
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Tenant-Id': this.tenantId,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (_) {
      throw new FraudContractError('FRAUD_OUTCOME_UNKNOWN');
    }
    if (response.status === 409) throw new FraudContractError('FRAUD_IDEMPOTENCY_CONFLICT');
    if (response.status === 400 || response.status === 422) {
      throw new FraudContractError('FRAUD_REQUEST_REJECTED');
    }
    if (response.status !== 200) throw new FraudContractError('FRAUD_OUTCOME_UNKNOWN');
    let result;
    try { result = await response.json(); } catch (_) {
      throw new FraudContractError('FRAUD_OUTCOME_UNKNOWN');
    }
    return validateAssessmentResponse(result);
  }
}

module.exports = {
  BusinessOsFraudAssessmentClient,
  FraudContractError,
  validateAssessmentRequest,
  validateAssessmentResponse,
};
