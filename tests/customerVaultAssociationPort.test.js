'use strict';

const {describe,it}=require('node:test');
const assert=require('node:assert/strict');
const {CustomerVaultAssociationPort,CustomerVaultBoundaryError,VERSION}
  =require('../src/businessos/customerVaultAssociationPort');
const {TelegramBusinessOsIdentityPreflight}
  =require('../src/businessos/telegramIdentityPreflight');
const crypto=require('node:crypto');

const NOW=Date.parse('2026-10-28T22:00:00.000Z');
const input=Object.freeze({
  tenantId:'tenant-A',actorId:'actor-A',merchantId:'merchant-A',
});
function response(changes={}){
  return {
    contractVersion:VERSION,
    tenantId:'tenant-A',
    actorId:'actor-A',
    merchantId:'merchant-A',
    customerId:'customer-A',
    providerAccountId:'provider-A',
    status:'ACTIVE',associationStatus:'ACTIVE',associationVersion:3,
    validatedAt:new Date(NOW-1000).toISOString(),
    ...changes,
  };
}
function make(reader,changes={}){
  return new CustomerVaultAssociationPort({enabled:true,
    reader:{lookupCustomerAssociation:reader},now:()=>NOW,...changes});
}

describe('F06b-01 CustomerVault association contract (unimplemented backend)',()=>{
  it('is disabled by default and never attempts an implicit network call',async()=>{
    let calls=0;
    const p=new CustomerVaultAssociationPort({
      reader:{lookupCustomerAssociation:async()=>{calls++;return response();}},
    });
    await assert.rejects(p.resolve(input),e=>e.code==='CUSTOMER_VAULT_DISABLED');
    assert.equal(calls,0);
    assert.throws(()=>new CustomerVaultAssociationPort({enabled:true}),
      e=>e.code==='CUSTOMER_VAULT_BACKEND_NOT_CONFIGURED');
    assert.throws(()=>new CustomerVaultAssociationPort({
      enabled:true,reader:{},now:()=>NOW,
    }),e=>e.code==='CUSTOMER_VAULT_BACKEND_NOT_CONFIGURED');
  });

  it('forwards only immutable server-scoped keys in the exact declared contract',async()=>{
    let calls=0;
    const port=make(async requested=>{
      calls++;
      assert.deepEqual(requested,input);
      assert.equal(Object.isFrozen(requested),true);
      return response({rawPan:'4111111111111111',jwt:'private-service-token',
        cvv:'123',createdBy:'forged'});
    });
    const result=await port.resolve({...input,
      customerId:'attacker-supplied',tenantIdHint:'tenant-other',
      vaultToken:'self-asserted',fraudDecision:'APPROVE',paid:true,
    });
    assert.deepEqual(result,{
      ...input,customerId:'customer-A',providerAccountId:'provider-A',
      status:'ACTIVE',
    });
    assert.equal(Object.isFrozen(result),true);
    assert.equal(calls,1);
    for(const key of ['cvv','jwt','rawPan','vaultToken','fraudDecision','paid'])
      assert.equal(Object.hasOwn(result,key),false);
  });

  it('rejects any malformed or injected customer lookup intent before the backend',async()=>{
    let calls=0;
    const port=make(async()=>{calls++;return response();});
    for(const bad of [
      {...input,tenantId:''}, {...input,actorId:null},
      {...input,merchantId:'a/b'}, {...input,merchantId:'merchant-A\nBearer x'},
      {...input,tenantId:' tenant-A'}, {...input,actorId:42},
      {...input,merchantId:'x'.repeat(129)},
    ]){
      await assert.rejects(port.resolve(bad),
        e=>e.code==='CUSTOMER_VAULT_REQUEST_INVALID');
    }
    assert.equal(calls,0);
  });

  it('rejects cross-tenant, actor and merchant substitution in backend response',async()=>{
    for(const changes of [
      {tenantId:'tenant-B'}, {actorId:'actor-B'}, {merchantId:'merchant-B'},
      {customerId:''},{providerAccountId:''},{customerId:'a/b'},
      {providerAccountId:'provider-other\nsecret'},
    ]){
      let calls=0;
      const port=make(async()=>{calls++;return response(changes);});
      await assert.rejects(port.resolve(input),
        e=>e.code==='CUSTOMER_VAULT_BINDING_INVALID');
      assert.equal(calls,1);
    }
  });

  it('rejects PENDING, UNKNOWN, DELETED, FAILED and claimed chargeable lifecycles',async()=>{
    for(const status of ['CREATING','UNKNOWN','FAILED','DELETED','PENDING','CHARGEABLE']){
      for(const field of ['status','associationStatus']){
        const port=make(async()=>response({[field]:status}));
        await assert.rejects(port.resolve(input),
          e=>e.code==='CUSTOMER_VAULT_BINDING_INVALID');
      }
    }
  });

  it('requires a versioned contract, positive association version and fresh backend evidence',async()=>{
    for(const changes of [
      {contractVersion:'v0'}, {contractVersion:null},
      {associationVersion:0}, {associationVersion:-1},
      {associationVersion:1.1}, {associationVersion:'2'},
      {validatedAt:'tomorrow'}, {validatedAt:null},
      {validatedAt:'2026-02-30T21:00:00Z'},
      {validatedAt:new Date(NOW-31000).toISOString()},
      {validatedAt:new Date(NOW+31000).toISOString()},
    ]){
      const port=make(async()=>response(changes));
      await assert.rejects(port.resolve(input),
        e=>e.code==='CUSTOMER_VAULT_BINDING_INVALID');
    }
  });

  it('rejects authority outages and secrets in errors without fallback or retry',async()=>{
    for(const problem of ['GET_DENIED','HTTP_401','HTTP_403','HTTP_404','HTTP_503','TIMEOUT']){
      let calls=0;
      const port=make(async()=>{calls++;throw Error('private provider bearer '+problem);});
      await assert.rejects(port.resolve(input),e=>
        e.code==='CUSTOMER_VAULT_UNAVAILABLE' && !e.message.includes('bearer'));
      assert.equal(calls,1);
    }
  });

  it('rejects missing, malformed and non-object authority results',async()=>{
    for(const result of [null,undefined,{},[],true,'ACTIVE',
      {status:'ACTIVE'},response({providerAccountId:null})]){
      const port=make(async()=>result);
      await assert.rejects(port.resolve(input),
        e=>e.code==='CUSTOMER_VAULT_BINDING_INVALID');
    }
  });

  it('fails closed on corrupted trusted clock and invalid freshness limits',async()=>{
    for(const now of [NaN,Infinity,'2026',NOW+0.5]){
      const port=make(async()=>response(),{now:()=>now});
      await assert.rejects(port.resolve(input),
        e=>e.code==='CUSTOMER_VAULT_CLOCK_INVALID');
    }
    assert.throws(()=>make(async()=>response(),{maxAgeMs:0}),
      e=>e.code==='CUSTOMER_VAULT_BACKEND_NOT_CONFIGURED');
    assert.throws(()=>make(async()=>response(),{maxAgeMs:900000}),
      e=>e.code==='CUSTOMER_VAULT_BACKEND_NOT_CONFIGURED');
  });

  it('is a read-only dependency of F06a and returns NO_PAYMENT even on perfect mocked association',async()=>{
    const TOKEN='111111:fixture-bot';
    const mini=new URLSearchParams({
      auth_date:String(Math.floor(Date.now()/1000)-2),
      user:JSON.stringify({id:91234001,first_name:'CI'}),
    });
    const canonical=[...mini.entries()].sort(([a],[b])=>a.localeCompare(b,'en'))
      .map(([k,v])=>k+'='+v).join('\n');
    const key=crypto.createHmac('sha256','WebAppData').update(TOKEN).digest();
    mini.set('hash',crypto.createHmac('sha256',key).update(canonical).digest('hex'));
    let calls=0;
    const port=new CustomerVaultAssociationPort({
      enabled:true,now:Date.now,reader:{lookupCustomerAssociation:async intent=>{
        calls++;
        assert.deepEqual(intent,input);
        return response({validatedAt:new Date().toISOString()});
      }},
    });
    const preflight=new TelegramBusinessOsIdentityPreflight({
      enabled:true,telegramBotToken:TOKEN,
      redemptionAuthority:{findRedemption:async()=>({
        demoInviteId:'da78a47d-cb94-4dcc-a760-df6a49c34f79',
        payerTelegramId:91234001,status:'DEMO_REDEEMED_NO_PAYMENT',
      })},
      merchantAuthority:{resolve:async()=>({
        tenantId:'tenant-A',merchantId:'merchant-A',targetType:'MERCHANT_ACCOUNT',
        status:'ACTIVE',
      })},
      securityGateway:{authorizeTelegramInitData:async()=>({
        tenantId:'tenant-A',actorId:'actor-A',membershipId:'member-A',
        actorType:'USER',targetId:'merchant-A',targetType:'MERCHANT_ACCOUNT',
      })},
      customerAuthority:port,
    });
    const out=await preflight.verify({
      signedTelegramInitData:mini.toString(),
      demoInviteId:'da78a47d-cb94-4dcc-a760-df6a49c34f79',
      tenantId:'forged',customerId:'forged',paid:true,
    });
    assert.equal(out.identityVerified,true);
    assert.equal(out.financialAuthorization,false);
    assert.equal(Object.hasOwn(out,'customerId'),false);
    assert.equal(calls,1);
  });
});
