const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { supabase, must } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/notify');
const { isBlocked, recordFailure, clearFailures, clientIp } = require('../utils/attemptLimiter');
const { createOtp, verifyOtp } = require('../utils/otp');

const router = express.Router();

// Customers have no password any more: signing up and signing in both use a 6-digit code e-mailed to the address
// they give. (Admins sign in separately, in routes/adminAuth.js, and are not affected.)

// tokenVersion is embedded so a sign-out-everywhere style bump can invalidate older tokens - see middleware/auth.js.
function signToken(userId, tokenVersion) {
  return jwt.sign({ userId, tv: tokenVersion || 0 }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '7d' });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;   // used for logging in (an account that already exists keeps working)
const { isValidEmail } = require('../utils/indiaGeo');   // used for NEW accounts: the full standard-based check

// A mobile number from anywhere. It can arrive as "+44 7911 123456" (with its own + code) or as a country code ("44") plus
// the number. India (+91) keeps its strict rule (10 digits starting 6-9); any other country needs 5-13 digits after the
// code (the international maximum is 15 digits in all). Stored as "+<code><number>" with no spaces. With no code at all the
// number is taken to be Indian, as before.
function normalizePhone(raw, countryCode) {
  const text = String(raw || '').trim();
  let cc = String(countryCode || '').replace(/\D/g, '');
  let national;
  if (text.startsWith('+') || text.startsWith('00')) {
    const all = text.replace(/\D/g, '').replace(/^00/, '');
    if (all.length < 8 || all.length > 15) return null;
    // split the code off: India (91) is the one we know the exact shape of; otherwise use the code given, else 1-3 digits
    if (all.startsWith('91') && all.length === 12) { cc = '91'; national = all.slice(2); }
    else if (cc && all.startsWith(cc)) national = all.slice(cc.length);
    else return all.length >= 8 && all.length <= 15 && !all.startsWith('91') ? '+' + all : null;
  } else {
    if (!cc) cc = '91';
    national = text.replace(/\D/g, '');
    if (national.startsWith(cc) && cc === '91' && national.length === 12) national = national.slice(2);
    if (cc === '91' && national.length === 11 && national.startsWith('0')) national = national.slice(1);
    else if (cc !== '91') national = national.replace(/^0+/, '');
  }
  if (!/^\d{1,3}$/.test(cc)) return null;
  if (cc === '91') return /^[6-9]\d{9}$/.test(national) ? '+91' + national : null;
  return /^\d{5,13}$/.test(national) && (cc + national).length <= 15 ? '+' + cc + national : null;
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    address: {
      line1: row.address_line1,
      city: row.address_city,
      state: row.address_state,
      pincode: row.address_pincode
    },
    isAdmin: !!row.is_admin,
    createdAt: row.created_at
  };
}

const IN_PRODUCTION = process.env.NODE_ENV === 'production';

// Sends the code. Returns null when sent (or, on a developer's machine with no mail set up, quietly "sent"), or an
// error string for the caller to show.
async function emailCode({ to, code, purpose, name }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const what = purpose === 'register' ? 'finish creating your Padmora account' : 'sign in to Padmora';
  const subject = purpose === 'register' ? `${code} is your Padmora sign-up code` : `${code} is your Padmora sign-in code`;
  const html = `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;color:#2b1015;">
    <h2 style="color:#7A1F2B;margin-bottom:4px;">Padmora by Yashi</h2>
    <p>Hi ${first.replace(/[<>&]/g, '')},</p>
    <p>Use this code to ${what}:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#7A1F2B;margin:18px 0;">${code}</p>
    <p style="font-size:13px;color:#6f5a5c;">It works for 10 minutes and only once. If you did not ask for it, you can ignore this e-mail &mdash; nobody can sign in without it.</p>
  </div>`;
  const result = await sendEmail({ to, subject, html, text: `Your Padmora code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this e-mail.` });
  if (result.status === 'sent') return null;
  if (result.status === 'skipped_not_configured' && !IN_PRODUCTION) return null;   // local development without mail
  return 'We could not send the code right now. Please try again in a minute.';
}

