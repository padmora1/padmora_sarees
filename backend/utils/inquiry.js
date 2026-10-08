// Order inquiry (return and refund) - the rules, shared by the logged-in routes (routes/returns.js) and the private
// e-mail link used by guests (routes/inquiry.js), so both behave identically:
//  - only a delivered order, only inside the return window (policy: Admin -> Settings, 7 days by default);
//  - the customer picks the kind of inquiry, the saree(s), the reason, writes what is wrong and adds at least 3 photos;
//  - an admin approves or rejects it; a rejected inquiry gets ONE more try (a second and last chance), also within a window;
//  - once approved, the existing return -> received -> refund steps in the admin take over.
const fs = require('fs');
const path = require('path');
const { supabase, must, getSetting } = require('./db');
const { computeStatus } = require('./orderStatus');
const { isCustomerPhotoUrl } = require('./storage');
const { sendEmail } = require('./notify');
const { inquiryLink } = require('./inquiryToken');
const { RETURN_REASONS, categoryForReason, getReturnPolicy, isWithinReturnWindow, computeReturnRefund } = require('./returns');

const INQUIRY_TYPES = [{ key: 'return_refund', label: 'Return and refund' }];
const MAX_ATTEMPTS = 2;
const MIN_PHOTOS = 3;
const MAX_PHOTOS = 5;
const DAY = 864e5;

const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Where this order stands: can an inquiry be made now, which attempt is it, or why not.
async function getInquiryState(order, opts = {}) {
  const orderStatus = opts.status || await computeStatus(order);
  const policy = await getReturnPolicy();
  const rows = must(await supabase.from('return_requests').select('id, attempt, status, admin_note, decided_at, requested_at').eq('order_id', order.id).order('attempt', { ascending: true }), 'inquiryState:rows');
  const requests = rows.map(r => ({ id: r.id, attempt: r.attempt, status: r.status, adminNote: r.admin_note, decidedAt: r.decided_at, requestedAt: r.requested_at }));
  const base = { orderStatus, policy: { enabled: policy.enabled, windowDays: policy.windowDays }, maxAttempts: MAX_ATTEMPTS, minPhotos: MIN_PHOTOS, maxPhotos: MAX_PHOTOS, requests, attemptsUsed: rows.length };
  const last = rows[rows.length - 1];
  const open = rows.find(r => r.status !== 'Rejected');
  if (open) return { ...base, eligible: false, reason: 'already_requested', activeStatus: open.status };
  if (last && rows.length >= MAX_ATTEMPTS) return { ...base, eligible: false, reason: 'final_rejected', finalRejected: true };
  if (orderStatus !== 'Delivered') return { ...base, eligible: false, reason: 'not_delivered' };
  if (!policy.enabled) return { ...base, eligible: false, reason: 'returns_off' };
  const secondChance = !!last;   // the only way to get here with a row is a rejected first attempt
  const windowEnds = order.delivered_at ? new Date(new Date(order.delivered_at).getTime() + policy.windowDays * DAY) : null;
  const chanceEnds = secondChance && last.decided_at ? new Date(new Date(last.decided_at).getTime() + policy.windowDays * DAY) : null;
  const inWindow = await isWithinReturnWindow(order);
  const inChance = !!chanceEnds && chanceEnds.getTime() >= Date.now();
  if (!inWindow && !inChance) return { ...base, eligible: false, reason: 'window_closed' };
  const deadline = [windowEnds, chanceEnds].filter(Boolean).sort((a, b) => b - a)[0] || null;
  return { ...base, eligible: true, reason: null, attempt: rows.length + 1, secondChance, deadline: deadline ? deadline.toISOString() : null, reasons: RETURN_REASONS, types: INQUIRY_TYPES };
}

