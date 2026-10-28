const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'store.json');
const KEY = crypto.createHash('sha256').update(process.env.KASHBIT_PIN_PEPPER || 'dev-pepper').digest();

const invites = new Map();
const requests = new Map();
const conv = new Map();
const cards = new Map();
const pins = new Map();
const pinEntry = new Map();

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}

function decrypt(data) {
  try {
    const [ivHex, enc] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
    let dec = decipher.update(enc, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch {
    return null;
  }
}

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const dec = decrypt(raw);
    if (!dec) return;
    const data = JSON.parse(dec);
    if (data.cards) {
      for (const [k, v] of Object.entries(data.cards)) cards.set(k, v);
    }
    if (data.pins) {
      for (const [k, v] of Object.entries(data.pins)) pins.set(k, v);
    }
    console.log('Store loaded:', cards.size, 'users with cards');
  } catch (e) {
    console.error('Store load error:', e.message);
  }
}

function save() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      cards: Object.fromEntries(cards),
      pins: Object.fromEntries(pins),
    };
    const enc = encrypt(JSON.stringify(data));
    fs.writeFileSync(DATA_FILE, enc);
  } catch (e) {
    console.error('Store save error:', e.message);
  }
}

load();

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
  save();
  return list;
}

function getCards(userId) {
  return cards.get(String(userId)) || [];
}

function setPin(userId, pin) {
  pins.set(String(userId), pin);
  save();
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
