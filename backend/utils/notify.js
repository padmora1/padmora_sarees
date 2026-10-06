// Order-confirmation notifications (email + SMS).
//
// This module is fully wired end-to-end — templates, a send attempt, and a
// permanent admin-visible log of every attempt (backend/utils/db.js's
// notifications_log table, surfaced at GET /admin/notifications and on each
// order's detail view). What it can NOT do without the store owner's own
// credentials is actually hand a message to a real mail server or SMS
// carrier — that requires an SMTP account and an SMS provider account,
// neither of which exist by default. Until those env vars are set, every
// attempt is logged with status 'skipped_not_configured' so nothing is
// silently pretended to have sent.
//
// To activate real delivery, set in backend/.env:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM   (any SMTP provider —
//     Gmail app password, SendGrid, Mailgun, Amazon SES, etc.)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER   (or any other
//     Twilio-compatible SMS API — the request shape below is Twilio's)

const https = require('https');
const { logNotification } = require('./db');

const SITE_URL = process.env.SITE_URL || 'https://padmorasarees.com';
const { inquiryLink } = require('./inquiryToken');

let cachedTransporter = null;
let cachedTransporterKey = null;

function emailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function smsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
}

function getTransporter() {
  const key = process.env.SMTP_HOST + '|' + process.env.SMTP_USER;
  if (cachedTransporter && cachedTransporterKey === key) return cachedTransporter;
  // Required only when SMTP is actually configured — keeps the app booting
  // fine on a machine that never `npm install`ed it before this feature landed.
  const nodemailer = require('nodemailer');
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  cachedTransporterKey = key;
  return cachedTransporter;
}

async function sendEmail({ to, subject, html, text, orderId, userId }) {
  // Instagram customers who gave no e-mail are stored under an address that cannot receive mail - never try it.
  if (to && String(to).toLowerCase().endsWith('@instagram.padmora.invalid')) to = null;
  if (!to) {
    await logNotification({ orderId, userId, channel: 'email', recipient: to, subject, status: 'skipped_no_recipient' });
    return { status: 'skipped_no_recipient' };
  }
  if (!emailConfigured()) {
    await logNotification({ orderId, userId, channel: 'email', recipient: to, subject, status: 'skipped_not_configured', detail: 'Set SMTP_HOST/SMTP_USER/SMTP_PASS in backend/.env to enable real delivery.' });
    return { status: 'skipped_not_configured' };
  }
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, html, text
    });
    await logNotification({ orderId, userId, channel: 'email', recipient: to, subject, status: 'sent' });
    return { status: 'sent' };
  } catch (err) {
    await logNotification({ orderId, userId, channel: 'email', recipient: to, subject, status: 'failed', detail: err.message });
    return { status: 'failed', error: err.message };
  }
}

