'use strict';

// F06b-01: proposed CustomerVault customer-association consumer boundary.
// This is NOT an existing Payment Engine HTTP API or a network client.
// The only acceptable future reader is an independently authenticated,
// tenant-scoped BusinessOS backend adapter. NEVER query private Java tables.
// No financial effect, token, PAN, CVV, PIN or provider operation lives here.

class CustomerVaultBoundaryError extends Error {
  constructor(code) {super(code);this.name='CustomerVaultBoundaryError';this.code=code;}
}
function id(value) {
  return typeof value==='string' && value.length>=1 && value.length<=128 &&
    value.trim()===value && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}
function throwInvalid() {
  throw new CustomerVaultBoundaryError('CUSTOMER_VAULT_BINDING_INVALID');
}
function validateIntent({tenantId,actorId,merchantId}={}) {
  if(!id(tenantId)||!id(actorId)||!id(merchantId)) {
    throw new CustomerVaultBoundaryError('CUSTOMER_VAULT_REQUEST_INVALID');
  }
  return Object.freeze({tenantId,actorId,merchantId});
}
const VERSION='businessos.customer-vault.association.v1';
function validateReply(data,intent,nowMs,maxAgeMs) {
  if(!data || typeof data!=='object' || Array.isArray(data))throwInvalid();
  if(data.contractVersion!==VERSION || data.tenantId!==intent.tenantId ||
     data.actorId!==intent.actorId || data.merchantId!==intent.merchantId ||
     !id(data.customerId) || !id(data.providerAccountId) ||
     data.status!=='ACTIVE' || data.associationStatus!=='ACTIVE' ||
     !Number.isSafeInteger(data.associationVersion) || data.associationVersion<=0 ||
     typeof data.validatedAt!=='string' ||
     !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(data.validatedAt)) {
    throwInvalid();
  }
  const at=Date.parse(data.validatedAt);
  if(!Number.isFinite(at) || new Date(at).toISOString() !== new Date(data.validatedAt).toISOString() ||
     at>nowMs+30000 || nowMs-at>maxAgeMs) throwInvalid();
  // Transport may return extra internal fields; we never expose them.
  // The backend itself is responsible for proving the association:
  // status, membership lifecycle, merchant and provider-account authority.
  return Object.freeze({
    tenantId:intent.tenantId,actorId:intent.actorId,merchantId:intent.merchantId,
    customerId:data.customerId,providerAccountId:data.providerAccountId,
    status:'ACTIVE',
  });
}

class CustomerVaultAssociationPort {
  constructor({enabled=false,reader,now=Date.now,maxAgeMs=30000}={}){
    this.enabled=enabled===true;
    if(!this.enabled)return;
    if(!reader || typeof reader.lookupCustomerAssociation!=='function' ||
       typeof now!=='function' ||
       !Number.isSafeInteger(maxAgeMs) || maxAgeMs<1 || maxAgeMs>300000) {
      throw new CustomerVaultBoundaryError('CUSTOMER_VAULT_BACKEND_NOT_CONFIGURED');
    }
    this.reader=reader;
    this.now=now;
    this.maxAgeMs=maxAgeMs;
  }

  async resolve(input){
    if(!this.enabled)throw new CustomerVaultBoundaryError('CUSTOMER_VAULT_DISABLED');
    const intent=validateIntent(input);
    let data;
    try {
      // Exactly one read. No uncontrolled fallback, self-provisioning,
      // cache, retry, cross-tenant lookup or inferred customer ID.
      data=await this.reader.lookupCustomerAssociation(intent);
    }catch(_){
      throw new CustomerVaultBoundaryError('CUSTOMER_VAULT_UNAVAILABLE');
    }
    let currentTime;
    try {currentTime=this.now();}catch(_){
      throw new CustomerVaultBoundaryError('CUSTOMER_VAULT_CLOCK_INVALID');
    }
    if(!Number.isSafeInteger(currentTime)) {
      throw new CustomerVaultBoundaryError('CUSTOMER_VAULT_CLOCK_INVALID');
    }
    return validateReply(data,intent,currentTime,this.maxAgeMs);
  }
}
module.exports={CustomerVaultAssociationPort,CustomerVaultBoundaryError,VERSION};
