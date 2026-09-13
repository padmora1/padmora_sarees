const express = require('express');
const fs = require('fs');
const path = require('path');
const { supabase, must } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { computeStatus } = require('../utils/orderStatus');
const { uploadReturnPhotos, UPLOAD_DIR } = require('../middleware/upload');
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

// Lets the "Return / Refund" button on a delivered order know whether to
// show up at all, and why not when it doesn't — reused for every delivered
// order in the customer's history, not just at request time.
router.get('/eligibility/:orderId', async (req, res) => {
  try {
    const order = must(await supabase.from('orders').select('*').eq('id', req.params.orderId).eq('user_id', req.userId).maybeSingle(), 'eligibility:order');
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    const status = await computeStatus(order);
    const existing = must(await supabase.from('return_requests').select('id, status').eq('order_id', order.id).maybeSingle(), 'eligibility:existing');
    if (existing) return res.json({ eligible: false, reason: 'already_requested', existingReturnId: existing.id, existingStatus: existing.status });
    if (status !== 'Delivered') return res.json({ eligible: false, reason: 'not_delivered' });
    if (!(await isWithinReturnWindow(order))) return res.json({ eligible: false, reason: 'window_closed', policy: await getReturnPolicy() });
    res.json({ eligible: true, policy: await getReturnPolicy(), reasons: RETURN_REASONS });
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

router.get('/:id', async (req, res) => {
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
router.post('/photos', uploadPhotos, (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ message: 'No photos uploaded.' });
  res.status(201).json({ urls: req.files.map(f => `/uploads/${f.filename}`) });
});

router.post('/', async (req, res) => {
  try {
    const { orderId, items, reason, reasonDetail, refundMethod, refundAccountDetail, photoUrls } = req.body || {};

    const order = must(await supabase.from('orders').select('*').eq('id', orderId).eq('user_id', req.userId).maybeSingle(), 'postReturn:order');
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if ((await computeStatus(order)) !== 'Delivered') {
      return res.status(400).json({ message: 'Only delivered orders are eligible for return.' });
    }
    if (!(await isWithinReturnWindow(order))) {
      const policy = await getReturnPolicy();
      return res.status(400).json({ message: `The return window (${policy.windowDays} days from delivery) has closed for this order.` });
    }
    if (must(await supabase.from('return_requests').select('id').eq('order_id', order.id).maybeSingle(), 'postReturn:existing')) {
      return res.status(400).json({ message: 'A return request has already been submitted for this order.' });
    }
    if (!RETURN_REASONS.some(r => r.key === reason)) {
      return res.status(400).json({ message: 'Choose a valid return reason.' });
    }
    if (reason === 'other' && !(reasonDetail || '').trim()) {
      return res.status(400).json({ message: 'Add a short note so we understand what went wrong.' });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ message: 'Select at least one item to return.' });
    }
    if (!['original', 'bank_transfer', 'store_credit'].includes(refundMethod)) {
      return res.status(400).json({ message: 'Choose how you\'d like to be refunded.' });
    }
    if (refundMethod === 'original' && order.payment === 'COD') {
      return res.status(400).json({ message: 'Cash on Delivery orders can\'t be refunded to an "original payment method" — choose bank transfer or store credit instead.' });
    }
    if (refundMethod === 'bank_transfer' && !(refundAccountDetail || '').trim()) {
      return res.status(400).json({ message: 'Add your UPI ID or bank account + IFSC to receive the transfer.' });
    }

    const orderItems = must(await supabase.from('order_items').select('*').eq('order_id', order.id), 'postReturn:orderItems');
    const orderItemMap = new Map(orderItems.map(i => [i.id, i]));
    const returnedLines = [];
    for (const sel of items) {
      const oi = orderItemMap.get(Number(sel.orderItemId));
      const qty = Number(sel.qty);
      if (!oi) return res.status(400).json({ message: 'That item isn\'t part of this order.' });
      if (!qty || qty < 1 || qty > oi.qty) {
        return res.status(400).json({ message: `Choose a valid quantity for ${oi.name} (up to ${oi.qty}).` });
      }
      returnedLines.push({ orderItemId: oi.id, price: oi.price, qty });
    }

    const allItemsReturned = orderItems.every(oi => {
      const sel = returnedLines.find(l => l.orderItemId === oi.id);
      return sel && sel.qty === oi.qty;
    });
    const reasonCategory = categoryForReason(reason);
    const refundAmount = computeReturnRefund(order, returnedLines, allItemsReturned, reasonCategory);

    // Evidence photos are only worth requiring when the customer is claiming
    // WE messed up (damaged/wrong item/not as described/quality) — a plain
    // "changed my mind" doesn't need proof of anything. Each URL must be one
    // this customer actually got back from POST /photos just now, not an
    // arbitrary string, and must still exist on disk.
    const photos = Array.isArray(photoUrls) ? photoUrls.filter(u => typeof u === 'string' && /^\/uploads\/return-[\w.-]+$/.test(u)) : [];
    if (reasonCategory === 'seller_fault' && !photos.length) {
      return res.status(400).json({ message: 'Add at least one photo showing the issue — it helps us process your claim faster.' });
    }
    if (photos.length > 5) {
      return res.status(400).json({ message: 'Up to 5 photos per request.' });
    }
    const missingPhoto = photos.find(u => !fs.existsSync(path.join(UPLOAD_DIR, path.basename(u))));
    if (missingPhoto) {
      return res.status(400).json({ message: 'One of the uploaded photos could not be found — please re-upload it.' });
    }

    const rpc = await supabase.rpc('create_return_request', {
      p_order_id: order.id, p_user_id: req.userId, p_reason: reason, p_reason_category: reasonCategory,
      p_reason_detail: (reasonDetail || '').trim() || null, p_refund_method: refundMethod,
      p_refund_account_detail: refundMethod === 'bank_transfer' ? refundAccountDetail.trim() : null,
      p_computed_refund_amount: refundAmount,
      p_items: returnedLines.map(l => ({ orderItemId: l.orderItemId, qty: l.qty })),
      p_photo_urls: photos
    });
    if (rpc.error) throw new Error(rpc.error.message);

    const created = must(await supabase.from('return_requests').select('*').eq('id', rpc.data).single(), 'postReturn:reread');
    res.status(201).json({ return: await shapeReturn(created) });
  } catch (err) {
    console.error('POST /returns failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
