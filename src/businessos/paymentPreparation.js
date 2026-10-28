'use strict';

// F04: prepare a canonical payment only. Never execute a PSP payment here.
// These port interfaces MUST be implemented by durable, server-authoritative
// BusinessOS services. They are not wired to Express or Telegraf.

class PaymentPreparationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PaymentPreparationError';
    this.code = code;
  }
}

function nonblank(v, max = 128) {
  return typeof v === 'string' && v.length > 0 && v.length <= max &&
    v.trim() === v && !/[\r\n]/.test(v);
}

function centsToDecimal(cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new PaymentPreparationError('CANONICAL_PAYMENT_INVALID');
  }
  const whole = Math.floor(cents / 100);
  return String(whole) + '.' + String(cents % 100).padStart(2, '0');
}

function canonicalRequest(req, requestId) {
  if (!req || !nonblank(req.id) || req.id !== requestId ||
      !nonblank(req.tenantId) || !nonblank(req.merchantId) ||
      !nonblank(req.payerActorId) || !nonblank(req.riskIdempotencyKey) ||
      !nonblank(req.currency) || req.currency !== 'MXN' ||
      !nonblank(req.occurredAt, 64) ||
      !Number.isFinite(Date.parse(req.occurredAt))) {
    throw new PaymentPreparationError('CANONICAL_PAYMENT_INVALID');
  }
  centsToDecimal(req.amountCents);
}

function ensureMethod(method, customerId, request) {
  if (!method || method.customerId !== customerId ||
      method.tenantId !== request.tenantId ||
      !nonblank(method.vaultToken) ||
      !/^\d{6,8}$/.test(method.bin || '') ||
      !/^\d{4}$/.test(method.last4 || '') ||
      !nonblank(method.deviceFingerprint) ||
      !nonblank(method.clientIp)) {
    throw new PaymentPreparationError('CUSTOMER_METHOD_NOT_VERIFIED');
  }
}

class BusinessOsPaymentPreparation {
  constructor({
    enabled = false, securityGateway, requestAuthority,
    customerAuthority, methodAuthority, fraudClient,
  } = {}) {
    this.enabled = enabled === true;
    if (!this.enabled) return;
    if (!securityGateway || typeof securityGateway.authorizeTelegramInitData !== 'function' ||
        !requestAuthority || typeof requestAuthority.loadById !== 'function' ||
        !customerAuthority || typeof customerAuthority.resolve !== 'function' ||
        !methodAuthority || typeof methodAuthority.resolve !== 'function' ||
        !fraudClient || typeof fraudClient.assess !== 'function') {
      throw new PaymentPreparationError('PREPARATION_PORTS_NOT_CONFIGURED');
    }
    this.securityGateway = securityGateway;
    this.requestAuthority = requestAuthority;
    this.customerAuthority = customerAuthority;
    this.methodAuthority = methodAuthority;
    this.fraudClient = fraudClient;
  }

  async prepare({ signedTelegramInitData, requestId } = {}) {
    if (!this.enabled) throw new PaymentPreparationError('PREPARATION_DISABLED');
    if (!nonblank(requestId) || !nonblank(signedTelegramInitData, 8192)) {
      throw new PaymentPreparationError('PREPARATION_INPUT_INVALID');
    }

    // The incoming requestId is only a locator. The immutable amount, tenant,
    // payer, merchant and risk key MUST come from a canonical durable record.
    let req;
    try {
      req = await this.requestAuthority.loadById(requestId);
    } catch (_) {
      throw new PaymentPreparationError('CANONICAL_PAYMENT_UNAVAILABLE');
    }
    canonicalRequest(req, requestId);

    // Signed Telegram identity is checked inside Security Gateway. The PDP
    // independently maps the external actor to canonical BusinessOS grants.
    const actor = await this.securityGateway.authorizeTelegramInitData(
      signedTelegramInitData, req.merchantId
    );
    if (!actor || actor.tenantId !== req.tenantId ||
        actor.targetId !== req.merchantId ||
        actor.actorId !== req.payerActorId ||
        actor.actorType !== 'USER') {
      throw new PaymentPreparationError('PAYMENT_ACTOR_NOT_AUTHORIZED');
    }

    const customer = await this.customerAuthority.resolve({
      tenantId: req.tenantId,
      actorId: actor.actorId,
      merchantId: req.merchantId,
    });
    if (!customer || !nonblank(customer.customerId) ||
        customer.tenantId !== req.tenantId ||
        customer.actorId !== actor.actorId) {
      throw new PaymentPreparationError('CUSTOMER_BINDING_UNVERIFIED');
    }

    const method = await this.methodAuthority.resolve({
      tenantId: req.tenantId,
      customerId: customer.customerId,
      merchantId: req.merchantId,
      requestId: req.id,
    });
    ensureMethod(method, customer.customerId, req);

    // The fraud service owns the decision. Never supply APPROVE ourselves.
    const risk = await this.fraudClient.assess({
      paymentId: req.id,
      merchantId: req.merchantId,
      customerId: customer.customerId,
      amount: { value: centsToDecimal(req.amountCents), currency: req.currency },
      method: {
        type: 'CARD', vaultToken: method.vaultToken,
        bin: method.bin, last4: method.last4,
      },
      device: { fingerprint: method.deviceFingerprint, ip: method.clientIp },
      occurredAt: req.occurredAt,
    }, req.riskIdempotencyKey);

    if (!risk || !nonblank(risk.assessmentId) ||
        !['APPROVE', 'CHALLENGE', 'REVIEW', 'DECLINE'].includes(risk.decision)) {
      throw new PaymentPreparationError('RISK_EVIDENCE_INVALID');
    }
    // A result is a preparation/projection ONLY, not Payment AUTHORIZED or PAID.
    return Object.freeze({
      status: risk.decision === 'APPROVE' ? 'RISK_APPROVED_NOT_AUTHORIZED'
        : 'RISK_HOLD_NO_PAYMENT',
      riskDecision: risk.decision,
      fraudAssessmentId: risk.assessmentId,
      paymentReference: req.id,
      tenantId: req.tenantId,
      // No card token, PIN, actor credentials, delegated token, PSP reference.
    });
  }
}

module.exports = { BusinessOsPaymentPreparation, PaymentPreparationError, centsToDecimal };
