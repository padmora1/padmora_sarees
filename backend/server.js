const path = require('path');
// Explicit path, not dotenv's default (which resolves .env relative to
// process.cwd() — wherever the process happened to be launched from, not
// necessarily this file's directory). Without this, .env silently fails to
// load whenever the server is started from outside backend/, and every
// process.env.* read just falls through to its fallback/undefined with no
// error — exactly the kind of gap that stays invisible until a required
// value (no fallback) actually needs to be present, like Razorpay's keys.
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const wishlistRoutes = require('./routes/wishlist');
const orderRoutes = require('./routes/orders');
const reviewRoutes = require('./routes/reviews');
const contactRoutes = require('./routes/contact');
const adminRoutes = require('./routes/admin');
const addressRoutes = require('./routes/addresses');
const couponRoutes = require('./routes/coupons');
const taxonomyRoutes = require('./routes/taxonomy');
const contentRoutes = require('./routes/content');
const adminAuthRoutes = require('./routes/adminAuth');
const returnsRoutes = require('./routes/returns');
const paymentRoutes = require('./routes/payments');
const sitemapRoutes = require('./routes/sitemap');
const { runBackup } = require('./utils/backup');
const { checkWishlistAlerts } = require('./utils/wishlistAlerts');
const { checkAbandonedCarts } = require('./utils/abandonedCart');
const { checkLowStock } = require('./utils/lowStockAlerts');
const { checkPrebookNotifications } = require('./utils/prebookAlerts');
const { ready: dbReady } = require('./utils/db');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/products/:productId/reviews', reviewRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api', taxonomyRoutes);
app.use('/api', contentRoutes);
app.use('/api/admin-auth', adminAuthRoutes);
app.use('/api/returns', returnsRoutes);
app.use('/api/payments', paymentRoutes);
// Not under /api — a sitemap/robots.txt lives at the site root by convention,
// and search engines only look there. Mounted ahead of the static/catch-all
// handlers below so these real routes win over any same-named static file.
app.use(sitemapRoutes);

// Serve the frontend from inside the deployed backend directory. Hostinger's
// Node.js app is rooted at backend/, so keeping the frontend here ensures all
// static HTML/CSS/JS/assets are included in the deployment.
const FRONTEND_DIR = path.join(__dirname, 'frontend');

// Clean, extensionless URLs — /shop, /product, /account, etc. — so a visitor
// (or a search engine) only ever sees "padmorasarees.com/shop", never
// "/shop.html". Registered ahead of express.static below so these routes
// resolve the real page directly, and any lingering link/bookmark to the old
// ".html" form 301s to its clean equivalent rather than serving duplicate
// content at two URLs.
const CLEAN_PAGES = [
  'shop', 'product', 'cart', 'checkout', 'account', 'wishlist', 'login', 'register',
  'track-order', 'about', 'our-weaves', 'trousseau', 'faq', 'contact',
  'shipping-returns', 'terms', 'privacy-policy', 'admin', 'admin-login', 'packing-slip'
];
function withQuery(req, cleanPath) {
  const qsIndex = req.url.indexOf('?');
  return qsIndex === -1 ? cleanPath : cleanPath + req.url.slice(qsIndex);
}
CLEAN_PAGES.forEach(name => {
  app.get(`/${name}`, (req, res) => res.sendFile(path.join(FRONTEND_DIR, `${name}.html`)));
  app.get(`/${name}.html`, (req, res) => res.redirect(301, withQuery(req, `/${name}`));
});
app.get('/index.html', (req, res) => res.redirect(301, withQuery(req, '/')));

app.use(express.static(FRONTEND_DIR));

// Admin-uploaded variant images/video, served back out at /uploads/<file>
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'), err => {
    if (err) next();
  });
});

app.use((req, res) => res.status(404).json({ message: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on the server.' });
});

// Supabase seeding/backfill (db.js's `ready` promise) must finish before the
// app accepts traffic — every route below assumes the admin account, default
// settings and variant backfill already exist.
dbReady.then(() => {
  app.listen(PORT, () => {
    console.log(`Padmora by Yashi server running at http://localhost:${PORT}`);

    // Background jobs — real setInterval timers on this long-running Node
    // process, not decorative. Each one is also individually safe to call
    // repeatedly (idempotent per-event, see each module's own comments), so a
    // slow tick overlapping the next one can't double-send anything.
    const HOUR = 60 * 60 * 1000;
    setTimeout(() => runBackup().catch(err => console.error('Initial backup failed:', err.message)), 5000);
    setInterval(() => runBackup().catch(err => console.error('Scheduled backup failed:', err.message)), 6 * HOUR);

    setInterval(() => { checkWishlistAlerts().catch(err => console.error('Wishlist alert check failed:', err.message)); }, 15 * 60 * 1000);
    setInterval(() => { checkAbandonedCarts().catch(err => console.error('Abandoned cart check failed:', err.message)); }, 30 * 60 * 1000);
    setInterval(() => { checkLowStock().catch(err => console.error('Low stock check failed:', err.message)); }, HOUR);
    setInterval(() => { checkPrebookNotifications().catch(err => console.error('Pre-book check failed:', err.message)); }, 15 * 60 * 1000);
  });
}).catch(err => {
  console.error('Failed to initialize Supabase database:', err);
  process.exit(1);
});
