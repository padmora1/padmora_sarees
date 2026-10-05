const express = require('express');
const { getSetting, getFaqItems, getProducts, getProductById } = require('../utils/db');
const { toProductApiShape } = require('../utils/shape');
const { DEFAULT_FOOTER } = require('../utils/footerConfig');
const { DEFAULT_ANNOUNCEMENT, DEFAULT_WEAVE_SECTION } = require('../utils/homeSections');

const router = express.Router();

router.get('/content/hero', async (req, res) => {
  try {
    res.json({ hero: await getSetting('hero_banner', {}) });
  } catch (err) {
    console.error('GET /content/hero failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// The three sarees in the homepage "Shop all sarees" band. Admin-picked when
// set (Storefront -> Shop-all band); otherwise the same popularity order the
// shop page defaults to, so the band is never empty on a fresh store.
router.get('/content/shop-all', async (req, res) => {
  try {
    const cfg = await getSetting('shop_all_showcase', {});
    const ids = (Array.isArray(cfg.productIds) ? cfg.productIds : []).slice(0, 3);
    let products = [];
    if (ids.length) {
      // A stored id that no longer resolves must never take the whole homepage band down.
      const rows = await Promise.all(ids.map(id => getProductById(id).catch(() => null)));
      // A pick that was since archived or deleted just drops out.
      products = rows.filter(r => r && r.status !== 'archived').map(toProductApiShape);
    }
    if (!products.length) {
      products = (await getProducts()).filter(p => p.status !== 'archived').map(toProductApiShape)
        .filter(p => p.badge !== 'sale')
        .sort((a, b) => ((b.badge === 'bestseller') - (a.badge === 'bestseller')) || ((b.rating * b.reviews) - (a.rating * a.reviews)))
        .slice(0, 3);
    }
    res.json({ products });
  } catch (err) {
    console.error('GET /content/shop-all failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/content/announcement', async (req, res) => {
  try {
    res.json({ announcement: await getSetting('announcement_bar', DEFAULT_ANNOUNCEMENT) });
  } catch (err) {
    console.error('GET /content/announcement failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/content/weave-section', async (req, res) => {
  try {
    res.json({ section: await getSetting('weave_section', DEFAULT_WEAVE_SECTION) });
  } catch (err) {
    console.error('GET /content/weave-section failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/content/promo-band', async (req, res) => {
  try {
    const band = await getSetting('promo_band', {});
    // Respect the admin-set date window even though nothing else in the app
    // currently enforces scheduled content — an inactive/expired band should
    // simply not render rather than the homepage needing its own date logic.
    const now = new Date();
    const withinWindow = (!band.startDate || now >= new Date(band.startDate)) && (!band.endDate || now <= new Date(band.endDate));
    res.json({ promoBand: { ...band, active: !!band.active && withinWindow } });
  } catch (err) {
    console.error('GET /content/promo-band failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// Public, read-only Phase 7 settings — the storefront footer/contact info,
// checkout's shipping & tax lines, and cart summaries all read from here so
// there's exactly one place an admin edits this, not four.
router.get('/settings/store', async (req, res) => {
  try {
    // shipperAddress is for the packing slip only (admin endpoint); it is not public storefront info.
    const { shipperAddress, ...publicStore } = await getSetting('store_info', {});
    res.json({ store: publicStore });
  } catch (err) {
    console.error('GET /settings/store failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/settings/footer', async (req, res) => {
  try {
    res.json({ footer: await getSetting('footer_config', DEFAULT_FOOTER) });
  } catch (err) {
    console.error('GET /settings/footer failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/settings/shipping', async (req, res) => {
  try {
    res.json({ shipping: await getSetting('shipping_settings', {}) });
  } catch (err) {
    console.error('GET /settings/shipping failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// GST is no longer added or shown anywhere - every price already includes it. Kept only so a page loaded before this
// change (still holding the old script) reads "no tax" instead of failing.
router.get('/settings/tax', (req, res) => {
  res.json({ tax: { enabled: false, gstRate: 0, inclusive: true } });
});

router.get('/settings/return-policy', async (req, res) => {
  try {
    res.json({ returnPolicy: await getSetting('return_policy', { enabled: true, windowDays: 7 }) });
  } catch (err) {
    console.error('GET /settings/return-policy failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/faq', async (req, res) => {
  try {
    const items = (await getFaqItems()).map(f => ({ id: f.id, question: f.question, answer: f.answer, category: f.category }));
    res.json({ faq: items });
  } catch (err) {
    console.error('GET /faq failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
