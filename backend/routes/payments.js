// Razorpay checkout: the only path that can create a real (paid) order now
// that COD/manual "Cash on Delivery" style bypass is gone. Two steps —
// "order" locks in a price and opens a Razorpay Order for it; "verify"
// checks the signature Razorpay hands back and only then calls into
// orders.js's placeOrderTx. A store order never exists before payment is
// verified; there is no code path that creates a "Confirmed" order for
// nothing.
const express = require('express');
const { supabase, must } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { resolveCoupon, computeOrderTotals } = require('../utils/pricing');
const { sendOrderConfirmation } = require('../utils/notify');
const razorpay = require('../utils/razorpay');
const { OrderError, resolvePricedLineItems, placeOrderTx, findOrCreateGuestUser } = require('./orders');

const router = express.Router();

function requirePaymentsConfigured(req, res, next) {
  if (!razorpay.isConfigured()) {
    return res.status(503).json({ message: 'Online payments aren\'t configured yet. Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET and restart the server.' });
  }
  next();
}
router.use(requirePaymentsConfigured);

function validateAddress(address, { requirePhone } = {}) {
  if (!address || !address.line1 || !address.city || !address.pincode) return 'A complete shipping address is required.';
  if (requirePhone && !address.phone) return 'A complete shipping address is required.';
  return null;
}

async function insertPendingCheckout({ id, userId, isGuest, email, lineItems, subtotal, couponCode, address, giftNote, amount }) {
  must(await supabase.from('pending_checkouts').insert({
    id, user_id: userId || null, is_guest: !!isGuest, email: email || null, line_items: JSON.stringify(lineItems),
    subtotal, coupon_code: couponCode || null, address: JSON.stringify(address), gift_note: giftNote || null,
    amount, status: 'created', created_at: new Date().toISOString()
  }), 'insertPendingCheckout');
}

// ---- Authenticated: price the logged-in cart and open a Razorpay order ----
router.post('/razorpay/order', requireAuth, async (req, res) => {
  const { address, giftNote, couponCode } = req.body || {};
  const addrError = validateAddress(address);
  if (addrError) return res.status(400).json({ message: addrError });

  try {
    const cartItems = must(await supabase.from('cart_items').select('*').eq('user_id', req.userId), 'razorpayOrder:cart');
    if (!cartItems.length) return res.status(400).json({ message: 'Your bag is empty.' });

    const { lineItems, subtotal } = await resolvePricedLineItems(cartItems);
    const { code: resolvedCoupon, discount } = await resolveCoupon(couponCode, subtotal, req.userId);
    const { total } = await computeOrderTotals(subtotal, discount);

    const rzpOrder = await razorpay.createOrder(total, 'chk_' + Date.now().toString(36));
    await insertPendingCheckout({ id: rzpOrder.id, userId: req.userId, isGuest: false, lineItems, subtotal, couponCode: resolvedCoupon, address, giftNote, amount: total });

    res.json({ razorpayOrderId: rzpOrder.id, amount: total, currency: 'INR', keyId: razorpay.KEY_ID });
  } catch (err) {
    if (err instanceof OrderError) return res.status(err.status).json({ message: err.message });
    console.error(err);
    res.status(500).json({ message: 'Could not start payment. Please try again.' });
  }
});

// ---- Guest: price posted items and open a Razorpay order ----
router.post('/razorpay/guest-order', async (req, res) => {
  const { address, giftNote, couponCode, items, email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'A valid email is required so we can send your order confirmation.' });
  }
  const addrError = validateAddress(address, { requirePhone: true });
  if (addrError) return res.status(400).json({ message: addrError });
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ message: 'Your bag is empty.' });
  }

  const normalizedItems = items
    .filter(i => i && i.productId && Number(i.qty) > 0)
    .map(i => ({ product_id: Number(i.productId), variant_id: i.variantId ? Number(i.variantId) : null, qty: Math.max(1, Number(i.qty) || 1), color: i.color }));

  try {
    const { lineItems, subtotal } = await resolvePricedLineItems(normalizedItems);
    const { code: resolvedCoupon, discount } = await resolveCoupon(couponCode, subtotal, null);
    const { total } = await computeOrderTotals(subtotal, discount);

    const rzpOrder = await razorpay.createOrder(total, 'chk_' + Date.now().toString(36));
    await insertPendingCheckout({ id: rzpOrder.id, isGuest: true, email, lineItems, subtotal, couponCode: resolvedCoupon, address, giftNote, amount: total });

    res.json({ razorpayOrderId: rzpOrder.id, amount: total, currency: 'INR', keyId: razorpay.KEY_ID });
  } catch (err) {
    if (err instanceof OrderError) return res.status(err.status).json({ message: err.message });
    console.error(err);
    res.status(500).json({ message: 'Could not start payment. Please try again.' });
  }
});

