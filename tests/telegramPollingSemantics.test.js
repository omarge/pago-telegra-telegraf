'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {processTelegramUpdatesInOrder}=require('../src/telegram/processUpdates');

describe('F05b Telegram legacy poller preserves pending update semantics',()=>{
  it('awaits each handler before advancing offset and preserves order',async()=>{
    const trace=[],offsets=[];
    const result=await processTelegramUpdatesInOrder(
      [{update_id:1},{update_id:3},{update_id:4}],
      async u=>{trace.push('start:'+u.update_id);
        await Promise.resolve();trace.push('done:'+u.update_id);},
      0,n=>{offsets.push(n);trace.push('offset:'+n);}
    );
    assert.equal(result,5);
    assert.deepEqual(offsets,[2,4,5]);
    assert.deepEqual(trace,[
      'start:1','done:1','offset:2',
      'start:3','done:3','offset:4',
      'start:4','done:4','offset:5',
    ]);
  });
  it('does not advance rejected update and stops later dispatch',async()=>{
    const seen=[],offsets=[];
    await assert.rejects(
      processTelegramUpdatesInOrder(
        [{update_id:10},{update_id:11},{update_id:12}],
        async u=>{seen.push(u.update_id);if(u.update_id===11)throw new Error('failed');},
        10,n=>offsets.push(n)
      ),/failed/);
    assert.deepEqual(seen,[10,11]);
    assert.deepEqual(offsets,[11]);
  });
  it('skips already processed duplicates and fails closed on corrupt updates',async()=>{
    const seen=[];
    await processTelegramUpdatesInOrder([{update_id:1},{update_id:2},{update_id:3}],
      async u=>{seen.push(u.update_id);},3,()=>{});
    assert.deepEqual(seen,[3]);
    await assert.rejects(processTelegramUpdatesInOrder([{update_id:-1}],()=>{},0,()=>{}),
      /INVALID_TELEGRAM_UPDATE/);
  });
  it('source no longer discards updates on process startup',()=>{
    const code=fs.readFileSync(path.join(__dirname,'..','src','index.js'),'utf8');
    assert.ok(!code.includes('getUpdates(-1)'));
    assert.ok(code.includes('await processTelegramUpdatesInOrder('));
    assert.ok(!code.includes('bot.handleUpdate(u);'));
  });
});
