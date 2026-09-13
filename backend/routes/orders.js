const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { supabase, must, getProducts, getVariantById } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { resolveCoupon, computeOrderTotals } = require('../utils/pricing');
const { computeStatus, buildTimeline, isCancellable } = require('../utils/orderStatus');
const { isWithinReturnWindow } = require('../utils/returns');

const router = express.Router();

// A small typed error so every route can respond with the right status
// without duplicating message-building logic.
class OrderError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function shapeOrder(order) {
  const items = must(await supabase.from('order_items').select('*').eq('order_id', order.id), 'shapeOrder:items');
  const status = await computeStatus(order); // may stamp delivered_at as a side effect — must run before reading it below
  const existingReturn = must(await supabase.from('return_requests').select('id, status').eq('order_id', order.id).maybeSingle(), 'shapeOrder:return');
  const cancellable = await isCancellable(order);
  const timeline = await buildTimeline(order);
  const withinReturnWindow = await isWithinReturnWindow(order);
  return {
    id: order.id,
    items: items.map(li => ({
      id: li.id, productId: li.product_id, variantId: li.variant_id, name: li.name, color: li.color, qty: li.qty, price: li.price
    })),
    subtotal: order.subtotal,
    discount: order.discount,
    shippingFee: order.shipping_fee,
    taxAmount: order.tax_amount,
    total: order.total,
    couponCode: order.coupon_code,
    address: {
      name: order.address_name, line1: order.address_line1, city: order.address_city,
      state: order.address_state, pincode: order.address_pincode, phone: order.address_phone
    },
    giftNote: order.gift_note,
    payment: order.payment,
    status,
    cancellable,
    timeline,
    cancelReason: order.cancel_reason,
    refundStatus: order.refund_status,
    placedAt: order.placed_at,
    deliveredAt: order.delivered_at,
    returnStatus: existingReturn ? existingReturn.status : null,
    returnRequestId: existingReturn ? existingReturn.id : null,
    canRequestReturn: status === 'Delivered' && !existingReturn && withinReturnWindow
  };
}

// Shared by the authenticated cart checkout and guest checkout — resolves
// each requested line against real, current product/variant data. Price,
// name, and color always come from the server; a client can only say
// "this product/variant, this quantity."
async function resolvePricedLineItems(rawItems) {
  const products = await getProducts();
  const lineItems = [];
  for (const item of rawItems) {
    const product = products.find(p => p.id === item.product_id);
    if (!product) continue;
    const variant = item.variant_id ? await getVariantById(item.variant_id) : null;
    const stock = variant ? variant.stock : product.stock;
    const price = variant ? variant.price : product.price;
    const colorLabel = variant ? variant.color_name : item.color;
    if (stock < item.qty) {
      throw new OrderError(409, `Only ${stock} left of "${product.name}"${variant ? ' in ' + variant.color_name : ''} — please update your bag.`);
    }
    lineItems.push({ productId: item.product_id, variantId: item.variant_id || null, name: product.name, color: colorLabel, qty: item.qty, price });
  }
  if (!lineItems.length) throw new OrderError(400, 'Your bag is empty.');
  const subtotal = lineItems.reduce((sum, li) => sum + li.price * li.qty, 0);
  return { lineItems, subtotal };
}

// The one place that actually writes an order — used by both the
// authenticated route and guest checkout. The insert + line items + stock
// decrement (with its stock>=qty safety guard) + coupon-usage recording all
// happen inside the place_order() Postgres function (see the
// product_view_and_order_functions migration), so it's genuinely atomic —
// the Postgres equivalent of better-sqlite3's db.transaction(fn).
async function placeOrderTx({ userId, lineItems, subtotal, couponCode: requestedCoupon, address, payment, giftNote, afterInsertWithinTx }) {
  const { code: couponCode, discount } = await resolveCoupon(requestedCoupon, subtotal, userId);
  const { shippingFee, taxAmount, total } = await computeOrderTotals(subtotal, discount);

  const orderId = 'ZR' + Math.floor(10000 + Math.random() * 89999);

  const rpc = await supabase.rpc('place_order', {
    p_order_id: orderId, p_user_id: userId, p_subtotal: subtotal, p_discount: discount,
    p_shipping_fee: shippingFee, p_tax_amount: taxAmount, p_total: total, p_coupon_code: couponCode,
    p_address_name: address.name || '', p_address_line1: address.line1, p_address_city: address.city,
    p_address_state: address.state || '', p_address_pincode: address.pincode, p_address_phone: address.phone || '',
    p_gift_note: giftNote || null, p_payment: payment || 'UPI', p_line_items: lineItems
  });
  if (rpc.error) {
    // A RAISE EXCEPTION inside place_order() (the stock>=qty guard) surfaces
    // here — same "not enough stock" condition the old SQLite transaction
    // rollback used to signal, just reported by Postgres instead.
    throw new OrderError(409, rpc.error.message || 'Not enough stock to complete this order.');
  }

  if (afterInsertWithinTx) await afterInsertWithinTx();

  const order = must(await supabase.from('orders').select('*').eq('id', orderId).single(), 'placeOrderTx:reread');
  return shapeOrder(order);
}