// ---------------------------------------------------------------------------------------------------------------
// Sign up: name + e-mail + phone -> a code is e-mailed -> the code creates the account and signs the customer in.
// ---------------------------------------------------------------------------------------------------------------
router.post('/register/start', async (req, res) => {
  try {
    const { name, email, phone, countryCode } = req.body || {};
    const cleanName = String(name || '').trim();
    if (cleanName.length < 2 || cleanName.length > 80) return res.status(400).json({ message: 'Enter your full name.' });
    if (!isValidEmail(email)) return res.status(400).json({ message: 'Enter a valid email address, for example name@example.com.' });
    if (!normalizePhone(phone, countryCode)) return res.status(400).json({ message: String(countryCode || '91').replace(/\D/g, '') === '91' ? 'Enter a valid 10-digit Indian mobile number.' : 'Enter a valid mobile number for the country you chose.' });

    const ip = clientIp(req);
    const ipKey = 'codes:ip:' + ip;
    if (isBlocked(ipKey, 30)) return res.status(429).json({ message: 'Too many requests. Please wait a few minutes and try again.' });
    recordFailure(ipKey);   // counts every code request from this address, so e-mails can not be sprayed from one place

    const cleanEmail = String(email).trim();
    const exists = must(await supabase.from('users').select('id, is_guest, status').ilike('email', cleanEmail).maybeSingle(), 'registerStart:lookup');
    if (exists && !exists.is_guest) {
      return res.status(409).json({ message: 'An account with this email already exists. Log in — we will e-mail you a code.', exists: true });
    }
    const code = await createOtp(cleanEmail, 'register');
    if (!code) return res.status(429).json({ message: 'A code was just sent. Please wait a minute before asking for another.' });
    const problem = await emailCode({ to: cleanEmail, code, purpose: 'register', name: cleanName });
    if (problem) return res.status(502).json({ message: problem });
    res.json({ message: 'We have e-mailed a 6-digit code to ' + cleanEmail + '.' });
  } catch (err) {
    console.error('POST /auth/register/start failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/register/verify', async (req, res) => {
  try {
    const { name, email, phone, code, countryCode } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanPhone = normalizePhone(phone, countryCode);
    if (cleanName.length < 2 || !isValidEmail(email) || !cleanPhone || !String(code || '').trim()) {
      return res.status(400).json({ message: 'Name, email, mobile number and code are all required.' });
    }
    const cleanEmail = String(email).trim();
    const failKey = 'regverify:' + clientIp(req) + '|' + cleanEmail.toLowerCase();
    if (isBlocked(failKey, 8)) return res.status(429).json({ message: 'Too many wrong codes. Please wait a few minutes and start again.' });

    const ok = await verifyOtp(cleanEmail, 'register', String(code).trim());
    if (!ok) { recordFailure(failKey); return res.status(400).json({ message: 'That code is incorrect or has expired. Check it, or ask for a new one.' }); }
    clearFailures(failKey);

    const existing = must(await supabase.from('users').select('*').ilike('email', cleanEmail).maybeSingle(), 'registerVerify:lookup');
    let user;
    if (existing && !existing.is_guest) return res.status(409).json({ message: 'An account with this email already exists. Please log in.' });
    if (existing) {
      // A guest checkout already made this row: the customer just proved they own the inbox, so their earlier orders
      // simply become part of the real account - nothing to move.
      user = must(await supabase.from('users').update({ name: cleanName, phone: cleanPhone, is_guest: false }).eq('id', existing.id).select().single(), 'registerVerify:claim');
    } else {
      const unusablePassword = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 8);   // no password exists to be guessed
      const id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      user = must(await supabase.from('users').insert({
        id, name: cleanName, email: cleanEmail, password: unusablePassword, phone: cleanPhone,
        address_line1: '', address_city: '', address_state: '', address_pincode: '', created_at: new Date().toISOString()
      }).select().single(), 'registerVerify:insert');
    }
    res.status(201).json({ token: signToken(user.id, user.token_version), user: publicUser(user) });
  } catch (err) {
    console.error('POST /auth/register/verify failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Sign in: e-mail -> a code is e-mailed -> the code signs in. The first step always gives the same answer, whether or
// not the address has an account, so nobody can use it to find out who shops here.
// ---------------------------------------------------------------------------------------------------------------
router.post('/login/start', async (req, res) => {
  const sameAnswer = () => res.json({ message: "If this e-mail has a Padmora account, we have sent a 6-digit code to it." });
  try {
    const { email } = req.body || {};
    if (!EMAIL_RE.test(String(email || '').trim())) return res.status(400).json({ message: 'Enter a valid email address.' });
    const ip = clientIp(req);
    const ipKey = 'codes:ip:' + ip;
    if (isBlocked(ipKey, 30)) return res.status(429).json({ message: 'Too many requests. Please wait a few minutes and try again.' });
    recordFailure(ipKey);

    const cleanEmail = String(email).trim();
    const user = must(await supabase.from('users').select('id, name, status').ilike('email', cleanEmail).maybeSingle(), 'loginStart:lookup');
    if (!user || user.status === 'blocked') return sameAnswer();
    const code = await createOtp(cleanEmail, 'login');
    if (!code) return sameAnswer();   // asked again within a minute: the earlier code is still valid
    const problem = await emailCode({ to: cleanEmail, code, purpose: 'login', name: user.name });
    if (problem) return res.status(502).json({ message: problem });
    sameAnswer();
  } catch (err) {
    console.error('POST /auth/login/start failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/login/verify', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!EMAIL_RE.test(String(email || '').trim()) || !String(code || '').trim()) {
      return res.status(400).json({ message: 'Enter your e-mail and the 6-digit code.' });
    }
    const cleanEmail = String(email).trim();
    const ip = clientIp(req);
    const pairKey = 'login:' + ip + '|' + cleanEmail.toLowerCase();
    const ipKey = 'login:ip:' + ip;
    if (isBlocked(pairKey, 8) || isBlocked(ipKey, 40)) {
      return res.status(429).json({ message: 'Too many wrong codes. Please wait a few minutes and ask for a new code.' });
    }
    const bad = () => { recordFailure(pairKey); recordFailure(ipKey); return res.status(401).json({ message: 'That code is incorrect or has expired. Check it, or ask for a new one.' }); };

    const user = must(await supabase.from('users').select('*').ilike('email', cleanEmail).maybeSingle(), 'loginVerify:lookup');
    if (!user) return bad();
    const ok = await verifyOtp(cleanEmail, 'login', String(code).trim());
    if (!ok) return bad();
    if (user.status === 'blocked') return res.status(403).json({ message: 'This account has been blocked. Contact support for help.' });
    clearFailures(pairKey);

    let row = user;
    // Someone who only ever checked out as a guest and now signs in with a code is simply a customer from here on.
    if (user.is_guest) row = must(await supabase.from('users').update({ is_guest: false }).eq('id', user.id).select().single(), 'loginVerify:claimGuest');
    res.json({ token: signToken(row.id, row.token_version), user: publicUser(row) });
  } catch (err) {
    console.error('POST /auth/login/verify failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// The password endpoints are gone. A page that is still open from before this change gets a clear message.
const retired = (req, res) => res.status(410).json({ message: 'Padmora no longer uses passwords. Sign in with the code we e-mail you.' });
router.post('/login', retired);
router.post('/register', retired);
router.post('/forgot-password', retired);
router.post('/reset-password', retired);
router.put('/change-password', retired);

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = must(await supabase.from('users').select('*').eq('id', req.userId).maybeSingle(), 'me:lookup');
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('GET /auth/me failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.put('/me', requireAuth, async (req, res) => {
  try {
    const { name, phone, address, countryCode } = req.body;
    const user = must(await supabase.from('users').select('*').eq('id', req.userId).maybeSingle(), 'updateMe:lookup');
    if (!user) return res.status(404).json({ message: 'User not found.' });
    let newPhone = user.phone;
    if (phone !== undefined) {
      newPhone = String(phone).trim() === '' ? '' : normalizePhone(phone, countryCode);
      if (newPhone === null) return res.status(400).json({ message: 'Enter a valid mobile number (with its country code if it is not an Indian number, e.g. +44 7911 123456).' });
    }

    const updated = must(await supabase.from('users').update({
      name: name || user.name,
      phone: newPhone,
      address_line1: address && address.line1 !== undefined ? address.line1 : user.address_line1,
      address_city: address && address.city !== undefined ? address.city : user.address_city,
      address_state: address && address.state !== undefined ? address.state : user.address_state,
      address_pincode: address && address.pincode !== undefined ? address.pincode : user.address_pincode
    }).eq('id', req.userId).select().single(), 'updateMe:update');

    res.json({ user: publicUser(updated) });
  } catch (err) {
    console.error('PUT /auth/me failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
module.exports.signToken = signToken;
module.exports.normalizePhone = normalizePhone;
