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

// Refunds a captured payment back to the customer's original payment method.
// Razorpay itself rejects a refund that would exceed what was captured (minus
// earlier refunds), which is the final safety net against over-refunding.
// Called over REST rather than the SDK because the SDK can't send Razorpay's
// X-Refund-Idempotency header. With a stable key per order/return, a retry
// after a timeout returns the ORIGINAL refund instead of creating a second one.
// (Key must be 10+ chars of letters/digits/-/_; same key + different body is
// rejected by Razorpay, which is the safe outcome.)
async function refundPayment(paymentId, amountRupees, notes, idempotencyKey) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')
  };
  if (idempotencyKey) headers['X-Refund-Idempotency'] = idempotencyKey;
  const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ amount: Math.round(amountRupees * 100), speed: 'normal', notes: notes || {} })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error?.description || `Razorpay responded ${res.status}`);
    err.error = body.error;
    err.statusCode = res.status;
    throw err;
  }
  return body;
}

// Razorpay SDK errors carry the useful text in err.error.description.
function refundErrorMessage(err) {
  return (err && err.error && err.error.description) || (err && err.message) || 'Razorpay refund failed.';
}

module.exports = { razorpay, isConfigured, createOrder, verifySignature, refundPayment, refundErrorMessage, KEY_ID };
