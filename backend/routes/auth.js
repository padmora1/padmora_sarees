const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase, must } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '7d' });
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

    const exists = must(await supabase.from('users').select('id').ilike('email', email).maybeSingle(), 'register:lookup');
    if (exists) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = must(await supabase.from('users').insert({
      id, name, email, password: hashed, phone: '', address_line1: '', address_city: '', address_state: '', address_pincode: '',
      created_at: new Date().toISOString()
    }).select().single(), 'register:insert');

    const token = signToken(user.id);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('POST /auth/register failed:', err);
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

    const token = signToken(user.id);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('POST /auth/login failed:', err);
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

module.exports = router;
