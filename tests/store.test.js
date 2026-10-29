const { describe, it } = require('node:test');
const assert = require('node:assert');
const store = require('../src/store');

describe('store', () => {
  it('creates and consumes invite', () => {
    const token = store.createInvite(111, 1000);
    assert.ok(token);
    const inv = store.consumeInvite(token);
    assert.equal(inv.requesterId, 111);
    assert.equal(inv.amount, 1000);
    assert.equal(store.consumeInvite(token), null);
  });

  it('creates request', () => {
    const req = store.createRequest(111, 222, 1000);
    assert.ok(req.id.startsWith('KPR-'));
    assert.equal(req.amount, 1000);
    assert.equal(store.getRequest(req.id).payerId, 222);
  });

  it('adds and gets cards by string userId', () => {
    store.addCard(333, { last4: '4242', tokenId: 'tok1' });
    const cards = store.getCards('333');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].last4, '4242');
  });

  it('rejects legacy plaintext PIN enrollment and never supplies a default PIN', () => {
    assert.throws(() => store.setPin(444, '5678'), /LEGACY_PIN_ENROLLMENT_DISABLED/);
    assert.equal(store.getPin(444), null);
    assert.equal(store.getPin('unknown'), null);
  });
});
