// Turns a PAID Razorpay checkout into a store order - exactly once, whoever tells us about the payment first.
//
// Two messengers can announce a payment: the customer's browser (POST /razorpay/verify) and Razorpay's own server (the webhook, which is
// what saves the order when the customer closes the page right after paying). Both call finalizeCheckout(). It
//   1. asks Razorpay for the payment and checks it is for this Razorpay order, in INR, for exactly the amount priced, and not failed;
//   2. CLAIMS the checkout with one atomic database update (created -> processing), so a second caller cannot also place an order;
//   3. places the order at the price the customer was shown (discount and shipping locked at checkout, not recomputed);
//   4. if the order cannot be placed because the saree sold out meanwhile, refunds the payment automatically (idempotent) and says so;
//   5. if anything else goes wrong (a database hiccup) releases the claim so the browser or Razorpay's retry can finish it.
const { supabase, must, getSetting } = require('./db');
const razorpay = require('./razorpay');
const { OrderError, placeOrderTx, findOrCreateGuestUser } = require('../routes/orders');
const { sendEmail } = require('./notify');

const CLAIM_STALE_MS = 2 * 60 * 1000;   // a claim older than this belonged to a request that died; another caller may take over

async function loadOrderByRazorpayOrder(razorpayOrderId) {
  return must(await supabase.from('orders').select('*').eq('razorpay_order_id', razorpayOrderId).maybeSingle(), 'checkout:orderByRzp');
}

// Is the payment real, for this checkout, for the right amount? -> { ok: true } | { ok: false, reason }
// (If Razorpay itself cannot be reached the signed message is trusted rather than turning a paying customer away.)
async function checkPayment(pending, razorpayOrderId, paymentId) {
  let p;
  try { p = await razorpay.fetchPayment(paymentId); }
  catch (err) {
    if (err && err.statusCode === 404) return { ok: false, reason: 'Razorpay has no such payment.' };
    console.warn(`[checkout] could not fetch payment ${paymentId} from Razorpay (${err && err.message}); relying on the signature`);
    return { ok: true, unchecked: true };
  }
  if (p.order_id && p.order_id !== razorpayOrderId) return { ok: false, reason: 'That payment belongs to a different Razorpay order.' };
  if (p.currency && p.currency !== 'INR') return { ok: false, reason: 'The payment is not in INR.' };
  if (Number(p.amount) !== Math.round(Number(pending.amount) * 100)) return { ok: false, reason: `The amount paid (${Number(p.amount) / 100}) is not the amount priced (${pending.amount}).` };
  if (!['captured', 'authorized'].includes(p.status)) return { ok: false, reason: `The payment status is "${p.status}".` };
  return { ok: true, payment: p };
}

async function alertStore(subject, html) {
  try {
    const info = await getSetting('store_info', {});
    if (info && info.contactEmail) await sendEmail({ to: info.contactEmail, subject, html });
  } catch (e) { /* the server log below is the record */ }
}

// Waits (briefly) for another caller that is already finalising this checkout, then returns its order.
async function waitForOrder(razorpayOrderId, ms = 9000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const order = await loadOrderByRazorpayOrder(razorpayOrderId);
    if (order) return order;
    await new Promise(r => setTimeout(r, 350));
  }
  return null;
}

