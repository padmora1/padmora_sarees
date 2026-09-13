const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase, must } = require('../utils/db');
const { signAdminToken, requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

function publicAdmin(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: !!row.active, createdAt: row.created_at };
}

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });

    const admin = must(await supabase.from('admin_users').select('*').ilike('email', email).maybeSingle(), 'adminLogin:lookup');
    if (!admin) return res.status(401).json({ message: 'No admin account found with that email.' });
    if (!admin.active) return res.status(403).json({ message: 'This admin account has been deactivated.' });

    const match = await bcrypt.compare(password, admin.password);
    if (!match) return res.status(401).json({ message: 'Incorrect password.' });

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
