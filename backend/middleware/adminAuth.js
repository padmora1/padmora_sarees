// Admin authentication is fully separate from customer authentication —
// a different token payload shape ({ adminId }, never { userId }), a
// different source table (admin_users, never users), and its own login
// route (/api/admin-auth/login). A customer token can never pass
// requireAdminAuth, and an admin token can never pass the customer
// requireAuth, because each only recognizes its own payload field.
const jwt = require('jsonwebtoken');
const { supabase, must } = require('../utils/db');

function signAdminToken(adminId) {
  return jwt.sign({ adminId }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '12h' });
}

async function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Please log in to the admin dashboard.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    if (!payload.adminId) return res.status(401).json({ message: 'Invalid admin session.' });

    const admin = must(await supabase.from('admin_users').select('*').eq('id', payload.adminId).maybeSingle(), 'requireAdminAuth');
    if (!admin) return res.status(401).json({ message: 'Admin account not found.' });
    if (!admin.active) return res.status(403).json({ message: 'This admin account has been deactivated.' });

    req.adminId = admin.id;
    req.adminName = admin.name;
    req.adminRole = admin.role;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Your admin session has expired. Please log in again.' });
    }
    console.error('requireAdminAuth error:', err);
    return res.status(500).json({ message: 'Something went wrong on the server.' });
  }
}

// Which scopes each role may act on. Super Admin bypasses this map entirely.
// Matches the roles from the spec: Catalog Manager (products/variants/
// inventory/collections/fabrics/badges/coupons), Order Manager (orders/
// tracking/cancellations), Customer Support (customers/reviews/messages),
// Content Manager (storefront/FAQ).
const ROLE_SCOPES = {
  'Catalog Manager': ['catalog'],
  'Order Manager': ['orders'],
  'Customer Support': ['support'],
  'Content Manager': ['content']
};

// Maps a request path (relative to the /api/admin mount point) to the scope
// it requires. Anything not listed here — dashboard stats, analytics,
// activity log — is visible to every admin role, since those are read-only
// and useful regardless of what a role can edit.
const PATH_SCOPES = [
  ['/products', 'catalog'], ['/variants', 'catalog'], ['/media', 'catalog'],
  ['/fabrics', 'catalog'], ['/occasions', 'catalog'], ['/badges', 'catalog'], ['/collections', 'catalog'],
  ['/coupons', 'catalog'],
  ['/inventory', 'orders'], ['/orders', 'orders'], ['/notifications', 'orders'], ['/prebooks', 'orders'], ['/returns', 'orders'],
  ['/customers', 'support'], ['/reviews', 'support'], ['/contact', 'support'],
  ['/content', 'content'], ['/reels', 'content'], ['/faq', 'content'],
  ['/settings', 'superadmin'], ['/admin-users', 'superadmin'], ['/backups', 'superadmin'], ['/jobs', 'superadmin']
];

function scopeForPath(path) {
  const match = PATH_SCOPES.find(([prefix]) => path.startsWith(prefix));
  return match ? match[1] : null;
}

// Server-side enforcement, not just hidden buttons in the UI — a Catalog
// Manager's token genuinely gets a 403 from the Orders API, not just a
// missing nav link.
function requirePermission(req, res, next) {
  const scope = scopeForPath(req.path);
  if (!scope) return next();
  if (req.adminRole === 'Super Admin') return next();
  if (scope === 'superadmin') return res.status(403).json({ message: 'Only a Super Admin can access this.' });

  const allowed = ROLE_SCOPES[req.adminRole] || [];
  if (!allowed.includes(scope)) {
    return res.status(403).json({ message: `Your role (${req.adminRole}) doesn't have access to this section.` });
  }
  next();
}

module.exports = { signAdminToken, requireAdminAuth, requirePermission };