// -> { status: 'placed', order, customer }  the order was placed by THIS call
//    { status: 'already', order }           it had been placed before (or is being placed by another call and just finished)
//    { status: 'processing' }               another call is still working on it
//    { status: 'refunded' | 'failed', message }  could not be placed; refunded automatically / needs the owner
//    { status: 'rejected', message }        the payment itself does not check out
//    { status: 'unknown' }                  no such checkout
async function finalizeCheckout({ razorpayOrderId, razorpayPaymentId }) {
  const pending = must(await supabase.from('pending_checkouts').select('*').eq('id', razorpayOrderId).maybeSingle(), 'checkout:pending');
  if (!pending) return { status: 'unknown' };

  if (pending.status === 'verified') {
    const order = await loadOrderByRazorpayOrder(razorpayOrderId);
    return order ? { status: 'already', order } : { status: 'failed', message: 'This payment was recorded but its order could not be found.' };
  }
  if (pending.status === 'refunded') return { status: 'refunded', message: pending.failure_note || 'This payment was refunded automatically.' };
  if (pending.status === 'failed') return { status: 'failed', message: pending.failure_note || 'This payment needs attention.' };

  const check = await checkPayment(pending, razorpayOrderId, razorpayPaymentId);
  if (!check.ok) {
    console.error(`[checkout] payment ${razorpayPaymentId} for ${razorpayOrderId} REJECTED: ${check.reason}`);
    return { status: 'rejected', message: check.reason };
  }

  // the atomic claim: only one caller can move created -> processing (or take over a claim that went stale)
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const claimed = must(await supabase.from('pending_checkouts')
    .update({ status: 'processing', claimed_at: new Date().toISOString() })
    .eq('id', razorpayOrderId)
    .or(`status.eq.created,and(status.eq.processing,claimed_at.lt.${staleBefore})`)
    .select('*'), 'checkout:claim');
  if (!claimed.length) {
    const order = await waitForOrder(razorpayOrderId);
    return order ? { status: 'already', order } : { status: 'processing' };
  }
  const row = claimed[0];

  try {
    // A claim taken over from a request that died after placing the order: nothing to place, just finish the bookkeeping.
    let shaped = null, existing = row.order_id ? must(await supabase.from('orders').select('*').eq('id', row.order_id).maybeSingle(), 'checkout:reserved') : null;

    const storedLines = JSON.parse(row.line_items);
    const direct = !Array.isArray(storedLines) && !!storedLines.direct;   // Buy Now: the bag stays as it is
    const lineItems = Array.isArray(storedLines) ? storedLines : storedLines.items;
    const address = JSON.parse(row.address);

    let userId = row.user_id, customer, afterInsertWithinTx;
    if (row.is_guest) {
      const user = await findOrCreateGuestUser({ email: row.email, name: address.name, phone: address.phone });
      userId = user.id; customer = user;
    } else {
      customer = must(await supabase.from('users').select('id, name, email').eq('id', userId).maybeSingle(), 'checkout:customer');
      if (!direct) afterInsertWithinTx = async () => {
        must(await supabase.from('cart_items').delete().eq('user_id', userId), 'checkout:clearCartItems');
        must(await supabase.from('cart_meta').delete().eq('user_id', userId), 'checkout:clearCartMeta');
      };
    }

    let placedNow = false;
    if (existing) {
      const { shapeOrder } = require('../routes/orders');
      shaped = await shapeOrder(existing);
    } else {
      shaped = await placeOrderTx({
        userId, lineItems, subtotal: row.subtotal, couponCode: row.coupon_code, address, payment: 'Razorpay', afterInsertWithinTx,
        locked: (row.discount != null && row.shipping_fee != null) ? { discount: row.discount, shippingFee: row.shipping_fee } : null,
        onOrderId: async id => { must(await supabase.from('pending_checkouts').update({ order_id: id }).eq('id', razorpayOrderId), 'checkout:reserveId'); }
      });
      placedNow = true;
    }
    if (Math.abs(Number(shaped.total) - Number(row.amount)) > 0.5) {
      console.error(`[checkout] AMOUNT MISMATCH on order ${shaped.id}: order total ${shaped.total} but ${row.amount} was paid (payment ${razorpayPaymentId})`);
      await alertStore(`Check order ${shaped.id}: the total differs from the amount paid`, `<p>Order <strong>${shaped.id}</strong> has a total of ₹${shaped.total} but the customer paid ₹${row.amount} (Razorpay payment ${razorpayPaymentId}). Please check it in Admin.</p>`);
    }
    must(await supabase.from('orders').update({ razorpay_order_id: razorpayOrderId, razorpay_payment_id: razorpayPaymentId }).eq('id', shaped.id), 'checkout:stampPaymentIds');
    must(await supabase.from('pending_checkouts').update({ status: 'verified' }).eq('id', razorpayOrderId), 'checkout:markConsumed');
    return placedNow ? { status: 'placed', order: shaped, customer } : { status: 'already', order: shaped };
  } catch (err) {
    if (err instanceof OrderError) {
      // The money is taken but the order cannot be placed (the saree sold out in the meantime): give it back automatically.
      console.error(`[checkout] payment ${razorpayPaymentId} (${razorpayOrderId}) cannot become an order: ${err.message} - refunding automatically`);
      try {
        const refund = await razorpay.refundPayment(razorpayPaymentId, row.amount, { reason: 'Order could not be placed', razorpay_order_id: razorpayOrderId }, 'rfnd-auto-' + razorpayOrderId);
        const note = `Sorry - ${err.message.replace(/\.$/, '')}. Your payment of ₹${row.amount} has been refunded automatically (refund ${refund.id}); it reaches your account in 5-7 working days.`;
        must(await supabase.from('pending_checkouts').update({ status: 'refunded', failure_note: note }).eq('id', razorpayOrderId), 'checkout:markRefunded');
        await alertStore('A paid checkout was refunded automatically', `<p>Payment ${razorpayPaymentId} (₹${row.amount}) could not become an order (${err.message}) and was refunded automatically (refund ${refund.id}).</p>`);
        return { status: 'refunded', message: note };
      } catch (refundErr) {
        const note = `Payment ${razorpayPaymentId} (₹${row.amount}) could not become an order (${err.message}) and the automatic refund FAILED (${razorpay.refundErrorMessage(refundErr)}). Refund it from the Razorpay dashboard.`;
        console.error('[checkout] ' + note);
        await supabase.from('pending_checkouts').update({ status: 'failed', failure_note: note }).eq('id', razorpayOrderId);
        await alertStore('ACTION NEEDED: a customer paid but no order was placed', `<p>${note}</p>`);
        return { status: 'failed', message: `Payment received, but ${err.message.toLowerCase()} Contact us with payment ID ${razorpayPaymentId} and we'll refund it right away.` };
      }
    }
    // not the customer's problem (database hiccup, ...): release the claim so the browser's retry or Razorpay's webhook retry can finish it
    console.error(`[checkout] payment ${razorpayPaymentId} (${razorpayOrderId}) verified but finishing the order failed - released for retry:`, err);
    await supabase.from('pending_checkouts').update({ status: 'created', claimed_at: null }).eq('id', razorpayOrderId);
    throw err;
  }
}

module.exports = { finalizeCheckout, loadOrderByRazorpayOrder, CLAIM_STALE_MS };
