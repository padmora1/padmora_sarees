const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase, must } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/notify');
const { createOtp, verifyOtp } = require('../utils/otp');

const router = express.Router();

// tokenVersion is embedded so a password change/reset can invalidate every
// token signed before it — see middleware/auth.js's requireAuth.
function signToken(userId, tokenVersion) {
  return jwt.sign({ userId, tv: tokenVersion || 0 }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '7d' });
}

// Same shape used to validate a guest's checkout email (routes/payments.js) —
// just "has an @ and a dot", not a full RFC check, kept consistent everywhere
// an email is taken from a customer.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are all required.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const exists = must(await supabase.from('users').select('id, is_guest').ilike('email', email).maybeSingle(), 'register:lookup');
    if (exists) {
      // A guest checkout (routes/orders.js's findOrCreateGuestUser) already
      // created this row with an unusable random password — this person
      // never "already has an account" in any sense they'd recognize. Route
      // them to the claim flow instead of a dead-end 409: verify they own
      // the inbox, then attach the password they just typed to this same
      // row, so their existing guest orders (already stored under this
      // user_id) show up immediately, with nothing else to migrate.
      if (exists.is_guest) {
        const code = await createOtp(email, 'claim_account');
        if (code) {
          sendEmail({
            to: email, subject: 'Verify it\'s you — Padmora Sarees',
            html: `<p>We found previous orders placed with this email. Enter this code to finish setting up your account:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p><p>This code expires in 10 minutes.</p>`,
            text: `Your Padmora verification code is ${code}. It expires in 10 minutes.`
          });
        }
        return res.status(200).json({
          requiresVerification: true,
          message: "We found previous orders under this email — enter the code we just sent to finish setting up your account."
        });
      }
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = must(await supabase.from('users').insert({
      id, name, email, password: hashed, phone: '', address_line1: '', address_city: '', address_state: '', address_pincode: '',
      created_at: new Date().toISOString()
    }).select().single(), 'register:insert');

    const token = signToken(user.id, user.token_version);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('POST /auth/register failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// Second step of the guest-claim flow above — same body the register form
// already collected (name/email/password), plus the emailed code.
router.post('/register/verify', async (req, res) => {
  try {
    const { name, email, password, code } = req.body || {};
    if (!name || !email || !password || !code) {
      return res.status(400).json({ message: 'Name, email, password and code are all required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const ok = await verifyOtp(email, 'claim_account', code);
    if (!ok) {
      return res.status(400).json({ message: 'That code is invalid or has expired. Request a new one by submitting the form again.' });
    }

    const existing = must(await supabase.from('users').select('*').ilike('email', email).maybeSingle(), 'registerVerify:lookup');
    if (!existing || !existing.is_guest) {
      return res.status(404).json({ message: 'This account could not be found. Please start over.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const nextTokenVersion = (existing.token_version || 0) + 1;
    const user = must(await supabase.from('users').update({
      name, password: hashed, is_guest: false, token_version: nextTokenVersion
    }).eq('id', existing.id).select().single(), 'registerVerify:update');

    const token = signToken(user.id, user.token_version);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('POST /auth/register/verify failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    // Same message and status whether the email doesn't exist or the password
    // is wrong — telling the two apart would let someone probe which emails
    // have an account here just by trying to log in.
    const badCredentials = () => res.status(401).json({ message: 'Incorrect email or password.' });

    const user = must(await supabase.from('users').select('*').ilike('email', email || '').maybeSingle(), 'login:lookup');
    if (!user) {
      return badCredentials();
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return badCredentials();
    }
    if (user.status === 'blocked') {
      return res.status(403).json({ message: 'This account has been blocked. Contact support for help.' });
    }

    const token = signToken(user.id, user.token_version);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('POST /auth/login failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// Always the same response regardless of whether the email exists, belongs
// to a guest-only row, or is a real account — telling those apart would let
// someone probe which emails have a real account here, same reasoning as
// login's shared "Incorrect email or password" message above.
router.post('/forgot-password', async (req, res) => {
  const genericOk = () => res.json({ message: "If an account exists for this email, we've sent a reset code." });
  try {
    const { email } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }

    const user = must(await supabase.from('users').select('id, is_guest').ilike('email', email).maybeSingle(), 'forgotPassword:lookup');
    // Only a real (non-guest) account can be reset this way — a guest's
    // email should go through Register → claim instead, which itself never
    // reveals which of these two cases it was.
    if (user && !user.is_guest) {
      const code = await createOtp(email, 'password_reset');
      if (code) {
        sendEmail({
          to: email, subject: 'Reset your Padmora password',
          html: `<p>Use this code to reset your password:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p><p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
          text: `Your Padmora password reset code is ${code}. It expires in 10 minutes.`
        });
      }
    }
    return genericOk();
  } catch (err) {
    console.error('POST /auth/forgot-password failed:', err);
    return genericOk();
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) {
      return res.status(400).json({ message: 'Email, code and new password are all required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const ok = await verifyOtp(email, 'password_reset', code);
    if (!ok) {
      return res.status(400).json({ message: 'That code is invalid or has expired.' });
    }

    const user = must(await supabase.from('users').select('id, is_guest, token_version').ilike('email', email).maybeSingle(), 'resetPassword:lookup');
    if (!user || user.is_guest) {
      return res.status(404).json({ message: 'This account could not be found.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    must(await supabase.from('users').update({ password: hashed, token_version: (user.token_version || 0) + 1 }).eq('id', user.id), 'resetPassword:update');

    // Deliberately no auto-login here — a fresh login is the point, both for
    // the user (confirms the new password works) and for security (any
    // other session everywhere else is already invalidated by the
    // token_version bump above).
    res.json({ message: 'Password updated. Please log in with your new password.' });
  } catch (err) {
    console.error('POST /auth/reset-password failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

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
    const { name, phone, address } = req.body;
    const user = must(await supabase.from('users').select('*').eq('id', req.userId).maybeSingle(), 'updateMe:lookup');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const updated = must(await supabase.from('users').update({
      name: name || user.name,
      phone: phone !== undefined ? phone : user.phone,
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

router.put('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are both required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    }

    const user = must(await supabase.from('users').select('*').eq('id', req.userId).maybeSingle(), 'changePassword:lookup');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ message: 'Current password is incorrect.' });

    const hashed = await bcrypt.hash(newPassword, 10);
    const nextTokenVersion = (user.token_version || 0) + 1;
    const updated = must(await supabase.from('users').update({ password: hashed, token_version: nextTokenVersion }).eq('id', req.userId).select().single(), 'changePassword:update');

    // A fresh token for this request only — everywhere else this account is
    // logged in now fails its next request (token_version bumped above),
    // but the tab that just submitted this form should stay usable.
    const token = signToken(updated.id, updated.token_version);
    res.json({ token, user: publicUser(updated) });
  } catch (err) {
    console.error('PUT /auth/change-password failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
