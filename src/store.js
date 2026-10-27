const crypto = require('crypto');

const invites = new Map();
const requests = new Map();
const conv = new Map();

function newId() {
  return 'KPR-' + crypto.randomBytes(16).toString('hex').toUpperCase();
}

function createInvite(requesterId, amount) {
  const token = crypto.randomBytes(6).toString('base64url');
  invites.set(token, { requesterId, amount, created: Date.now() });
  return token;
}

function consumeInvite(token) {
  const inv = invites.get(token);
  if (!inv) return null;
  invites.delete(token);
  return inv;
}

function createRequest(requesterId, payerId, amount) {
  const id = newId();
  requests.set(id, {
    id,
    requesterId,
    payerId,
    amount,
    state: 'PENDING',
    created: Date.now(),
  });
  return requests.get(id);
}

function getRequest(id) {
  return requests.get(id);
}

function setState(id, state) {
  const r = requests.get(id);
  if (r) r.state = state;
  return r;
}

module.exports = {
  conv,
  createInvite,
  consumeInvite,
  createRequest,
  getRequest,
  setState,
};
