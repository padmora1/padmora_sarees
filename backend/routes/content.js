const express = require('express');
const { getSetting, getFaqItems } = require('../utils/db');

const router = express.Router();

router.get('/content/hero', async (req, res) => {
  try {
    res.json({ hero: await getSetting('hero_banner', {}) });
  } catch (err) {
    console.error('GET /content/hero failed:', err);
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
    res.json({ store: await getSetting('store_info', {}) });
  } catch (err) {
    console.error('GET /settings/store failed:', err);
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

router.get('/settings/tax', async (req, res) => {
  try {
    res.json({ tax: await getSetting('tax_settings', {}) });
  } catch (err) {
    console.error('GET /settings/tax failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
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
