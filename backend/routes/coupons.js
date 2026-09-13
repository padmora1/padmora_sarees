const express = require('express');
const { resolveCoupon } = require('../utils/pricing');

// Public (no auth) — lets a guest's cart preview a discount before they log in.
// Checkout itself always re-validates server-side regardless of what this returns.
const router = express.Router();

router.post('/validate', async (req, res) => {
  try {
    const { code, subtotal } = req.body;
    const { code: validCode, discount, error } = await resolveCoupon(code, Number(subtotal) || 0);
    if (!validCode) return res.status(400).json({ message: error || 'That promo code is not valid.' });
    res.json({ code: validCode, discount });
  } catch (err) {
    console.error('POST /coupons/validate failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