// ---- Verify: the only step that actually places the store order ----
// Deliberately not auth-gated — the real gate is the HMAC signature, which
// only Razorpay itself can produce for a genuine successful payment. The
// pending_checkouts row (written server-side at "order" time, never from
// this request) supplies who the order is for and what was actually priced.
router.post('/razorpay/verify', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ message: 'Missing payment confirmation details.' });
  }
  if (!razorpay.verifySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature })) {
    return res.status(400).json({ message: 'Payment could not be verified. If money was deducted, it will be auto-refunded by Razorpay within a few days — contact us if you don\'t see it.' });
  }

  try {
    const pending = must(await supabase.from('pending_checkouts').select('*').eq('id', razorpay_order_id).maybeSingle(), 'verify:pending');
    if (!pending) return res.status(404).json({ message: 'We could not find this checkout session.' });
    if (pending.status !== 'created') {
      // Already consumed — a double-submit or a retried webhook, not a fresh
      // payment. Never place a second order for one payment.
      return res.status(409).json({ message: 'This payment has already been processed.' });
    }

    const lineItems = JSON.parse(pending.line_items);
    const address = JSON.parse(pending.address);

    let userId = pending.user_id;
    let customer;
    let afterInsertWithinTx;

    if (pending.is_guest) {
      const user = await findOrCreateGuestUser({ email: pending.email, name: address.name, phone: address.phone });
      userId = user.id;
      customer = user;
    } else {
      customer = must(await supabase.from('users').select('id, name, email').eq('id', userId).maybeSingle(), 'verify:customer');
      afterInsertWithinTx = async () => {
        must(await supabase.from('cart_items').delete().eq('user_id', userId), 'verify:clearCartItems');
        must(await supabase.from('cart_meta').delete().eq('user_id', userId), 'verify:clearCartMeta');
      };
    }

    const shaped = await placeOrderTx({
      userId, lineItems, subtotal: pending.subtotal, couponCode: pending.coupon_code,
      address, payment: 'Razorpay', giftNote: pending.gift_note, afterInsertWithinTx
    });
    must(await supabase.from('orders').update({ razorpay_order_id, razorpay_payment_id }).eq('id', shaped.id), 'verify:stampPaymentIds');
    must(await supabase.from('pending_checkouts').update({ status: 'verified' }).eq('id', razorpay_order_id), 'verify:markConsumed');

    res.status(201).json({ order: shaped });
    sendOrderConfirmation(shaped, customer);
  } catch (err) {
    // Payment is genuinely captured at this point (signature already
    // verified above) but the order couldn't be placed — almost always a
    // stock conflict in the gap between "order" and "verify". This must
    // never be silent: log loudly for manual admin follow-up (refund or
    // manual fulfillment), and tell the customer clearly rather than
    // showing a generic error after they've actually paid.
    console.error(`[razorpay] Payment ${razorpay_payment_id} (order ${razorpay_order_id}) verified but order placement failed:`, err);
    if (err instanceof OrderError) {
      return res.status(err.status).json({ message: `Payment received, but ${err.message.toLowerCase()} Contact us with payment ID ${razorpay_payment_id} and we'll sort it out right away.` });
    }
    res.status(500).json({ message: `Payment received, but something went wrong placing your order. Contact us with payment ID ${razorpay_payment_id} and we'll sort it out right away.` });
  }
});

module.exports = router;
