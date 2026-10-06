// "Please review your saree" e-mail, sent a few days after an order is delivered.
//
// Why: reviews (especially with a customer's own photo) are what makes the next shopper trust a saree. Customers
// rarely come back on their own, so a friendly e-mail with the picture of what they bought and a button that opens the
// review form for that exact saree is the single biggest nudge.
//
// Rules, so it is never annoying:
//  - once per order, a few days (default 3) after it was delivered, and only within 30 days of delivery;
//  - only for orders delivered AFTER this switched on (old orders are never e-mailed in a flood);
//  - only for sarees the customer has not reviewed yet; nothing is sent if every saree is already reviewed;
//  - never to guest checkouts (they have no account to write a review from), cancelled orders, or an order with a
//    return request (that customer needs help, not a nudge);
//  - Admin -> Settings can switch it off or change the number of days.
const { supabase, must, getSetting, setSetting, getPrimaryImagesByVariantIds } = require('./db');
const { sendEmail, emailConfigured } = require('./notify');
const { computeStatus } = require('./orderStatus');

const SITE_URL = () => String(process.env.SITE_URL || 'https://padmorasarees.com').replace(/\/$/, '');
const DEFAULTS = { enabled: true, days: 3 };
const MAX_AGE_DAYS = 30;

const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A small copy of a saree photo for the e-mail (kept as the original file type so every mail app can show it).
function emailPhoto(url) {
  if (!url) return '';
  if (url.indexOf('/storage/v1/object/public/') === -1) return url.startsWith('/') ? SITE_URL() + url : url;
  return url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') + '?width=360&quality=75&resize=contain&format=origin';
}