// One short, honest sentence for every reason an inquiry cannot be made.
function explain(state) {
  switch (state.reason) {
    case 'not_delivered': return 'Order inquiries open once your order has been delivered.';
    case 'returns_off': return 'Returns are not being accepted at the moment. Please contact us.';
    case 'window_closed': return `The ${state.policy.windowDays}-day window for an order inquiry has closed for this order. Please contact us if you need help.`;
    case 'already_requested': return state.activeStatus === 'Refunded' ? 'This order has already been returned and refunded.' : `You already have an inquiry for this order (${state.activeStatus}).`;
    case 'final_rejected': return 'Both of your inquiries for this order were reviewed and could not be approved. Please contact us if you need more help.';
    default: return 'An inquiry cannot be made for this order.';
  }
}

async function storeContactEmail() {
  const info = await getSetting('store_info', {});
  return info.contactEmail || null;
}

// Validates and stores an inquiry. Returns { error: { status, message } } or { request }.
async function createInquiry({ order, userId, body }) {
  const state = await getInquiryState(order);
  if (!state.eligible) return { error: { status: 400, message: explain(state) } };

  const { type, reason, description, items, photoUrls } = body || {};
  if (!INQUIRY_TYPES.some(t => t.key === type)) return { error: { status: 400, message: 'Choose what your inquiry is about.' } };
  if (!RETURN_REASONS.some(r => r.key === reason)) return { error: { status: 400, message: 'Choose a reason.' } };
  const text = String(description || '').trim();
  if (text.length < 10) return { error: { status: 400, message: 'Please describe what is wrong, in at least a sentence.' } };
  if (text.length > 1000) return { error: { status: 400, message: 'Please keep the description under 1000 characters.' } };
  if (!Array.isArray(items) || !items.length) return { error: { status: 400, message: 'Select at least one saree.' } };

  const photos = Array.isArray(photoUrls) ? [...new Set(photoUrls.filter(u => isCustomerPhotoUrl(u, 'return-')))] : [];
  if (photos.length < MIN_PHOTOS) return { error: { status: 400, message: `Please add ${MIN_PHOTOS} photos of the saree (taken with your camera).` } };
  if (photos.length > MAX_PHOTOS) return { error: { status: 400, message: `Up to ${MAX_PHOTOS} photos.` } };
  const missing = photos.find(u => u.startsWith('/uploads/') && !fs.existsSync(path.join(__dirname, '..', 'uploads', path.basename(u))));
  if (missing) return { error: { status: 400, message: 'One of the photos could not be found - please add it again.' } };

  const orderItems = must(await supabase.from('order_items').select('*').eq('order_id', order.id), 'createInquiry:items');
  const byId = new Map(orderItems.map(i => [i.id, i]));
  const lines = [];
  const seen = new Set();
  for (const sel of items) {
    const oi = byId.get(Number(sel.orderItemId));
    const qty = Number(sel.qty);
    if (!oi || seen.has(oi.id)) return { error: { status: 400, message: 'That saree is not part of this order.' } };
    if (!Number.isInteger(qty) || qty < 1 || qty > oi.qty) return { error: { status: 400, message: `Choose a valid quantity for ${oi.name} (up to ${oi.qty}).` } };
    seen.add(oi.id);
    lines.push({ orderItemId: oi.id, price: oi.price, qty });
  }
  const allReturned = orderItems.every(oi => { const l = lines.find(x => x.orderItemId === oi.id); return l && l.qty === oi.qty; });
  const category = categoryForReason(reason);
  const refund = computeReturnRefund(order, lines, allReturned, category);
  // The inquiry form does not ask how to be refunded: the money goes back the way it was paid. (A Cash on Delivery order
  // has nothing to send back to, so the team asks for payout details after approving.)
  const cod = order.payment === 'COD';

  const rpc = await supabase.rpc('create_return_request', {
    p_order_id: order.id, p_user_id: userId, p_reason: reason, p_reason_category: category, p_reason_detail: text,
    p_refund_method: cod ? 'bank_transfer' : 'original', p_refund_account_detail: cod ? 'To be collected by Padmora (Cash on Delivery order)' : null,
    p_computed_refund_amount: refund, p_items: lines.map(l => ({ orderItemId: l.orderItemId, qty: l.qty })), p_photo_urls: photos, p_attempt: state.attempt
  });
  if (rpc.error) throw new Error(rpc.error.message);
  const request = must(await supabase.from('return_requests').select('*').eq('id', rpc.data).single(), 'createInquiry:reread');
  notifySubmitted(order, userId, request, state).catch(() => {});
  return { request, state };
}

