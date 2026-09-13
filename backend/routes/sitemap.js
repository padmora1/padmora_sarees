// A real, dynamically generated sitemap — pulls the live product and fabric
// list on every request rather than a static file that goes stale the
// moment a product is added or archived.
const express = require('express');
const { getProducts, getFabrics } = require('../utils/db');

const router = express.Router();

const STATIC_PAGES = [
  { path: '/', priority: '1.0' },
  { path: '/shop', priority: '0.9' },
  { path: '/about', priority: '0.6' },
  { path: '/our-weaves', priority: '0.6' },
  { path: '/contact', priority: '0.4' },
  { path: '/faq', priority: '0.4' },
  { path: '/shipping-returns', priority: '0.4' }
];

router.get('/sitemap.xml', async (req, res) => {
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const [products, fabrics] = await Promise.all([getProducts(), getFabrics()]);
    const urls = [
      ...STATIC_PAGES.map(p => ({ loc: base + p.path, priority: p.priority })),
      ...products.filter(p => p.status !== 'archived').map(p => ({ loc: `${base}/product?id=${p.id}`, priority: '0.8' })),
      ...fabrics.map(f => ({ loc: `${base}/shop?fabric=${encodeURIComponent(f.name)}`, priority: '0.5' }))
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
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(
    `User-agent: *\n` +
    `Allow: /\n` +
    `Disallow: /admin\n` +
    `Disallow: /admin-login\n` +
    `Disallow: /account\n` +
    `Disallow: /checkout\n` +
    `Disallow: /cart\n\n` +
    `Sitemap: ${base}/sitemap.xml\n`
  );
});

module.exports = router;
