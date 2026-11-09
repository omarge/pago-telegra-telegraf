const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

process.env.OPENPAY_MERCHANT_ID = 'sandbox-merchant';
process.env.OPENPAY_PRIVATE_KEY = 'sandbox-test-secret';
const { chargeSavedCard } = require('../src/formServer');

function fakeRequest(reply, captured) {
  return (options, callback) => {
    captured.options = options;
    const request = new EventEmitter();
    request.end = body => {
      captured.body = JSON.parse(body);
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = reply.status || 200;
        callback(response);
        response.emit('data', JSON.stringify(reply.body || { id: 'ch_123', status: 'completed' }));
        response.emit('end');
      });
    };
    return request;
  };
}

test('saved card uses its Openpay customer/card and the user-requested amount', async () => {
  const original = https.request;
  const captured = {};
  https.request = fakeRequest({ body: { id: 'ch_123', status: 'completed' } }, captured);
  try {
    const result = await chargeSavedCard({
      customerId: 'cus_1', cardId: 'card_1', amountCents: 85025,
      deviceSessionId: 'device_1', orderId: 'KPR-ABC'
    });
    assert.equal(result.id, 'ch_123');
    assert.equal(captured.options.hostname, 'sandbox-api.openpay.mx');
    assert.equal(captured.options.path, '/v1/sandbox-merchant/customers/cus_1/charges');
    assert.equal(captured.body.source_id, 'card_1');
    assert.equal(captured.body.amount, 850.25);
    assert.equal(captured.body.order_id, 'KPR-ABC');
    assert.equal(captured.body.method, 'card');
  } finally {
    https.request = original;
  }
});

test('saved card rejects incomplete references without a network call', async () => {
  await assert.rejects(chargeSavedCard({
    customerId: '', cardId: '', amountCents: 0, deviceSessionId: ''
  }), /Datos incompletos/);
});

test('saved card propagates Openpay rejection rather than confirming a payment', async () => {
  const original = https.request;
  https.request = fakeRequest({ status: 402, body: {
    description: 'Card declined', error_code: 3001
  } }, {});
  try {
    await assert.rejects(chargeSavedCard({
      customerId: 'cus_1', cardId: 'card_1', amountCents: 1500,
      deviceSessionId: 'device_1', orderId: 'KPR-FAIL'
    }), /Openpay HTTP 402: Card declined/);
  } finally {
    https.request = original;
  }
});
