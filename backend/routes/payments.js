// Razorpay checkout: the only path that can create a real (paid) order.
// "order" locks in a price (discount + shipping included) and opens a Razorpay Order for it; "verify" - and Razorpay's own webhook
// (routes/paymentWebhook.js) - hand the payment to utils/checkout.js finalizeCheckout(), which checks the payment with Razorpay, claims
// the checkout atomically and places the order exactly once at the price that was paid (refunding automatically if the saree sold
// out in the meantime). A store order never exists before a payment is confirmed.
const express = require('express');
const { supabase, must } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { resolveCoupon, computeOrderTotals } = require('../utils/pricing');
const { sendOrderConfirmation } = require('../utils/notify');
const razorpay = require('../utils/razorpay');
const { OrderError, resolvePricedLineItems } = require('./orders');
const { finalizeCheckout } = require('../utils/checkout');
const { validateAddress, isValidEmail } = require('../utils/indiaGeo');

const router = express.Router();

function requirePaymentsConfigured(req, res, next) {
  if (!razorpay.isConfigured()) {
    return res.status(503).json({ message: 'Online payments aren\'t configured yet. Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET and restart the server.' });
  }
  next();
}
router.use(requirePaymentsConfigured);

// Says WHY a payment could not be started in the server log (a rejected key, Razorpay down...), where the store owner can see it.
function logGatewayError(err) {
  const rz = err && err.error;
  if (rz && (err.statusCode === 401 || /authentication failed/i.test(rz.description || ''))) {
    console.error(`[razorpay] payment NOT started: Razorpay rejected the keys on this server (key ${razorpay.KEY_ID}): ${rz.description}. Set a matching RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET pair and restart.`);
  } else if (rz) {
    console.error(`[razorpay] payment NOT started: ${err.statusCode || ''} ${rz.code || ''} ${rz.description || ''}`.trim());
  } else {
    console.error('[payments] payment NOT started:', err);
  }
}

async function insertPendingCheckout({ id, userId, isGuest, email, lineItems, subtotal, couponCode, address, amount, direct, discount, shippingFee }) {
  must(await supabase.from('pending_checkouts').insert({
    id, user_id: userId || null, is_guest: !!isGuest, email: email || null,
    // a "Buy Now" checkout is stored as { direct: true, items } so that paying for it leaves the customer's bag alone
    line_items: JSON.stringify(direct ? { direct: true, items: lineItems } : lineItems),
    subtotal, coupon_code: couponCode || null, address: JSON.stringify(address), gift_note: null,
    amount, discount: discount == null ? null : discount, shipping_fee: shippingFee == null ? null : shippingFee,   // the price the customer is shown and pays: the order uses exactly these
    status: 'created', created_at: new Date().toISOString()
  }), 'insertPendingCheckout');
}

// ---- Authenticated: price the logged-in cart (or, for Buy Now, just the posted item) and open a Razorpay order ----
router.post('/razorpay/order', requireAuth, async (req, res) => {
  const { couponCode, items } = req.body || {};
  // a complete, real address: state, a city that is in it, a pincode that exists there, a mobile number (cleaned up before it is stored)
  const checked = await validateAddress((req.body || {}).address);
  if (checked.error) return res.status(400).json({ message: checked.error, field: checked.field });
  const address = checked.address;

  try {
    // Buy Now sends the one saree being bought; the bag is neither read nor changed. Without `items` this is the
    // normal bag checkout, exactly as before.
    const direct = Array.isArray(items) && items.length > 0;
    let sourceItems;
    if (direct) {
      sourceItems = items.slice(0, 20)
        .filter(i => i && Number(i.productId) > 0 && Number(i.qty) > 0)
        .map(i => ({ product_id: Number(i.productId), variant_id: i.variantId ? Number(i.variantId) : null, qty: Math.min(99, Math.max(1, Math.floor(Number(i.qty) || 1))), color: i.color }));
      if (!sourceItems.length) return res.status(400).json({ message: 'Nothing to buy — choose a saree first.' });
    } else {
      sourceItems = must(await supabase.from('cart_items').select('*').eq('user_id', req.userId), 'razorpayOrder:cart');
      if (!sourceItems.length) return res.status(400).json({ message: 'Your bag is empty.' });
    }

    const { lineItems, subtotal } = await resolvePricedLineItems(sourceItems);
    const { code: resolvedCoupon, discount } = await resolveCoupon(couponCode, subtotal, req.userId);
    const { total, shippingFee } = await computeOrderTotals(subtotal, discount);

    const rzpOrder = await razorpay.createOrder(total, 'chk_' + Date.now().toString(36));
    await insertPendingCheckout({ id: rzpOrder.id, userId: req.userId, isGuest: false, lineItems, subtotal, couponCode: resolvedCoupon, address, amount: total, direct, discount, shippingFee });

    res.json({ razorpayOrderId: rzpOrder.id, amount: total, currency: 'INR', keyId: razorpay.KEY_ID });
  } catch (err) {
    if (err instanceof OrderError) return res.status(err.status).json({ message: err.message });
    logGatewayError(err);
    res.status(500).json({ message: 'Could not start payment. Please try again.' });
  }
});