// ---------------------------------------------------------------------
// Guest checkout — no account required. A real users row is still created
// (or reused, matched by email) behind the scenes so every existing
// order/admin/tracking code path keeps working with zero special-casing;
// `is_guest` just lets admin tell the two apart. Registered ahead of
// requireAuth below so it's reachable without a session.
// ---------------------------------------------------------------------
async function findOrCreateGuestUser({ email, name, phone }) {
  const existing = must(await supabase.from('users').select('*').ilike('email', email).maybeSingle(), 'findOrCreateGuestUser:lookup');
  if (existing) return existing;
  const id = 'u_guest_' + crypto.randomBytes(8).toString('hex');
  const unusablePassword = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
  return must(await supabase.from('users').insert({
    id, name: name || 'Guest', email: email.toLowerCase(), password: unusablePassword, phone: phone || '',
    created_at: new Date().toISOString(), is_guest: true
  }).select().single(), 'findOrCreateGuestUser:insert');
}

// Guest order tracking — no account needed, but requires knowing both the
// order ID and the email or phone used at checkout, the same "prove you
// placed it" pattern most retailers use for guest order lookup.
router.get('/guest/:id', async (req, res) => {
  try {
    const { contact } = req.query;
    if (!contact) return res.status(400).json({ message: 'Enter the email or phone used for this order.' });

    const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle(), 'guestOrder:lookup');
    if (!order) return res.status(404).json({ message: 'Order not found. Check your Order ID and try again.' });

    const user = must(await supabase.from('users').select('*').eq('id', order.user_id).maybeSingle(), 'guestOrder:user');
    const normalized = String(contact).trim().toLowerCase();
    const normalizedDigits = normalized.replace(/\D/g, '');
    const matchesEmail = user && user.email && user.email.toLowerCase() === normalized;
    const matchesPhone = normalizedDigits.length >= 10 && order.address_phone && order.address_phone.replace(/\D/g, '').endsWith(normalizedDigits.slice(-10));
    if (!matchesEmail && !matchesPhone) {
      return res.status(404).json({ message: 'Order not found. Check your Order ID and the email/phone used at checkout.' });
    }
    res.json({ order: await shapeOrder(order) });
  } catch (err) {
    console.error('GET /orders/guest/:id failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const orders = must(await supabase.from('orders').select('*').eq('user_id', req.userId).order('placed_at', { ascending: false }), 'listOrders');
    res.json({ orders: await Promise.all(orders.map(shapeOrder)) });
  } catch (err) {
    console.error('GET /orders failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle(), 'getOrder');
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    res.json({ order: await shapeOrder(order) });
  } catch (err) {
    console.error('GET /orders/:id failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle(), 'cancelOrder:lookup');
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (!(await isCancellable(order))) {
      const status = await computeStatus(order);
      return res.status(400).json({ message: `This order is already ${status.toLowerCase()} and can no longer be cancelled.` });
    }

    const { reason } = req.body || {};
    // Nothing was ever charged on a COD order, so there's no refund to track —
    // anything paid upfront (UPI/card) starts a refund the admin can mark processed.
    const refundStatus = order.payment === 'COD' ? 'Not Applicable' : 'Pending';

    const rpc = await supabase.rpc('cancel_order', {
      p_order_id: order.id, p_reason: reason || 'Customer request', p_refund_status: refundStatus
    });
    if (rpc.error) throw new Error(rpc.error.message);

    const updated = must(await supabase.from('orders').select('*').eq('id', order.id).single(), 'cancelOrder:reread');
    res.json({ order: await shapeOrder(updated) });
  } catch (err) {
    console.error('POST /orders/:id/cancel failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// Real order creation now only happens after a verified Razorpay payment
// (see routes/payments.js) — these are exported so that route can reuse the
// exact same pricing/stock-safety/guest-user logic rather than duplicating
// it, instead of attaching custom routes here that could bypass payment.
module.exports = router;
module.exports.OrderError = OrderError;
module.exports.shapeOrder = shapeOrder;
module.exports.resolvePricedLineItems = resolvePricedLineItems;
module.exports.placeOrderTx = placeOrderTx;
module.exports.findOrCreateGuestUser = findOrCreateGuestUser;
