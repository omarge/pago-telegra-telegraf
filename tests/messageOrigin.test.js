'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {messageOriginKey}=require('../src/messageOrigin');
test('same source payment message has one identity',()=>{
 const o={tenant:'t1',channel:'TELEGRAM',actorId:'123',messageId:'456'};
 assert.equal(messageOriginKey(o),messageOriginKey({...o}));
 for(const field of Object.keys(o))assert.notEqual(messageOriginKey(o),messageOriginKey({...o,[field]:o[field]+'x'}));
 assert.ok(!messageOriginKey(o).includes('123'));
});
test('reject absent/untrusted origin',()=>assert.throws(()=>messageOriginKey({tenant:'t1',channel:'TELEGRAM',actorId:'',messageId:'m'})));