// items: [{ id, name, color, imageUrl }]
function buildReviewReminderEmail({ name, orderId, items }) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const site = SITE_URL();
  const single = items.length === 1;
  const subject = single
    ? `How does your ${items[0].name} feel? Share a photo review`
    : 'How are your Padmora sarees? We would love to hear';

  const card = it => {
    const link = `${site}/account?review=${encodeURIComponent(orderId)}:${encodeURIComponent(it.id)}#orders`;
    const img = emailPhoto(it.imageUrl);
    return `
      <tr><td style="padding:14px 0;border-top:1px solid #efe4dc;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="112" valign="top">${img ? `<img src="${esc(img)}" width="100" height="130" alt="${esc(it.name)}" style="display:block;width:100px;height:130px;object-fit:cover;border-radius:8px;border:1px solid #efe4dc;">` : ''}</td>
          <td valign="middle" style="padding-left:6px;">
            <div style="font-family:Georgia,serif;font-size:17px;color:#4a1220;line-height:1.3;">${esc(it.name)}</div>
            ${it.color ? `<div style="font-family:Arial,sans-serif;font-size:13px;color:#8a6f6f;margin:3px 0 12px;">${esc(it.color)}</div>` : '<div style="height:12px;"></div>'}
            <a href="${esc(link)}" style="display:inline-block;background:#ad3b5c;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;letter-spacing:.3px;padding:12px 22px;border-radius:999px;">&#9733; Write a review</a>
          </td>
        </tr></table>
      </td></tr>`;
  };

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fbf3ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf3ee;padding:24px 12px;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(74,18,32,.08);">
      <tr><td style="background:#7a1f2b;padding:22px 28px;text-align:center;">
        <div style="font-family:Georgia,serif;font-size:26px;color:#f5e6c8;letter-spacing:1px;">Padmora</div>
        <div style="font-family:Arial,sans-serif;font-size:11px;color:#e7c6c0;letter-spacing:3px;margin-top:2px;">BY YASHI</div>
      </td></tr>
      <tr><td style="padding:30px 28px 8px;font-family:Georgia,serif;color:#3d2229;">
        <div style="font-size:22px;color:#7a1f2b;margin-bottom:12px;">Dear ${esc(first)},</div>
        <p style="font-size:16px;line-height:1.65;margin:0 0 12px;">${single ? 'Your saree has had a few days to settle into your wardrobe' : 'Your sarees have had a few days to settle into your wardrobe'}, and we hope ${single ? 'it has' : 'they have'} been everything you imagined.</p>
        <p style="font-size:16px;line-height:1.65;margin:0 0 6px;">Every Padmora saree is woven by hand. Your honest words &mdash; and a photo, if you can &mdash; help another woman choose with confidence, and help our weavers&rsquo; craft be seen. It takes about a minute.</p>
      </td></tr>
      <tr><td style="padding:6px 28px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map(card).join('')}</table>
      </td></tr>
      <tr><td style="padding:14px 28px 6px;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#6b5a5c;">
        <b style="color:#4a1220;">Tip:</b> a photo taken with your phone camera, in daylight, helps the most &mdash; the review form opens your camera for you.
      </td></tr>
      <tr><td style="padding:16px 28px 28px;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#6b5a5c;">
        Something not quite right with your order? Just reply to this e-mail and we will make it right.<br><br>
        With gratitude,<br><b style="color:#4a1220;">Yashi &amp; the Padmora team</b>
      </td></tr>
      <tr><td style="background:#f6ebe4;padding:14px 28px;text-align:center;font-family:Arial,sans-serif;font-size:11px;color:#9a8587;">
        You are getting this because you ordered ${esc(orderId)} on Padmora. <a href="${site}" style="color:#9a8587;">${esc(site.replace(/^https?:\/\//, ''))}</a>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;

  const text = `Dear ${first},\n\n${single ? 'Your saree has' : 'Your sarees have'} had a few days to settle in. We would love to hear what you think - and a photo from your phone camera helps the most.\n\n` +
    items.map(it => `${it.name}${it.color ? ' (' + it.color + ')' : ''}\nWrite a review: ${site}/account?review=${encodeURIComponent(orderId)}:${encodeURIComponent(it.id)}#orders\n`).join('\n') +
    `\nSomething not right? Just reply to this e-mail.\n\nWith gratitude,\nYashi & the Padmora team`;
  return { subject, html, text };
}

async function getConfig() {
  const cfg = await getSetting('review_reminder', {});
  return { enabled: cfg.enabled !== false, days: Number.isFinite(Number(cfg.days)) && Number(cfg.days) >= 1 ? Math.min(30, Math.floor(Number(cfg.days))) : DEFAULTS.days, since: cfg.since || null };
}

// What one order's reminder would contain (or null when there is nothing to ask for).
async function reminderFor(order) {
  if (order.source === 'instagram') return null;   // these sarees are not in the catalogue, so there is nothing to review
  const user = must(await supabase.from('users').select('id, name, email, is_guest').eq('id', order.user_id).maybeSingle(), 'reviewReminder:user');
  if (!user || user.is_guest || !user.email) return null;
  const ret = must(await supabase.from('return_requests').select('id').eq('order_id', order.id).limit(1), 'reviewReminder:return');
  if (ret.length) return null;
  const lines = must(await supabase.from('order_items').select('id, product_id, variant_id, name, color').eq('order_id', order.id), 'reviewReminder:items');
  if (!lines.length) return null;
  const reviewed = new Set(must(await supabase.from('reviews').select('product_id').eq('user_id', order.user_id).in('product_id', lines.map(l => l.product_id)), 'reviewReminder:reviewed').map(r => r.product_id));
  const todo = lines.filter(l => !reviewed.has(l.product_id));
  if (!todo.length) return { user, items: [] };
  const images = await getPrimaryImagesByVariantIds(todo.map(l => l.variant_id).filter(Boolean));
  return { user, items: todo.map(l => ({ id: l.id, name: l.name, color: l.color, imageUrl: images[l.variant_id] || '' })) };
}

// opts.ignoreSince / opts.dryRun are for tests and the admin preview.
async function checkReviewReminders(opts = {}) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { checked: 0, sent: 0, disabled: true };
  if (!opts.dryRun && !emailConfigured()) return { checked: 0, sent: 0, skipped: 'email not configured' };

  // The first time this runs it remembers the moment, so only orders delivered from then on are ever reminded.
  let since = cfg.since;
  if (!since && !opts.dryRun) {
    since = new Date().toISOString();
    await setSetting('review_reminder', { enabled: cfg.enabled, days: cfg.days, since });
  }
  const now = opts.now || Date.now();

  // Orders that are on the simulated timeline reach "Delivered" by the clock; looking at their status stamps the time.
  const recent = must(await supabase.from('orders').select('*').is('delivered_at', null).is('cancelled_at', null).gte('placed_at', new Date(now - 45 * 864e5).toISOString()), 'reviewReminder:unstamped');
  for (const o of recent) { try { await computeStatus(o); } catch (e) { /* skip */ } }

  const from = new Date(now - MAX_AGE_DAYS * 864e5).toISOString();
  const upTo = new Date(now - cfg.days * 864e5).toISOString();
  let q = supabase.from('orders').select('*').not('delivered_at', 'is', null).is('cancelled_at', null).is('review_reminder_sent_at', null).gte('delivered_at', from).lte('delivered_at', upTo);
  if (!opts.ignoreSince && since) q = q.gte('delivered_at', since);
  const orders = must(await q.order('delivered_at', { ascending: true }).limit(100), 'reviewReminder:orders');

  let sent = 0; const out = [];
  for (const order of orders) {
    const r = await reminderFor(order);
    if (!r || !r.items.length) {   // nothing to ask: remember that, so it is not looked at again
      if (!opts.dryRun) must(await supabase.from('orders').update({ review_reminder_sent_at: new Date().toISOString() }).eq('id', order.id), 'reviewReminder:markEmpty');
      continue;
    }
    const mail = buildReviewReminderEmail({ name: r.user.name, orderId: order.id, items: r.items });
    out.push({ orderId: order.id, to: r.user.email, subject: mail.subject, items: r.items.length });
    if (opts.dryRun) continue;
    const res = await sendEmail({ to: r.user.email, subject: mail.subject, html: mail.html, text: mail.text, orderId: order.id, userId: order.user_id });
    if (res.status === 'sent') {
      must(await supabase.from('orders').update({ review_reminder_sent_at: new Date().toISOString() }).eq('id', order.id), 'reviewReminder:markSent');
      sent++;
    }
  }
  return { checked: orders.length, sent, would: opts.dryRun ? out : undefined };
}

module.exports = { checkReviewReminders, buildReviewReminderEmail, reminderFor, getConfig, DEFAULTS };