// "We got your inquiry" to the customer, and a heads-up to the store. Never breaks the request itself.
async function notifySubmitted(order, userId, request, state) {
  const user = must(await supabase.from('users').select('name, email').eq('id', userId).maybeSingle(), 'inquiryNotify:user');
  const first = String((user && user.name) || '').trim().split(/\s+/)[0] || 'there';
  if (user && user.email) {
    await sendEmail({
      to: user.email, subject: `We received your inquiry for order ${order.id}`, orderId: order.id, userId,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;color:#2b1015;">
        <h2 style="color:#7A1F2B;">We received your inquiry</h2>
        <p>Hi ${esc(first)},</p>
        <p>Thank you &mdash; your inquiry for order <strong>${esc(order.id)}</strong> is with our team${state.secondChance ? ' (this is your second and last chance)' : ''}. We will look at your photos and reply by e-mail, usually within 1&ndash;2 working days.</p>
        <p style="font-size:13px;color:#6f5a5c;">You can follow it any time here: <a href="${esc(inquiryLink(order.id))}" style="color:#7A1F2B;">${esc(inquiryLink(order.id))}</a></p>
      </div>`
    });
  }
  const to = await storeContactEmail();
  if (to) {
    await sendEmail({
      to, subject: `New order inquiry - ${order.id}${state.secondChance ? ' (second attempt)' : ''}`, orderId: order.id,
      html: `<p>A customer sent an order inquiry for <strong>${esc(order.id)}</strong> (attempt ${state.attempt} of ${MAX_ATTEMPTS}). Open Admin &rarr; Returns to approve or reject it.</p>`
    });
  }
}

// The e-mail a customer gets when an admin approves or rejects their inquiry. A first rejection carries the private link
// for the second (last) chance.
function decisionEmail({ approve, name, orderId, adminNote, attempt }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const subject = approve ? `Your inquiry for order ${orderId} was approved` : `Update on your inquiry for order ${orderId}`;
  const again = !approve && (attempt || 1) < MAX_ATTEMPTS;
  const html = `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;color:#2b1015;">
    <h2 style="color:#7A1F2B;">${approve ? 'Return approved' : 'Update on your inquiry'}</h2>
    <p>Hi ${esc(first)},</p>
    <p>${approve
      ? `Your inquiry for order <strong>${esc(orderId)}</strong> has been approved. Please ship the item(s) back to us &mdash; we will e-mail you again once we have received and inspected them, and then send your refund.`
      : `We are sorry &mdash; we are not able to approve your inquiry for order <strong>${esc(orderId)}</strong>.`}</p>
    ${adminNote ? `<p style="color:#6f5a5c;">Note from our team: ${esc(adminNote)}</p>` : ''}
    ${again ? `<p>You have <strong>one more chance</strong>. If something was missing &mdash; clearer photos, a fuller description &mdash; you can send a new inquiry here:</p>
    <p><a href="${esc(inquiryLink(orderId))}" style="display:inline-block;background:#ad3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-family:Arial,sans-serif;font-weight:bold;">Send my second inquiry</a></p>
    <p style="font-size:12px;color:#8a6f6f;">It is available for 7 days. After that second inquiry, our decision is final.</p>` : ''}
    ${!approve && !again ? `<p style="color:#6f5a5c;">This was your second inquiry for this order, so we cannot take it further here. If you think we have got something wrong, just reply to this e-mail.</p>` : ''}
  </div>`;
  return { subject, html };
}

module.exports = { getInquiryState, createInquiry, explain, decisionEmail, INQUIRY_TYPES, MAX_ATTEMPTS, MIN_PHOTOS, MAX_PHOTOS };
