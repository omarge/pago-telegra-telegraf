const crypto = require('crypto');

const invites = new Map();
const requests = new Map();
const conv = new Map();
const cards = new Map();
const pins = new Map(); // userId -> pin
const pinEntry = new Map(); // rid -> current digits

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

function addCard(userId, card) {
  const key = String(userId);
  const list = cards.get(key) || [];
  list.push(card);
  cards.set(key, list);
  return list;
}

function getCards(userId) {
  return cards.get(String(userId)) || [];
}

function setPin(userId, pin) {
  pins.set(String(userId), pin);
}

function getPin(userId) {
  return pins.get(String(userId)) || '1234';
}

function setPinEntry(rid, digits) {
  pinEntry.set(rid, digits);
}

function getPinEntry(rid) {
  return pinEntry.get(rid) || '';
}

module.exports = {
  conv,
  createInvite,
  consumeInvite,
  createRequest,
  getRequest,
  setState,
  addCard,
  getCards,
  setPin,
  getPin,
  setPinEntry,
  getPinEntry,
};