// ---- Guest: price posted items and open a Razorpay order ----
router.post('/razorpay/guest-order', async (req, res) => {
  const { couponCode, items, email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ message: 'Enter a valid email address so we can send your order confirmation.', field: 'email' });
  }
  const checked = await validateAddress((req.body || {}).address);
  if (checked.error) return res.status(400).json({ message: checked.error, field: checked.field });
  const address = checked.address;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ message: 'Your bag is empty.' });
  }

  const normalizedItems = items
    .filter(i => i && i.productId && Number(i.qty) > 0)
    .map(i => ({ product_id: Number(i.productId), variant_id: i.variantId ? Number(i.variantId) : null, qty: Math.max(1, Number(i.qty) || 1), color: i.color }));

  try {
    const { lineItems, subtotal } = await resolvePricedLineItems(normalizedItems);
    const { code: resolvedCoupon, discount } = await resolveCoupon(couponCode, subtotal, null);
    const { total, shippingFee } = await computeOrderTotals(subtotal, discount);

    const rzpOrder = await razorpay.createOrder(total, 'chk_' + Date.now().toString(36));
    await insertPendingCheckout({ id: rzpOrder.id, isGuest: true, email, lineItems, subtotal, couponCode: resolvedCoupon, address, amount: total, discount, shippingFee });

    res.json({ razorpayOrderId: rzpOrder.id, amount: total, currency: 'INR', keyId: razorpay.KEY_ID });
  } catch (err) {
    if (err instanceof OrderError) return res.status(err.status).json({ message: err.message });
    logGatewayError(err);
    res.status(500).json({ message: 'Could not start payment. Please try again.' });
  }
});

// ---- Verify: places the store order (the same finalizeCheckout() the Razorpay webhook uses, so one payment can only ever make one order) ----
// Deliberately not auth-gated - the real gate is the HMAC signature, which only Razorpay itself can produce for a genuine payment, plus
// finalizeCheckout() asking Razorpay for the payment and checking its amount. The pending_checkouts row (written server-side at "order"
// time, never from this request) supplies who the order is for and what was actually priced.
router.post('/razorpay/verify', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ message: 'Missing payment confirmation details.' });
  }
  if (!razorpay.verifySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature })) {
    return res.status(400).json({ message: 'Payment could not be verified. If money was deducted, it will be auto-refunded by Razorpay within a few days — contact us if you do not see it.' });
  }

  try {
    const out = await finalizeCheckout({ razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id });
    switch (out.status) {
      case 'placed':
        res.status(201).json({ order: out.order });
        sendOrderConfirmation(out.order, out.customer);
        return;
      case 'already':   // a double click, a retry, or Razorpay's webhook got there first: the customer simply sees their order
        return res.status(200).json({ order: out.order });
      case 'processing':
        return res.status(202).json({ message: 'Your payment was received and your order is being placed. You will get a confirmation e-mail in a minute; if not, contact us with payment ID ' + razorpay_payment_id + '.' });
      case 'unknown':
        return res.status(404).json({ message: 'We could not find this checkout session.' });
      case 'rejected':
        return res.status(400).json({ message: 'We could not confirm this payment with Razorpay. If money was deducted it will be refunded automatically; otherwise contact us with payment ID ' + razorpay_payment_id + '.' });
      case 'refunded':
        return res.status(409).json({ message: out.message });
      default:
        return res.status(500).json({ message: out.message || `Payment received, but something went wrong placing your order. Contact us with payment ID ${razorpay_payment_id} and we'll sort it out right away.` });
    }
  } catch (err) {
    // payment confirmed, order not yet placed because of a hiccup on our side: the claim was released, so Razorpay's webhook (or the
    // customer pressing the button again) finishes it. Never silent.
    console.error(`[razorpay] Payment ${razorpay_payment_id} (order ${razorpay_order_id}) verified but order placement failed:`, err);
    res.status(500).json({ message: `Payment received, but something went wrong placing your order. It will be completed automatically in a few minutes; if you do not get a confirmation e-mail, contact us with payment ID ${razorpay_payment_id}.` });
  }
});

module.exports = router;
