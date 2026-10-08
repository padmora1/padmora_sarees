// Checks for the things a delivery address (and an account) must get right: a real Indian state, a city that is really in that state,
// a pincode that exists AND belongs to that state, a mobile number a courier can call, and an e-mail address that is well formed.
//
// The data comes from data/india-geo.json and data/india-pins.json, built by tools/build-india-geo.js from India Post's own records.
// Pincodes newer than that directory are confirmed with India Post's live lookup (a short timeout; if it is unreachable the pincode is
// accepted when its first three digits belong to the chosen state, so a shopper is never turned away because a website is down).
const fs = require('fs');
const path = require('path');
const geo = require('../data/india-geo.json');

const STATES = geo.states;
const cityKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cityIndex = {};   // state -> Map(key -> canonical city)
STATES.forEach(s => { cityIndex[s] = new Map(geo.cities[s].map(c => [cityKey(c), c])); });

function normalizeState(raw) {
  const k = cityKey(raw);
  return STATES.find(s => cityKey(s) === k) || null;
}
function canonicalCity(state, raw) {
  const m = cityIndex[state];
  return (m && m.get(cityKey(raw))) || null;
}
const asArray = v => (Array.isArray(v) ? v : [v]);

// ---- e-mail: a practical version of the standard (RFC 5321/5322 "dot-atom"): no spaces, one @, no leading / trailing / doubled dots
// in the name, a real domain with at least one dot and a letters-only ending of 2+ characters, and the usual length limits.
const EMAIL_RE = /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})$/;
function isValidEmail(raw) {
  const e = String(raw == null ? '' : raw).trim();
  if (e.length < 6 || e.length > 254) return false;
  const m = EMAIL_RE.exec(e);
  return !!m && m[1].length <= 64;
}

// ---- mobile: an Indian mobile is 10 digits starting 6-9 (a +91, 91 or 0 in front is tolerated and dropped). Returns "+91XXXXXXXXXX" or null.
function normalizeIndianMobile(raw) {
  let d = String(raw == null ? '' : raw).replace(/[\s().-]/g, '');
  if (d.startsWith('+')) { if (!d.startsWith('+91')) return null; d = d.slice(3); }
  d = d.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? '+91' + d : null;
}

// ---- pincode
let pins = null;
function loadPins() {
  if (!pins) pins = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'india-pins.json'), 'utf8'));
  return pins;
}
const apiCache = new Map();   // pincode -> { at, value }
const API_TTL = 7 * 24 * 3600 * 1000, MAX_CACHE = 3000;

function stateFromIndiaPost(name) {
  const k = cityKey(String(name || '').replace(/&/g, ' and ').replace(/\bNCT of\b/i, ''));
  if (/^(damananddiu|dadraandnagarhaveli|dadraandnagarhavelianddamananddiu)$/.test(k)) return 'Dadra and Nagar Haveli and Daman and Diu';
  if (k === 'andamanandnicobar' || k === 'andamanandnicobarislands') return 'Andaman and Nicobar Islands';
  if (k === 'pondicherry') return 'Puducherry';
  return STATES.find(s => cityKey(s) === k) || null;
}

async function askIndiaPost(pin) {
  const cached = apiCache.get(pin);
  if (cached && Date.now() - cached.at < API_TTL) return cached.value;
  try {
    const res = await fetch('https://api.postalpincode.in/pincode/' + pin, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { unreachable: true };
    const body = await res.json();
    const first = Array.isArray(body) ? body[0] : null;
    let value;
    if (first && first.Status === 'Success' && Array.isArray(first.PostOffice) && first.PostOffice.length) {
      value = { found: true, states: [...new Set(first.PostOffice.map(o => stateFromIndiaPost(o.State)).filter(Boolean))] };
    } else if (first && /no records/i.test(String(first.Message || ''))) {
      value = { found: false };
    } else return { unreachable: true };
    if (apiCache.size >= MAX_CACHE) apiCache.delete(apiCache.keys().next().value);
    apiCache.set(pin, { at: Date.now(), value });
    return value;
  } catch (e) { return { unreachable: true }; }
}

// -> { ok: true, state?, source } | { ok: false, reason: 'format' | 'state' | 'unknown', actual? }
async function checkPincode(pinRaw, stateRaw) {
  const pin = String(pinRaw == null ? '' : pinRaw).trim();
  if (!/^[1-9]\d{5}$/.test(pin)) return { ok: false, reason: 'format' };
  const state = stateRaw ? normalizeState(stateRaw) : null;
  const idx = state ? STATES.indexOf(state) : -1;

  const hit = loadPins()[pin];
  if (hit !== undefined) {
    const list = asArray(hit);
    if (state && !list.includes(idx)) return { ok: false, reason: 'state', actual: STATES[list[0]] };
    return { ok: true, state: STATES[list.includes(idx) ? idx : list[0]], source: 'directory' };
  }
  // not in the directory: a newer pincode, or one that was made up
  const prefix = geo.p3[pin.slice(0, 3)];
  if (prefix !== undefined && state && !asArray(prefix).includes(idx)) return { ok: false, reason: 'state', actual: STATES[asArray(prefix)[0]] };
  const post = await askIndiaPost(pin);
  if (post.found) {
    if (state && post.states.length && !post.states.includes(state)) return { ok: false, reason: 'state', actual: post.states[0] };
    return { ok: true, state: post.states[0] || state || null, source: 'indiapost' };
  }
  if (post.found === false) return { ok: false, reason: 'unknown' };
  // India Post could not be reached: trust the first three digits (they must at least belong to the chosen state)
  if (prefix !== undefined && (!state || asArray(prefix).includes(idx))) return { ok: true, state, source: 'prefix', unverified: true };
  return { ok: false, reason: 'unknown' };
}

function pincodeMessage(result, state) {
  if (result.ok) return null;
  if (result.reason === 'format') return 'Enter a valid 6-digit pincode.';
  if (result.reason === 'state') return `This pincode belongs to ${result.actual}, not ${state}. Check the pincode or the state.`;
  return 'This pincode does not exist. Please check it.';
}

// A full delivery address. Returns { error, field } for the first problem, or { address } with every value cleaned up
// (the state and city in their official spelling, the mobile as +91XXXXXXXXXX).
async function validateAddress(a) {
  const x = a || {};
  const name = String(x.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) return { error: 'Enter your full name.', field: 'name' };
  const line1 = String(x.line1 || '').trim().replace(/\s+/g, ' ');
  if (line1.length < 5) return { error: 'Enter your full address: house number, street and area.', field: 'line1' };
  if (line1.length > 200) return { error: 'Please keep the address under 200 characters.', field: 'line1' };
  const state = normalizeState(x.state);
  if (!state) return { error: 'Choose your state.', field: 'state' };
  const city = canonicalCity(state, x.city);
  if (!city) return { error: `Choose your city from the list for ${state}.`, field: 'city' };
  const pincode = String(x.pincode == null ? '' : x.pincode).trim();
  if (!/^[1-9]\d{5}$/.test(pincode)) return { error: 'Enter a valid 6-digit pincode.', field: 'pincode' };
  const phone = normalizeIndianMobile(x.phone);
  if (!phone) return { error: 'Enter a valid 10-digit mobile number (it starts with 6, 7, 8 or 9).', field: 'phone' };
  const pin = await checkPincode(pincode, state);
  if (!pin.ok) return { error: pincodeMessage(pin, state), field: 'pincode' };
  return { address: { name, line1, city, state, pincode, phone } };
}

module.exports = { STATES, normalizeState, canonicalCity, isValidEmail, normalizeIndianMobile, checkPincode, pincodeMessage, validateAddress };
