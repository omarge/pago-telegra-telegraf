'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const bot = require('../src/bot');
const { Telegram } = require('telegraf');

function update(data, fromId, index) {
  return {
    update_id: 120000 + index,
    callback_query: {
      id: 'callback-' + index,
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      message: {
        message_id: index,
        date: 1761680000,
        chat: { id: fromId, type: 'private' },
        text: 'test',
      },
      chat_instance: 'test',
      data,
    },
  };
}

describe('F02 Telegram callback economic-authority NO_GO', () => {
  it('does not fabricate PAID, PIN approvals, statements or declines', async () => {
    const requesterId = 5500998;
    const payerId = 5500999;
    const request = store.createRequest(requesterId, payerId, 12345);
    const originalApi = Telegram.prototype.callApi;
    const apiCalls = [];
    Telegram.prototype.callApi = async (method, payload) => {
      apiCalls.push({ method, payload });
      return true;
    };
    try {
      let i = 0;
      for (const data of [
        'pay:card:4242:' + request.id,
        'nip:1:' + request.id,
        'nip:2:' + request.id,
        'nip:3:' + request.id,
        'nip:4:' + request.id,
        'confirm:yes:' + request.id,
        'menu:reject:' + request.id,
        'menu:done:' + request.id,
        'menu:stmt:' + request.id,
      ]) {
        await bot.handleUpdate(update(data, payerId, ++i),
          { id: 123456, username: 'testbot', is_bot: true, first_name: 'Bot' });
      }
      assert.equal(store.getRequest(request.id).state, 'PENDING');
      assert.equal(store.getTransactions(payerId).length, 0);
      assert.equal(store.getTransactions(requesterId).length, 0);
      const text = apiCalls.filter(c => c.method === 'editMessageText')
        .map(c => String(c.payload.text)).join(' | ');
      assert.ok(text.includes('BusinessOS'));
      assert.ok(!text.includes('Pago completado'));
      assert.ok(apiCalls.every(c => c.method !== 'sendMessage'));
    } finally {
      Telegram.prototype.callApi = originalApi;
    }
  });

  it('denies callback of a different Telegram actor', async () => {
    const req = store.createRequest(6600777, 6600888, 1000);
    const oldApi = Telegram.prototype.callApi;
    const calls = [];
    Telegram.prototype.callApi = async (method, payload) => { calls.push({method, payload}); return true; };
    try {
      await bot.handleUpdate(update('menu:main:' + req.id, 6600999, 998),
        { id: 123456, username: 'testbot', is_bot: true, first_name: 'Bot' });
      assert.equal(req.state, 'PENDING');
      assert.ok(calls.some(c => c.method === 'editMessageText' &&
        String(c.payload.text).includes('no autorizada')));
    } finally {
      Telegram.prototype.callApi = oldApi;
    }
  });
});
