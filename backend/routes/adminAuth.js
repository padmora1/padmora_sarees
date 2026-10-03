const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase, must } = require('../utils/db');
const { signAdminToken, requireAdminAuth } = require('../middleware/adminAuth');
const { isBlocked, recordFailure, clearFailures, clientIp } = require('../utils/attemptLimiter');

const router = express.Router();

function publicAdmin(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: !!row.active, createdAt: row.created_at };
}

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });

    // Admin accounts guard the whole store: failed guesses are throttled hard (per address + email, and per
    // address), and a wrong email and a wrong password are indistinguishable to the caller.
    const ip = clientIp(req);
    const pairKey = 'admin-login:' + ip + '|' + String(email).trim().toLowerCase();
    const ipKey = 'admin-login:ip:' + ip;
    if (isBlocked(pairKey, 6) || isBlocked(ipKey, 30)) {
      return res.status(429).json({ message: 'Too many login attempts. Please wait 15 minutes and try again.' });
    }
    const bad = () => { recordFailure(pairKey); recordFailure(ipKey); return res.status(401).json({ message: 'Incorrect email or password.' }); };

    const admin = must(await supabase.from('admin_users').select('*').ilike('email', email).maybeSingle(), 'adminLogin:lookup');
    if (!admin) return bad();
    const match = await bcrypt.compare(password, admin.password);
    if (!match) return bad();
    // Only said once the password is right, so it can't be used to discover which emails are admins.
    if (!admin.active) return res.status(403).json({ message: 'This admin account has been deactivated.' });
    clearFailures(pairKey);

    const token = signAdminToken(admin.id);
    res.json({ token, admin: publicAdmin(admin) });
  } catch (err) {
    console.error('POST /admin-auth/login failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/me', requireAdminAuth, async (req, res) => {
  try {
    const admin = must(await supabase.from('admin_users').select('*').eq('id', req.adminId).maybeSingle(), 'adminMe:lookup');
    res.json({ admin: publicAdmin(admin) });
  } catch (err) {
    console.error('GET /admin-auth/me failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
