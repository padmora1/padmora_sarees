// Order inquiry through the private e-mail link - for guests (and anyone who prefers the button in their e-mail).
// No login: the link carries a signed token for ONE order (utils/inquiryToken.js). Everything else - who may ask, when,
// how many times, what is required - is the same code the logged-in route uses (utils/inquiry.js).
const express = require('express');
const { supabase, must } = require('../utils/db');
const { uploadReturnPhotos } = require('../middleware/upload');
const { saveUpload } = require('../utils/storage');
const { readInquiryToken } = require('../utils/inquiryToken');
const { getInquiryState, createInquiry, explain } = require('../utils/inquiry');
const { isBlocked, recordFailure, clientIp } = require('../utils/attemptLimiter');
const { shapeOrder } = require('./orders');

const router = express.Router();

// Resolves :token to its order. A bad or unknown token is counted against the caller, so links cannot be guessed.
async function withOrder(req, res, next) {
  const ip = 'inquiry:' + clientIp(req);
  if (isBlocked(ip, 25)) return res.status(429).json({ message: 'Too many attempts. Please wait a few minutes and try again.' });
  const orderId = readInquiryToken(req.params.token);
  const order = orderId ? must(await supabase.from('orders').select('*').eq('id', orderId).maybeSingle(), 'inquiry:order') : null;
  if (!order) { recordFailure(ip); return res.status(404).json({ message: 'This link is not valid. Please use the link in your latest e-mail from Padmora.' }); }
  req.order = order;
  next();
}

function uploadPhotos(req, res, next) {
  uploadReturnPhotos.array('photos', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
    next();
  });
}

router.get('/:token', withOrder, async (req, res) => {
  try {
    const order = await shapeOrder(req.order);
    const state = await getInquiryState(req.order);
    res.json({ order, inquiry: { ...state, message: state.eligible ? null : explain(state) } });
  } catch (err) {
    console.error('GET /inquiry/:token failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/:token/photos', withOrder, uploadPhotos, async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ message: 'No photos uploaded.' });
  try {
    const save = Promise.all(req.files.map(f => saveUpload(f, 'return-')));
    const urls = await Promise.race([
      save,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('storage timeout'), { timedOut: true })), 40000))
    ]);
    res.status(201).json({ urls });
  } catch (err) {
    console.error('POST /inquiry/:token/photos failed:', err);
    if (err.timedOut) return res.status(504).json({ message: 'Saving the photo took too long. Please try again.' });
    res.status(502).json({ message: 'The photos could not be saved. Please try again in a moment.' });
  }
});

router.post('/:token', withOrder, async (req, res) => {
  try {
    const out = await createInquiry({ order: req.order, userId: req.order.user_id, body: req.body });
    if (out.error) return res.status(out.error.status).json({ message: out.error.message });
    const state = await getInquiryState(req.order);
    res.status(201).json({ ok: true, inquiry: { ...state, message: explain(state) }, requestId: out.request.id, attempt: out.request.attempt });
  } catch (err) {
    console.error('POST /inquiry/:token failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
