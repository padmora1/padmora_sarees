// Thin wrapper around the official Razorpay SDK. Centralized here so the
// client is constructed once, and so both routes/payments.js and any future
// caller (refunds from the returns flow, say) share the same instance.
const crypto = require('crypto');
const Razorpay = require('razorpay');

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// Genuinely optional at boot — a fresh checkout of this repo shouldn't crash
// just because payments aren't configured yet, same philosophy as the
// email/SMS providers in notify.js. Routes that need it check isConfigured()
// and fail with a clear message instead of throwing on `undefined.orders`.
const razorpay = (KEY_ID && KEY_SECRET) ? new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET }) : null;

function isConfigured() {
  return !!razorpay;
}

// amountRupees must already be the final, server-computed total — never a
// client-supplied number. Razorpay's API takes the smallest currency unit
// (paise), hence the *100.
async function createOrder(amountRupees, receipt) {
  return razorpay.orders.create({
    amount: Math.round(amountRupees * 100),
    currency: 'INR',
    receipt,
    payment_capture: 1
  });
}

// Verifies the HMAC-SHA256 signature Razorpay's checkout widget hands back
// on success. This is the ONLY step that actually proves money moved — the
// widget reporting "success" client-side is not trustworthy on its own,
// since that response passes through the customer's browser.
function verifySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  return expected === razorpay_signature;
}

module.exports = { razorpay, isConfigured, createOrder, verifySignature, KEY_ID };
