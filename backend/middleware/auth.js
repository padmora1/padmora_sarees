const jwt = require('jsonwebtoken');
const { supabase, must } = require('../utils/db');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Please log in to continue.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    // An admin token (payload.adminId, no userId) is a different credential
    // entirely — reject it here rather than silently proceeding as an
    // anonymous/undefined customer.
    if (!payload.userId) return res.status(401).json({ message: 'Please log in to continue.' });
    // Blocking a customer (Admin → Customers) takes effect immediately, even
    // on an already-issued token — not just on their next login attempt.
    const user = must(await supabase.from('users').select('status').eq('id', payload.userId).maybeSingle(), 'requireAuth');
    if (user && user.status === 'blocked') {
      return res.status(403).json({ message: 'This account has been blocked. Contact support for help.' });
    }
    req.userId = payload.userId;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
    }
    console.error('requireAuth error:', err);
    return res.status(500).json({ message: 'Something went wrong on the server.' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = must(await supabase.from('users').select('is_admin').eq('id', req.userId).maybeSingle(), 'requireAdmin');
    if (!user || !user.is_admin) {
      return res.status(403).json({ message: 'Admin access required.' });
    }
    next();
  } catch (err) {
    console.error('requireAdmin error:', err);
    return res.status(500).json({ message: 'Something went wrong on the server.' });
  }
}

module.exports = { requireAuth, requireAdmin };
