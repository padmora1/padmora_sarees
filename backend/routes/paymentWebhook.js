// Razorpay -> us: "this payment succeeded". This is what saves an order when the customer pays and then closes the page (or loses
// signal) before the browser has told us - Razorpay calls this address by itself, and retries for up to a day if we do not answer 200.
//
// Set it up once in the Razorpay dashboard: Settings -> Webhooks -> Add new webhook
//   URL    https://<your site>/api/payments/razorpay/webhook
//   Events payment.captured and order.paid
//   Secret any long random text - the SAME text goes into the hosting settings as RAZORPAY_WEBHOOK_SECRET
//
// It needs the exact raw bytes Razorpay sent (the signature is over them), so server.js mounts this BEFORE the JSON body parser.
const razorpay = require('../utils/razorpay');
const { finalizeCheckout } = require('../utils/checkout');
const { sendOrderConfirmation } = require('../utils/notify');
const { invalidateAll } = require('../utils/cache');
const dataVersion = require('../utils/dataVersion');

module.exports = async function razorpayWebhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] a Razorpay webhook arrived but RAZORPAY_WEBHOOK_SECRET is not set on this server - add it and restart');
    return res.status(503).json({ message: 'Webhook secret is not configured.' });
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  if (!raw || !razorpay.verifyWebhookSignature(raw, req.get('X-Razorpay-Signature'), secret)) {
    return res.status(400).json({ message: 'Invalid signature.' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ message: 'Unreadable body.' }); }

  if (!['payment.captured', 'order.paid'].includes(event.event)) return res.json({ ok: true, ignored: event.event });
  const payload = event.payload || {};
  const payment = payload.payment && payload.payment.entity;
  const order = payload.order && payload.order.entity;
  const razorpayOrderId = (payment && payment.order_id) || (order && order.id);
  const paymentId = payment && payment.id;
  if (!razorpayOrderId || !paymentId) return res.json({ ok: true, ignored: 'no payment in this event' });

  try {
    const out = await finalizeCheckout({ razorpayOrderId, razorpayPaymentId: paymentId });
    if (out.status === 'placed') {
      invalidateAll(); dataVersion.bump();
      console.log(`[webhook] order ${out.order.id} placed from payment ${paymentId} (the customer's browser had not confirmed it)`);
      sendOrderConfirmation(out.order, out.customer);
    }
    res.json({ ok: true, status: out.status });
  } catch (err) {
    console.error(`[webhook] could not finish payment ${paymentId}:`, err);
    res.status(500).json({ message: 'Could not finish this payment yet.' });   // Razorpay will call again
  }
};
