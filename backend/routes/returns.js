const express = require('express');
const fs = require('fs');
const path = require('path');
const { supabase, must } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { computeStatus } = require('../utils/orderStatus');
const { uploadReturnPhotos } = require('../middleware/upload');
const { saveUpload, isReturnPhotoUrl } = require('../utils/storage');
const { getInquiryState, createInquiry, explain } = require('../utils/inquiry');
const {
  RETURN_REASONS, categoryForReason, getReturnPolicy, isWithinReturnWindow, computeReturnRefund
} = require('../utils/returns');

const router = express.Router();
router.use(requireAuth);

// Turns a multer failure (bad file type, too many/too large) into a clean
// 400 with the real reason, instead of falling through to the generic 500.
function uploadPhotos(req, res, next) {
  uploadReturnPhotos.array('photos', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
    next();
  });
}

async function shapeReturn(r) {
  const returnItems = must(await supabase.from('return_request_items').select('order_item_id, qty').eq('return_id', r.id), 'shapeReturn:items');
  const orderItemIds = returnItems.map(i => i.order_item_id);
  const orderItems = orderItemIds.length
    ? must(await supabase.from('order_items').select('id, name, color, price').in('id', orderItemIds), 'shapeReturn:orderItems')
    : [];
  const orderItemById = Object.fromEntries(orderItems.map(oi => [oi.id, oi]));
  const photos = must(await supabase.from('return_request_photos').select('id, url').eq('return_id', r.id).order('id'), 'shapeReturn:photos');
  return {
    id: r.id,
    orderId: r.order_id,
    attempt: r.attempt || 1,
    reason: r.reason,
    reasonLabel: (RETURN_REASONS.find(x => x.key === r.reason) || {}).label || r.reason,
    reasonDetail: r.reason_detail,
    status: r.status,
    refundMethod: r.refund_method,
    computedRefundAmount: r.computed_refund_amount,
    finalRefundAmount: r.final_refund_amount,
    adminNote: r.admin_note,
    couponCode: r.coupon_code,
    items: returnItems.map(i => {
      const oi = orderItemById[i.order_item_id] || {};
      return { orderItemId: i.order_item_id, name: oi.name, color: oi.color, price: oi.price, qty: i.qty };
    }),
    photos: photos.map(p => ({ id: p.id, url: p.url })),
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    receivedAt: r.received_at,
    refundedAt: r.refunded_at
  };
}

// Where an order stands for an inquiry: can one be made now, which attempt, or why not (see utils/inquiry.js).
router.get('/eligibility/:orderId', async (req, res) => {
  try {
    const order = must(await supabase.from('orders').select('*').eq('id', req.params.orderId).eq('user_id', req.userId).maybeSingle(), 'eligibility:order');
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    const state = await getInquiryState(order);
    res.json({ ...state, message: state.eligible ? null : explain(state) });
  } catch (err) {
    console.error('GET /returns/eligibility/:orderId failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const rows = must(await supabase.from('return_requests').select('*').eq('user_id', req.userId).order('requested_at', { ascending: false }), 'listReturns');
    res.json({ returns: await Promise.all(rows.map(shapeReturn)) });
  } catch (err) {
    console.error('GET /returns failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/:id(\\d{1,9})', async (req, res) => {
  try {
    const row = must(await supabase.from('return_requests').select('*').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle(), 'getReturn');
    if (!row) return res.status(404).json({ message: 'Return request not found.' });
    res.json({ return: await shapeReturn(row) });
  } catch (err) {
    console.error('GET /returns/:id failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// Uploaded ahead of the request itself — the customer picks photos while
// still filling out the form, gets back URLs, then submits those URLs as
// part of POST / below. Keeps this endpoint reusable if we ever want a
// "manage return photos after submission" flow without redesigning it.
router.post('/photos', uploadPhotos, async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ message: 'No photos uploaded.' });
  try {
    // Never let a stalled storage call keep the customer waiting: give up after 40 seconds with a clear message.
    const save = Promise.all(req.files.map(f => saveUpload(f, 'return-')));
    const urls = await Promise.race([
      save,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('storage timeout'), { timedOut: true })), 40000))
    ]);
    res.status(201).json({ urls });
  } catch (err) {
    console.error('POST /returns/photos failed:', err);
    if (err.timedOut) return res.status(504).json({ message: 'Saving the photo took too long. Please try again.' });
    res.status(502).json({ message: 'The photos could not be saved. Please try again in a moment.' });
  }
});

// Sends an order inquiry (return and refund) for one of the customer's own delivered orders.
router.post('/', async (req, res) => {
  try {
    const order = must(await supabase.from('orders').select('*').eq('id', (req.body || {}).orderId).eq('user_id', req.userId).maybeSingle(), 'postReturn:order');
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    const out = await createInquiry({ order, userId: req.userId, body: req.body });
    if (out.error) return res.status(out.error.status).json({ message: out.error.message });
    res.status(201).json({ return: await shapeReturn(out.request) });
  } catch (err) {
    console.error('POST /returns failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
