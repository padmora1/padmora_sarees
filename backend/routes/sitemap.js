// A real, dynamically generated sitemap — pulls the live product and fabric
// list on every request rather than a static file that goes stale the
// moment a product is added or archived.
const express = require('express');
const { getProducts, getFabrics, getCollections } = require('../utils/db');
const { normalizeSiteUrl, blockSearchEngines } = require('../utils/siteUrl');
const siteBase = req => normalizeSiteUrl(process.env.SITE_URL) || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

const router = express.Router();

const STATIC_PAGES = [
  { path: '/', priority: '1.0' },
  { path: '/shop', priority: '0.9' },
  { path: '/collections', priority: '0.8' },
  { path: '/sale', priority: '0.7' },
  { path: '/trousseau', priority: '0.5' },
  { path: '/upcoming-sarees', priority: '0.5' },
  { path: '/about', priority: '0.6' },
  { path: '/contact', priority: '0.4' },
  { path: '/faq', priority: '0.4' },
  { path: '/policies', priority: '0.4' }
];

router.get('/sitemap.xml', async (req, res) => {
  try {
    const base = siteBase(req);
    const [products, fabrics, collections] = await Promise.all([getProducts(), getFabrics(), getCollections({ activeOnly: true }).catch(() => [])]);
    const urls = [
      ...STATIC_PAGES.map(p => ({ loc: base + p.path, priority: p.priority })),
      ...products.filter(p => p.status !== 'archived').map(p => ({ loc: `${base}/product?id=${p.id}`, priority: '0.8' })),
      ...fabrics.map(f => ({ loc: `${base}/shop?fabric=${encodeURIComponent(f.name)}`, priority: '0.5' })),
      ...collections.map(c => ({ loc: `${base}/collection?slug=${encodeURIComponent(c.slug)}`, priority: '0.6' }))
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map(u => `  <url><loc>${u.loc.replace(/&/g, '&amp;')}</loc><priority>${u.priority}</priority></url>`).join('\n') +
      `\n</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    console.error('GET /sitemap.xml failed:', err);
    res.status(500).send('');
  }
});

router.get('/robots.txt', (req, res) => {
  // a test copy (BLOCK_SEARCH_ENGINES=true) asks every search engine to stay away from the whole site
  if (blockSearchEngines()) return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  const base = siteBase(req);
  res.type('text/plain').send(
    `User-agent: *\n` +
    `Allow: /\n` +
    `Disallow: /admin\n` +
    `Disallow: /admin-login\n` +
    `Disallow: /account\n` +
    `Disallow: /checkout\n` +
    `Disallow: /cart\n` +
    `Disallow: /wishlist\n` +
    `Disallow: /login\n` +
    `Disallow: /register\n` +
    `Disallow: /forgot-password\n` +
    `Disallow: /track-order\n` +
    `Disallow: /order-inquiry\n` +
    `Disallow: /packing-slip\n\n` +
    `Sitemap: ${base}/sitemap.xml\n`
  );
});

module.exports = router;
