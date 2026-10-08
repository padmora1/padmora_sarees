// Public helper for the address forms: "does this pincode exist, and is it in the state the shopper picked?"
// Answers come from the pincode directory held in memory; only a pincode newer than the directory goes out to India Post (cached).
const express = require('express');
const { checkPincode, pincodeMessage, normalizeState } = require('../utils/indiaGeo');
const { isBlocked, recordFailure, clientIp } = require('../utils/attemptLimiter');

const router = express.Router();

router.get('/pincode/:pin', async (req, res) => {
  try {
    // a generous limit (people mistype), mostly to stop someone using this to hammer India Post through us
    const key = 'geo:' + clientIp(req);
    if (isBlocked(key, 400)) return res.status(429).json({ message: 'Too many checks. Please wait a few minutes.' });
    recordFailure(key);
    const state = req.query.state ? normalizeState(req.query.state) : null;
    const r = await checkPincode(req.params.pin, state);
    res.json({ ok: r.ok, reason: r.reason || null, state: r.state || r.actual || null, unverified: !!r.unverified, message: pincodeMessage(r, state || String(req.query.state || '')) });
  } catch (err) {
    console.error('GET /geo/pincode failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
