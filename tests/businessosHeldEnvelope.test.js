'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {signHandoff,verifyHandoff,canonical}=require('../src/businessosHeldEnvelope');
const key='CI-only-hand-off-integrity-key-32-bytes-minimum';
const base={tenantId:'tenant1',operationId:'operation01',amountMinor:'4200',currency:'MXN',
 originKey:'msgv1_'+'a'.repeat(64),occurredAt:'2026-10-29T21:00:00Z'};
test('HELD payload authenticates exact tenant, operation, amount and origin',()=>{
 const v=signHandoff(base,key);assert.equal(verifyHandoff(v,key),true);
 for(const field of ['tenantId','operationId','amountMinor','currency','originKey','occurredAt']){
  const tampered={...v,payload:{...v.payload,[field]:field==='amountMinor'?'5200':v.payload[field]+'x'}};
  assert.equal(verifyHandoff(tampered,key),false,field);
 }
 assert.equal(verifyHandoff(v,'wrong-key-is-long-enough-to-verify-but-invalid'),false);
});
test('canonical boundaries and payload format reject malformed identity',()=>{
 assert.notEqual(canonical(base),canonical({...base,tenantId:'tenant2'}));
 assert.throws(()=>signHandoff({...base,amountMinor:'4.20'},key),/INVALID/);
 assert.throws(()=>signHandoff(base,'short'),/KEY_INVALID/);
});

test('reject unsigned envelope or payload extension instead of silently ignoring fields',()=>{
 const v=signHandoff(base,key);
 assert.equal(verifyHandoff({...v,executionAllowed:true},key),false);
 assert.equal(verifyHandoff({...v,payload:{...v.payload,merchantId:'attacker'}},key),false);
 assert.throws(()=>signHandoff({...base,merchantId:'untrusted'},key),/INVALID/);
 assert.throws(()=>signHandoff({...base,occurredAt:'2026-10-29T21:00:00Z-not-a-timestamp'},key),/INVALID/);
});
