'use strict';

const {describe,it,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {TelegramBusinessOsIdentityPreflight}=require('../src/businessos/telegramIdentityPreflight');
const {PostgresTelegramInbox}=require('../src/telegram/postgresInbox');
const {PostgresDemoInviteAuthority}=require('../src/telegram/postgresDemoInvites');

const BOT_TOKEN='1234567:ci-only-not-real';
const SECRET=crypto.randomBytes(32).toString('hex');
const ENC=crypto.randomBytes(32).toString('hex');
const DEMO_ID='da78a47d-cb94-4dcc-a760-df6a49c34f79';
function signed(id=91234001,date=Math.floor(Date.now()/1000)-5){
  const fields=new URLSearchParams({auth_date:String(date),
    user:JSON.stringify({id,first_name:'CI'})});
  const payload=[...fields.entries()].sort(([a],[b])=>a.localeCompare(b,'en'))
    .map(([k,v])=>k+'='+v).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  fields.set('hash',crypto.createHmac('sha256',secret).update(payload).digest('hex'));
  return fields.toString();
}
function ports(changes={}){
  const calls={redeem:0,merchant:0,security:0,customer:0};
  const redemption={demoInviteId:DEMO_ID,payerTelegramId:91234001,status:'DEMO_REDEEMED_NO_PAYMENT',
    ...changes.redemption};
  const merchant={tenantId:'tenant-A',merchantId:'merchant-A',targetType:'MERCHANT_ACCOUNT',
    status:'ACTIVE',...changes.merchant};
  const actor={tenantId:'tenant-A',actorId:'actor-A',membershipId:'membership-A',
    targetId:'merchant-A',targetType:'MERCHANT_ACCOUNT',actorType:'USER',...changes.actor};
  const customer={customerId:'customer-CANONICAL',providerAccountId:'provider-account-A',
    status:'ACTIVE',tenantId:'tenant-A',actorId:'actor-A',merchantId:'merchant-A',
    ...changes.customer};
  const preflight=new TelegramBusinessOsIdentityPreflight({
    enabled:true,telegramBotToken:BOT_TOKEN,
    redemptionAuthority:{findRedemption:async id=>{
      calls.redeem++;assert.equal(id,DEMO_ID);
      if(changes.fail==='redeem')throw Error('database-secret');
      return redemption;
    }},
    merchantAuthority:{resolve:async ({demoInviteId})=>{
      calls.merchant++;assert.equal(demoInviteId,DEMO_ID);
      if(changes.fail==='merchant')throw Error('upstream-secret');
      return merchant;
    }},
    securityGateway:{authorizeTelegramInitData:async (data,targetId)=>{
      calls.security++;assert.equal(targetId,'merchant-A');
      assert.equal(data,signed());
      if(changes.fail==='security')throw Error('secret-bearer');
      return actor;
    }},
    customerAuthority:{resolve:async fields=>{
      calls.customer++;assert.deepEqual(fields,{
        tenantId:'tenant-A',actorId:'actor-A',merchantId:'merchant-A',
      });
      if(changes.fail==='customer')throw Error('vault-secret');
      return customer;
    }},
  });
  return {preflight,calls};
}
const args={signedTelegramInitData:signed(),demoInviteId:DEMO_ID};

describe('F06a signed Telegram to BusinessOS actor/customer preflight (no network)',()=>{
  it('is OFF by default and does not contact authorities',async()=>{
    const gate=new TelegramBusinessOsIdentityPreflight();
    await assert.rejects(gate.verify(args),e=>e.code==='IDENTITY_PREFLIGHT_DISABLED');
    assert.throws(()=>new TelegramBusinessOsIdentityPreflight({enabled:true}),
      e=>e.code==='IDENTITY_PREFLIGHT_NOT_CONFIGURED');
  });
  it('passes only after immutable demo claim, Security grant and canonical active customer binding',async()=>{
    const {preflight,calls}=ports();
    const result=await preflight.verify({...args,
      tenantId:'tenant-attacker',merchantId:'merchant-attacker',
      customerId:'customer-attacker',fraudDecision:'APPROVE',paid:true});
    assert.deepEqual(result,{
      status:'IDENTITY_PREFLIGHT_ONLY_NO_PAYMENT',
      demoInviteId:DEMO_ID,identityVerified:true,financialAuthorization:false,
    });
    assert.equal(Object.isFrozen(result),true);
    assert.ok(!JSON.stringify(result).includes('CANONICAL'));
    assert.ok(!Object.hasOwn(result,'actorId'));
    assert.deepEqual(calls,{redeem:1,merchant:1,security:1,customer:1});
  });
  it('rejects forged/stale signed Telegram initData before reading redemption',async()=>{
    for(const invalid of [signed().replace('91234001','91234002'),
      signed(91234001,Math.floor(Date.now()/1000)-4000),
      signed(99999999),'',null]){
      const {preflight,calls}=ports();
      await assert.rejects(preflight.verify({...args,signedTelegramInitData:invalid}),
        e=>['TELEGRAM_IDENTITY_NOT_VERIFIED','DEMO_PAYER_MISMATCH'].includes(e.code));
      if(invalid!==signed(99999999)) assert.equal(calls.security,0);
    }
  });
  it('rejects different real payer or missing claim before querying merchant, security or Vault',async()=>{
    for(const redemption of [{payerTelegramId:123456},
      {status:'DEMO_INVITE_ONLY_NO_PAYMENT'}, {demoInviteId:crypto.randomUUID()}]){
      const {preflight,calls}=ports({redemption});
      await assert.rejects(preflight.verify(args),e=>e.code==='DEMO_PAYER_MISMATCH');
      assert.equal(calls.merchant,0);assert.equal(calls.security,0);assert.equal(calls.customer,0);
    }
  });
  it('rejects absent or contradictory merchant binding before Security or Vault',async()=>{
    for(const merchant of [{status:'PENDING'},{tenantId:'wrong-tenant'},
      {merchantId:''},{targetType:'UNTRUSTED'}]){
      const {preflight,calls}=ports({merchant});
      if(merchant.tenantId==='wrong-tenant'){
        await assert.rejects(preflight.verify(args),e=>e.code==='SECURITY_ACTOR_MISMATCH');
        assert.equal(calls.customer,0);
      } else {
        await assert.rejects(preflight.verify(args),e=>e.code==='MERCHANT_BINDING_UNVERIFIED');
        assert.equal(calls.security,0);
      }
    }
  });
  it('rejects cross-tenant, wrong resource and absent RBAC membership',async()=>{
    for(const actor of [{tenantId:'tenant-other'},{targetId:'merchant-other'},
      {actorType:'INTEGRATION'},{membershipId:null},{targetType:'ACCOUNT'}]){
      const {preflight,calls}=ports({actor});
      await assert.rejects(preflight.verify(args),e=>e.code==='SECURITY_ACTOR_MISMATCH');
      assert.equal(calls.customer,0);
    }
  });
  it('rejects inactive, cross-tenant and substituted CustomerVault bindings',async()=>{
    for(const customer of [{status:'UNKNOWN'}, {status:'DELETED'},
      {customerId:'',status:'ACTIVE'}, {tenantId:'tenant-other'},
      {actorId:'actor-other'}, {merchantId:'merchant-other'}, {providerAccountId:null}]){
      const {preflight,calls}=ports({customer});
      await assert.rejects(preflight.verify(args),e=>e.code==='CUSTOMER_BINDING_UNVERIFIED');
      assert.equal(calls.customer,1);
    }
  });
  it('fails closed on backend outages with redacted messages',async()=>{
    for(const failure of ['redeem','merchant','security','customer']){
      const {preflight}=ports({fail:failure});
      await assert.rejects(preflight.verify(args),e=>
        ['DEMO_REDEMPTION_UNAVAILABLE','MERCHANT_BINDING_UNAVAILABLE',
          'SECURITY_AUTHORITY_UNAVAILABLE','CUSTOMER_AUTHORITY_UNAVAILABLE'].includes(e.code) &&
          !e.message.includes('secret'));
    }
  });
});

describe('F06a PostgreSQL-backed demo claim provenance',{
  skip:!process.env.F05_POSTGRES_URL,
},()=>{
  let admin,pool,schema,inbox,invites;
  before(async()=>{
    const {Pool}=require('pg');
    admin=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:2});
    schema='f06a_'+crypto.randomUUID().replaceAll('-','');
    await admin.query('CREATE SCHEMA "'+schema+'"');
    pool=new Pool({connectionString:process.env.F05_POSTGRES_URL,max:12,
      options:'-c search_path='+schema,connectionTimeoutMillis:5000});
    for(const file of ['f05b_telegram_durable_inbox.sql','f05e02_demo_invites.sql']){
      await pool.query(fs.readFileSync(path.join(__dirname,'..','sql',file),'utf8'));
    }
    inbox=new PostgresTelegramInbox({enabled:true,pool,encryptionKeyHex:ENC});
    invites=new PostgresDemoInviteAuthority({enabled:true,pool,tokenKeyHex:SECRET});
  });
  beforeEach(async()=>await pool.query('TRUNCATE kashbit_telegram_demo_claims,'+
    'kashbit_telegram_demo_invites,kashbit_telegram_inbox'));
  after(async()=>{
    if(pool)await pool.end();
    if(admin){if(schema)await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
  });

  it('cannot verify identity for an unredeemed invite and never upgrades demo claim to payment',async()=>{
    const source=crypto.randomInt(110000,220000);
    await inbox.append({update_id:source,message:{text:'demo'}});
    const claim=await inbox.claim();
    const created=await invites.createForClaim({updateId:source,
      inboxLeaseId:claim.leaseId,requesterTelegramId:12345,amountCents:1050});
    await inbox.ack(source,claim.leaseId);
    assert.equal(await invites.findRedemption(created.demoInviteId),null);
    const {preflight}=ports();
    // No claims from the demo record can be elevated to financial authority.
    const preflightUsingRealDb=new TelegramBusinessOsIdentityPreflight({
      enabled:true,telegramBotToken:BOT_TOKEN,
      redemptionAuthority:invites,
      merchantAuthority:{resolve:async()=>{throw Error('cannot reach merchant');}},
      securityGateway:{authorizeTelegramInitData:async()=>{throw Error('cannot reach security');}},
      customerAuthority:{resolve:async()=>{throw Error('cannot reach vault');}},
    });
    await assert.rejects(preflightUsingRealDb.verify({
      signedTelegramInitData:signed(),demoInviteId:created.demoInviteId,
    }),e=>e.code==='DEMO_PAYER_MISMATCH');
  });

  it('reads only a redeemed, fixed payer identity and requires matching MiniApp signature',async()=>{
    const source=crypto.randomInt(220001,330000);
    await inbox.append({update_id:source,message:{text:'demo'}});
    const first=await inbox.claim();
    const invite=await invites.createForClaim({updateId:source,
      inboxLeaseId:first.leaseId,requesterTelegramId:12345,amountCents:1050});
    await inbox.ack(first.updateId,first.leaseId);
    const redemptionId=source+1;
    await inbox.append({update_id:redemptionId,message:{text:'demo'}});
    const next=await inbox.claim();
    const redeemed=await invites.redeemForClaim({updateId:redemptionId,
      inboxLeaseId:next.leaseId,payerTelegramId:91234001,token:invite.token});
    assert.equal(redeemed.status,'DEMO_REDEEMED_NO_PAYMENT');
    await inbox.ack(next.updateId,next.leaseId);
    const persisted=await invites.findRedemption(invite.demoInviteId);
    assert.deepEqual(persisted,{
      demoInviteId:invite.demoInviteId,payerTelegramId:91234001,
      status:'DEMO_REDEEMED_NO_PAYMENT',
    });
    const testPorts=ports();
    const gate=new TelegramBusinessOsIdentityPreflight({
      enabled:true,telegramBotToken:BOT_TOKEN,
      redemptionAuthority:invites,
      merchantAuthority:{resolve:async()=>({
        tenantId:'tenant-A',merchantId:'merchant-A',targetType:'MERCHANT_ACCOUNT',status:'ACTIVE',
      })},
      securityGateway:{authorizeTelegramInitData:testPorts.preflight.securityGateway.authorizeTelegramInitData},
      customerAuthority:{resolve:testPorts.preflight.customerAuthority.resolve},
    });
    const ok=await gate.verify({signedTelegramInitData:signed(),demoInviteId:invite.demoInviteId});
    assert.equal(ok.financialAuthorization,false);
    await assert.rejects(gate.verify({
      signedTelegramInitData:signed(99112233),demoInviteId:invite.demoInviteId,
    }),e=>e.code==='DEMO_PAYER_MISMATCH');
    const rows=(await pool.query('SELECT COUNT(*)::int AS n FROM kashbit_telegram_demo_claims')).rows[0];
    assert.equal(rows.n,1);
  });
});