function twilioRequest(body) {
  return new Promise((resolve, reject) => {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const payload = new URLSearchParams(body).toString();
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${sid}/Messages.json`,
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Twilio ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendSms({ to, body, orderId, userId }) {
  if (!to) {
    await logNotification({ orderId, userId, channel: 'sms', recipient: to, status: 'skipped_no_recipient' });
    return { status: 'skipped_no_recipient' };
  }
  if (!smsConfigured()) {
    await logNotification({ orderId, userId, channel: 'sms', recipient: to, status: 'skipped_not_configured', detail: 'Set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER in backend/.env to enable real delivery.' });
    return { status: 'skipped_not_configured' };
  }
  try {
    await twilioRequest({ To: to, From: process.env.TWILIO_FROM_NUMBER, Body: body });
    await logNotification({ orderId, userId, channel: 'sms', recipient: to, status: 'sent' });
    return { status: 'sent' };
  } catch (err) {
    await logNotification({ orderId, userId, channel: 'sms', recipient: to, status: 'failed', detail: err.message });
    return { status: 'failed', error: err.message };
  }
}

function orderConfirmationEmailHtml(order, customerName) {
  const rows = order.items.map(li =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${li.name}${li.color ? ' — ' + li.color : ''}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${li.qty}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">₹${li.price}</td></tr>`
  ).join('');
  return `
  <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#2b1015;">
    <h2 style="color:#7A1F2B;">Padmora by Yashi</h2>
    <p>Hi ${customerName || 'there'},</p>
    <p>Thank you for your order! Here's your confirmation.</p>
    <p style="font-size:13px;color:#666;">Order ID: <strong>${order.id}</strong></p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #7A1F2B;">Item</th><th style="padding:6px 10px;border-bottom:2px solid #7A1F2B;">Qty</th><th style="text-align:right;padding:6px 10px;border-bottom:2px solid #7A1F2B;">Price</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="text-align:right;font-size:13px;color:#555;">
      Subtotal: ₹${order.subtotal}<br>
      ${order.discount ? `Discount: −₹${order.discount}<br>` : ''}
      ${order.shippingFee ? `Shipping: ₹${order.shippingFee}<br>` : 'Shipping: Free<br>'}
      ${order.taxAmount ? `Tax: ₹${order.taxAmount}<br>` : ''}
    </p>
    <p style="text-align:right;font-size:16px;"><strong>Total: ₹${order.total}</strong></p>
    <p>Shipping to: ${[order.address.line1, [order.address.city, order.address.state].filter(Boolean).join(', '), order.address.pincode && !String(order.address.line1 || '').includes(order.address.pincode) ? order.address.pincode : ''].filter(Boolean).join(', ')}</p>
    <p>Payment method: ${order.payment}</p>
    <p style="margin-top:24px;color:#999;font-size:12px;">You can track this order anytime at ${SITE_URL.replace(/^https?:\/\//, '')}/track-order</p>
    <p style="margin-top:10px;color:#999;font-size:12px;">Once it is delivered, any problem with it can be raised from your <a href="${inquiryLink(order.id)}" style="color:#7A1F2B;">order inquiry page</a> &mdash; no login needed.</p>
  </div>`;
}

function orderConfirmationSmsText(order) {
  return `Padmora by Yashi: Your order ${order.id} for Rs.${order.total} is confirmed! Track it at ${SITE_URL.replace(/^https?:\/\//, '')}/track-order`;
}

// Fire-and-forget: called right after an order is placed. Never throws —
// a notification failure must never fail (or roll back) the order itself.
function sendOrderConfirmation(order, customer) {
  const emailHtml = orderConfirmationEmailHtml(order, customer && customer.name);
  const smsText = orderConfirmationSmsText(order);
  Promise.resolve()
    .then(() => sendEmail({
      to: customer && customer.email,
      subject: `Your Padmora order ${order.id} is confirmed`,
      html: emailHtml,
      orderId: order.id,
      userId: customer && customer.id
    }))
    .catch(() => {});
  Promise.resolve()
    .then(() => sendSms({
      to: order.address && order.address.phone,
      body: smsText,
      orderId: order.id,
      userId: customer && customer.id
    }))
    .catch(() => {});
}

// "Your order is packed / shipped / out for delivery / delivered" — sent when an
// admin moves an order forward (singly or via the bulk upload). Awaited by the
// caller's background loop, never inline in a request; a failure is logged to
// notifications_log by sendEmail and must not stop the rest of a batch.
const STATUS_EMAIL = {
  'Packed': { subject: 'is packed', headline: 'Your order is packed', body: "Good news — your saree has been carefully packed and is getting ready to ship." },
  'Shipped': { subject: 'has shipped', headline: 'Your order has shipped', body: "Your order is on its way. We'll update the tracking page as it moves." },
  'Out for Delivery': { subject: 'is out for delivery', headline: 'Out for delivery today', body: "Your order is out for delivery and should reach you soon. Please keep your phone handy." },
  'Delivered': { subject: 'has been delivered', headline: 'Your order has been delivered', body: "Your order has been delivered. We hope you love it — thank you for shopping with Padmora." }
};

async function sendOrderStatusEmail(order, customer, status) {
  const tpl = STATUS_EMAIL[status];
  if (!tpl) return { status: 'skipped_no_template' };
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return sendEmail({
    to: customer && customer.email,
    subject: `Your Padmora order ${order.id} ${tpl.subject}`,
    html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;color:#2b1015;">
      <h2 style="color:#7A1F2B;">${tpl.headline}</h2>
      <p>Hi ${esc((customer && customer.name) || 'there')},</p>
      <p>${tpl.body}</p>
      <p style="font-size:13px;color:#666;">Order ID: <strong>${esc(order.id)}</strong></p>
      ${status === 'Delivered' ? `<p style="margin-top:18px;">Is something not right with your saree? You have 7 days to tell us:</p><p><a href="${inquiryLink(order.id)}" style="display:inline-block;background:#ad3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-family:Arial,sans-serif;font-weight:bold;">Order inquiry (return &amp; refund)</a></p><p style="font-size:12px;color:#8a6f6f;">No login needed &mdash; this private link is for your order only. You will need 3 photos of the saree.</p>` : ''}
      <p style="margin-top:24px;color:#999;font-size:12px;">Track it anytime at ${SITE_URL.replace(/^https?:\/\//, '')}/track-order</p>
    </div>`,
    orderId: order.id,
    userId: customer && customer.id
  });
}

module.exports = { sendEmail, sendSms, sendOrderConfirmation, sendOrderStatusEmail, emailConfigured, smsConfigured };
