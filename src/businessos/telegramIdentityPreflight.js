'use strict';

// F06a: server-only identity preflight, NOT a payment/customer provisioning API.
// It MUST NOT be wired to any public Telegram /start or demo invitation route.
// The signed MiniApp user is compared with a persisted one-time demo claim.
// A separately approved merchant binding and authoritative CustomerVault API
// are required. Neither exists as a certified external client in this repo.

const {verifyTelegramMiniAppInitData}=require('../telegram/miniAppIdentity');
class IdentityBindingError extends Error {
  constructor(code){super(code);this.name='IdentityBindingError';this.code=code;}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function nonblank(s,max=128){
  return typeof s==='string' && s.length>0 && s.length<=max &&
    s.trim()===s && !/[\r\n\x00]/.test(s);
}
function assertActor(actor,expected){
  if(!actor || actor.actorType!=='USER' || !nonblank(actor.actorId) ||
     !nonblank(actor.membershipId) || actor.tenantId!==expected.tenantId ||
     actor.targetId!==expected.merchantId ||
     actor.targetType!==expected.targetType){
    throw new IdentityBindingError('SECURITY_ACTOR_MISMATCH');
  }
}
function assertCustomer(customer,actor,expected) {
  if(!customer || customer.status!=='ACTIVE' ||
     !nonblank(customer.customerId) || !nonblank(customer.providerAccountId) ||
     customer.actorId!==actor.actorId ||
     customer.tenantId!==expected.tenantId ||
     customer.merchantId!==expected.merchantId){
    throw new IdentityBindingError('CUSTOMER_BINDING_UNVERIFIED');
  }
  return customer.customerId;
}

class TelegramBusinessOsIdentityPreflight {
  constructor({enabled=false,telegramBotToken,redemptionAuthority,
    merchantAuthority,securityGateway,customerAuthority}={}){
    this.enabled=enabled===true;
    if(!this.enabled)return;
    if(!nonblank(telegramBotToken,512) ||
       !redemptionAuthority || typeof redemptionAuthority.findRedemption!=='function' ||
       !merchantAuthority || typeof merchantAuthority.resolve!=='function' ||
       !securityGateway || typeof securityGateway.authorizeTelegramInitData!=='function' ||
       !customerAuthority || typeof customerAuthority.resolve!=='function'){
      throw new IdentityBindingError('IDENTITY_PREFLIGHT_NOT_CONFIGURED');
    }
    this.telegramBotToken=telegramBotToken;
    this.redemptionAuthority=redemptionAuthority;
    this.merchantAuthority=merchantAuthority;
    this.securityGateway=securityGateway;
    this.customerAuthority=customerAuthority;
  }

  async verify({signedTelegramInitData,demoInviteId}={}){
    if(!this.enabled)throw new IdentityBindingError('IDENTITY_PREFLIGHT_DISABLED');
    if(!UUID.test(demoInviteId||''))throw new IdentityBindingError('IDENTITY_INPUT_INVALID');
    let signed;
    try{signed=verifyTelegramMiniAppInitData(signedTelegramInitData,this.telegramBotToken);}
    catch(_){throw new IdentityBindingError('TELEGRAM_IDENTITY_NOT_VERIFIED');}

    let claim;
    try{claim=await this.redemptionAuthority.findRedemption(demoInviteId);}
    catch(_){throw new IdentityBindingError('DEMO_REDEMPTION_UNAVAILABLE');}
    const telegramId=Number(signed.telegramUserId);
    if(!claim || claim.demoInviteId!==demoInviteId ||
       claim.status!=='DEMO_REDEEMED_NO_PAYMENT' ||
       !Number.isSafeInteger(claim.payerTelegramId) ||
       claim.payerTelegramId!==telegramId){
      throw new IdentityBindingError('DEMO_PAYER_MISMATCH');
    }

    // The demo record has no merchant/tenant authority. This is a separately
    // provisioned, trusted adapter; no browser-supplied tenant is consulted.
    let merchant;
    try{merchant=await this.merchantAuthority.resolve({demoInviteId});}
    catch(_){throw new IdentityBindingError('MERCHANT_BINDING_UNAVAILABLE');}
    if(!merchant || merchant.status!=='ACTIVE' ||
       !nonblank(merchant.tenantId) || !nonblank(merchant.merchantId) ||
       !nonblank(merchant.targetType) || merchant.targetType!=='MERCHANT_ACCOUNT'){
      throw new IdentityBindingError('MERCHANT_BINDING_UNVERIFIED');
    }

    let actor;
    try{
      actor=await this.securityGateway.authorizeTelegramInitData(
        signedTelegramInitData,merchant.merchantId);
    }catch(_){throw new IdentityBindingError('SECURITY_AUTHORITY_UNAVAILABLE');}
    assertActor(actor,merchant);

    let customer;
    try{
      customer=await this.customerAuthority.resolve({
        tenantId:actor.tenantId,actorId:actor.actorId,
        merchantId:merchant.merchantId,
      });
    }catch(_){throw new IdentityBindingError('CUSTOMER_AUTHORITY_UNAVAILABLE');}
    assertCustomer(customer,actor,merchant);

    // Do not expose canonical customerId/card/vault references to a browser.
    // This is NOT authorization to debit, nor a guarantee of live backend.
    return Object.freeze({
      status:'IDENTITY_PREFLIGHT_ONLY_NO_PAYMENT',
      demoInviteId,
      identityVerified:true,
      financialAuthorization:false,
    });
  }
}
module.exports={TelegramBusinessOsIdentityPreflight,IdentityBindingError};
