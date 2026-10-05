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
const checkoutRoutes = require('./routes/checkout');
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
const upcomingSareesRoutes = require('./routes/upcomingSarees');
const { runBackup } = require('./utils/backup');
const { checkWishlistAlerts } = require('./utils/wishlistAlerts');
const { checkAbandonedCarts } = require('./utils/abandonedCart');
const { checkLowStock } = require('./utils/lowStockAlerts');
const { checkPrebookNotifications } = require('./utils/prebookAlerts');
const { checkReviewReminders } = require('./utils/reviewReminders');
const { ready: dbReady } = require('./utils/db');

const app = express();
const PORT = process.env.PORT || 5000;

// Admin subdomain isolation — once a real admin subdomain (e.g.
// adminmanagement.padmorasarees.com) exists and points at this same app,
// set ADMIN_HOST to it and the admin panel + its API become reachable only
// from there; the main domain gets a plain 404 for /admin, /admin-login,
// and /api/admin* instead of just an unlinked page (hiding the link alone
// wouldn't stop someone typing the URL or hitting the login API directly).
// Left unset, every route below behaves exactly as it always has — this
// ships with zero behaviour change until deliberately turned on.
const ADMIN_HOST = process.env.ADMIN_HOST || null;
function isAdminHost(req) {
  return !!ADMIN_HOST && req.hostname === ADMIN_HOST;
}
function adminHostOnly(req, res, next) {
  if (!ADMIN_HOST || isAdminHost(req)) return next();
  return sendNotFound(req, res);
}
// A page that does not exist: the branded 404 page for a browser (with a real 404 status, so search engines drop
// the address); plain JSON for the API and plain text for a missing script/image.
function sendNotFound(req, res) {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'Not found.' });
  if (!/text\/html/.test(req.headers.accept || '')) return res.status(404).type('text/plain').send('Not found');
  res.status(404).sendFile(path.join(__dirname, 'frontend', '404.html'), err => { if (err && !res.headersSent) res.status(404).type('text/plain').send('Not found'); });
}

