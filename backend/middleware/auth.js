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
    const user = must(await supabase.from('users').select('status, token_version').eq('id', payload.userId).maybeSingle(), 'requireAuth');
    if (user && user.status === 'blocked') {
      return res.status(403).json({ message: 'This account has been blocked. Contact support for help.' });
    }
    // A password change/reset bumps token_version — any token signed before
    // that (this one, or one sitting on another device) stops working here,
    // the same "expired" message a naturally-expired token would already
    // show, so the frontend needs no new case to handle it.
    if (user && payload.tv !== user.token_version) {
      return res.status(401).json({ message: 'Your session has expired. Please log in again.' });
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

// Best-effort identity for public routes that personalize when a token is
// present but must still work fine with none — unlike requireAuth, this
// never rejects the request; it just returns null on anything unusable
// (missing header, expired token, admin token, blocked account).
// Now async (was sync) so it can also apply the same token_version check as
// requireAuth — best-effort though: an old/leaked token just stops
// personalizing (falls back to "anonymous") instead of rejecting the
// request, matching this helper's existing contract. Callers must await it.
async function getUserIdIfPresent(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    if (!payload.userId) return null;
    const user = must(await supabase.from('users').select('token_version').eq('id', payload.userId).maybeSingle(), 'getUserIdIfPresent');
    if (!user || payload.tv !== user.token_version) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

module.exports = { requireAuth, requireAdmin, getUserIdIfPresent };