// Browser-hardening headers on every response. The admin panel (and its API) can never be shown inside another
// site's frame (click-jacking); the storefront may only frame itself. HSTS tells browsers to stay on HTTPS.
app.disable('x-powered-by');
app.use((req, res, next) => {
  const adminArea = isAdminHost(req) || /^\/(admin|admin-login|api\/admin)/.test(req.path);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', adminArea ? 'DENY' : 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', adminArea ? "frame-ancestors 'none'" : "frame-ancestors 'self'");
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Gzip text responses (HTML, JS, CSS, JSON): the pages shrink to roughly a quarter on the wire, which is most of
// the load time on a phone. If the package is ever missing the site still works, just uncompressed.
let compression = null;
try { compression = require('compression'); } catch (e) { console.warn('[server] "compression" is not installed - responses will not be gzipped (run npm install).'); }
if (compression) app.use(compression());

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/products/:productId(\\d{1,9})/reviews', reviewRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/admin', adminHostOnly, adminRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api', taxonomyRoutes);
app.use('/api', contentRoutes);
app.use('/api/admin-auth', adminHostOnly, adminAuthRoutes);
app.use('/api/returns', returnsRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/upcoming-sarees', upcomingSareesRoutes);
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
// 'admin' and 'admin-login' are deliberately not in this list — they're
// registered separately below, gated by adminHostOnly, so the main domain
// never serves them (see the ADMIN_HOST block above).
const CLEAN_PAGES = [
  'shop', 'sale', 'collections', 'product', 'cart', 'checkout', 'account', 'wishlist', 'login', 'register',
  'forgot-password',
  'track-order', 'about', 'our-weaves', 'trousseau', 'faq', 'contact',
  'policies', 'packing-slip',
  'upcoming-sarees'
];
function withQuery(req, cleanPath) {
  const qsIndex = req.url.indexOf('?');
  return qsIndex === -1 ? cleanPath : cleanPath + req.url.slice(qsIndex);
}
// A product page is one HTML file for every saree; the saree's own name, description and photo are filled in by the
// page's script. Search engines and link previews (WhatsApp, Instagram, Facebook) often do not run that script, so the
// server writes the saree's title, description, share photo and canonical address into the page before sending it.
const productMetaCache = new Map();   // id -> { at, meta }
const PRODUCT_META_TTL = 60 * 1000;
const escAttr = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function productMeta(id) {
  const hit = productMetaCache.get(id);
  if (hit && Date.now() - hit.at < PRODUCT_META_TTL) return hit.meta;
  const { getProductById } = require('./utils/db');
  const { richToPlain } = require('./utils/richText');
  const p = await getProductById(id);
  let meta = null;
  if (p && p.status !== 'archived') {
    const variants = (p.variants || []).filter(v => !v.archived);
    const def = variants.find(v => v.is_default) || variants[0];
    const media = def && (def.media || []).filter(m => m.type === 'image');
    const photo = media && media.length ? (media.find(m => m.is_primary) || media[0]).url : '';
    const colours = variants.map(v => v.color_name).filter(Boolean);
    const plain = richToPlain(p.description || (def && def.description) || '').replace(/\s+/g, ' ').trim();
    const fallback = `${p.name}: a handloom ${p.fabric} saree${colours.length ? ' in ' + colours.slice(0, 3).join(', ') : ''}, from Rs. ${def ? def.price : p.price}. Free shipping above Rs. 1,999 and easy returns from Padmora by Yashi.`;
    meta = {
      title: `${p.name} — ${p.fabric} Saree | Padmora Sarees by Yashi`,
      description: (plain || fallback).slice(0, 158),
      image: photo ? photo.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') + '?width=1200&quality=78&resize=contain' : ''
    };
  }
  productMetaCache.set(id, { at: Date.now(), meta });
  return meta;
}
let productHtml = null;
app.get('/product', async (req, res) => {
  const file = path.join(FRONTEND_DIR, 'product.html');
  const id = Number(req.query.id);
  try {
    if (!Number.isInteger(id) || id < 1) return res.sendFile(file);
    const meta = await productMeta(id);
    if (!meta) return sendNotFound(req, res);   // a saree that does not exist (or was removed) is a real 404, not a blank page
    if (!productHtml || productHtml.at < require('fs').statSync(file).mtimeMs) productHtml = { at: Date.now(), html: require('fs').readFileSync(file, 'utf8') };
    const base = process.env.SITE_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    const url = `${base}/product?id=${id}`;
    let html = productHtml.html
      .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(meta.title)}</title>`)
      .replace(/(<meta name="description" id="metaDescription" content=")[^"]*(")/, `$1${escAttr(meta.description)}$2`)
      .replace(/(<meta property="og:title" id="ogTitle" content=")[^"]*(")/, `$1${escAttr(meta.title)}$2`)
      .replace(/(<meta property="og:description" id="ogDescription" content=")[^"]*(")/, `$1${escAttr(meta.description)}$2`)
      .replace(/(<meta property="og:image" id="ogImage" content=")[^"]*(")/, `$1${escAttr(meta.image)}$2`);
    html = html.replace('</head>', `<link rel="canonical" href="${escAttr(url)}">\n<meta property="og:url" content="${escAttr(url)}">\n<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">\n</head>`);
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  } catch (err) {
    console.error('GET /product meta failed:', err.message);
    res.sendFile(file);
  }
});

CLEAN_PAGES.forEach(name => {
  app.get(`/${name}`, (req, res) => res.sendFile(path.join(FRONTEND_DIR, `${name}.html`)));
  app.get(`/${name}.html`, (req, res) => res.redirect(301, withQuery(req, `/${name}`)));
});
app.get('/index.html', (req, res) => res.redirect(301, withQuery(req, '/')));
// The shipping, terms and privacy pages were merged into one Policies page (a panel per policy, picked by the
// #hash). Old links, bookmarks and search results keep working.
[['shipping-returns', 'shipping'], ['terms', 'terms'], ['privacy-policy', 'privacy']].forEach(([from, panel]) => {
  app.get([`/${from}`, `/${from}.html`], (req, res) => res.redirect(301, `/policies#${panel}`));
});
// A collection page is the shop listing scoped to that collection's tagged
// products (shop.html reads ?slug=), so it shares the same grid, filters,
// sorting and pagination instead of duplicating them.
app.get('/collection', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'shop.html')));
app.get('/collection.html', (req, res) => res.redirect(301, withQuery(req, '/collection')));

// Admin pages — same clean-URL pattern as above, but only reachable from
// the admin subdomain once ADMIN_HOST is configured. adminHostOnly also
// covers the raw ".html" filename here, so express.static below never gets
// a chance to serve admin.html/admin-login.html directly on the main domain.
['admin', 'admin-login'].forEach(name => {
  app.get(`/${name}`, adminHostOnly, (req, res) => res.sendFile(path.join(FRONTEND_DIR, `${name}.html`)));
  app.get(`/${name}.html`, adminHostOnly, (req, res) => res.redirect(301, withQuery(req, `/${name}`)));
});
// The admin subdomain's own root shows the admin panel directly instead of
// the customer homepage. admin.html's own requireAdminLogin() check already
// redirects to /admin-login on its own if there's no valid session, so
// "logged in vs not" needs no handling here.
app.get('/', (req, res, next) => {
  if (!isAdminHost(req)) return next();
  res.sendFile(path.join(FRONTEND_DIR, 'admin.html'));
});

// Pages, scripts and styles are always revalidated (cheap 304 when unchanged, so a deploy shows up straight away);
// pictures and fonts rarely change and are the heavy part, so the browser may keep them for a day.
app.use(express.static(FRONTEND_DIR, {
  setHeaders(res, filePath) {
    if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
    else res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Admin-uploaded variant images/video, served back out at /uploads/<file>
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Anything that is not an API call, a page or a file is a page that does not exist.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  sendNotFound(req, res);
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
    // "Please review your saree" e-mails a few days after delivery (see utils/reviewReminders.js)
    setTimeout(() => checkReviewReminders().catch(err => console.error('Review reminder check failed:', err.message)), 60 * 1000);
    setInterval(() => { checkReviewReminders().catch(err => console.error('Review reminder check failed:', err.message)); }, 30 * 60 * 1000);
  });
}).catch(err => {
  console.error('Failed to initialize Supabase database:', err);
  process.exit(1);
});
