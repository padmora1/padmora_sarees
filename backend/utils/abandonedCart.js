// Abandoned-cart recovery email. Only meaningful for a logged-in customer's
// server-side cart (cart_items) — a guest's cart lives entirely in their
// own browser's localStorage (see frontend/js/api.js's guest cart), so the
// server never sees it and honestly can't email them about it.
const { supabase, must } = require('./db');
const { sendEmail } = require('./notify');

const SITE_URL = process.env.SITE_URL || 'https://padmorasarees.com';

const ABANDON_AFTER_MS = 3 * 60 * 60 * 1000;   // idle for 3+ hours counts as abandoned
const GIVE_UP_AFTER_MS = 5 * 24 * 60 * 60 * 1000; // stop trying after 5 days (stale cart, not worth emailing)

async function checkAbandonedCarts() {
  const cartItems = must(await supabase.from('cart_items').select('user_id, updated_at'), 'checkAbandonedCarts:items');
  if (!cartItems.length) return { checked: 0, sent: 0 };

  // GROUP BY user_id, MAX(updated_at) — done in JS since this is a small,
  // infrequent background job rather than a hot query path.
  const lastUpdatedByUser = {};
  for (const item of cartItems) {
    if (!item.updated_at) continue;
    if (!lastUpdatedByUser[item.user_id] || item.updated_at > lastUpdatedByUser[item.user_id]) {
      lastUpdatedByUser[item.user_id] = item.updated_at;
    }
  }
  const userIds = Object.keys(lastUpdatedByUser);
  if (!userIds.length) return { checked: 0, sent: 0 };

  const users = must(await supabase.from('users').select('id, email, name, is_guest').in('id', userIds), 'checkAbandonedCarts:users');
  const userById = Object.fromEntries(users.map(u => [u.id, u]));
  const metaRows = must(await supabase.from('cart_meta').select('user_id, recovery_email_sent_at').in('user_id', userIds), 'checkAbandonedCarts:meta');
  const metaByUser = Object.fromEntries(metaRows.map(m => [m.user_id, m]));

  const now = Date.now();
  let sent = 0;

  for (const userId of userIds) {
    const user = userById[userId];
    const lastUpdated = lastUpdatedByUser[userId];
    // A guest checkout's auto-created account never had a real session to
    // "come back" to — nudging them to log in makes no sense.
    if (!user || user.is_guest || !lastUpdated || !user.email) continue;

    const age = now - new Date(lastUpdated).getTime();
    if (age < ABANDON_AFTER_MS || age > GIVE_UP_AFTER_MS) continue;

    const meta = metaByUser[userId];
    if (meta && meta.recovery_email_sent_at) continue; // already sent for this abandonment

    const items = must(
      await supabase.from('cart_items').select('qty, product_id').eq('user_id', userId),
      'checkAbandonedCarts:cartLines'
    );
    if (!items.length) continue;
    const productIds = items.map(i => i.product_id);
    const products = must(await supabase.from('products').select('id, name, price').in('id', productIds), 'checkAbandonedCarts:products');
    const productById = Object.fromEntries(products.map(p => [p.id, p]));

    const rowsHtml = items.map(i => {
      const p = productById[i.product_id] || {};
      return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${p.name || ''}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${i.qty}</td></tr>`;
    }).join('');

    await sendEmail({
      to: user.email,
      subject: 'You left something beautiful in your bag',
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A1F2B;">Still thinking it over, ${user.name || 'there'}?</h2>
        <p>Your bag is waiting for you:</p>
        <table style="width:100%;border-collapse:collapse;margin:14px 0;">
          <thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #7A1F2B;">Item</th><th style="padding:6px 10px;border-bottom:2px solid #7A1F2B;">Qty</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <p><a href="${SITE_URL}/cart" style="color:#7A1F2B;font-weight:bold;">Return to your bag →</a></p>
      </div>`,
      userId
    });
    must(await supabase.from('cart_meta').upsert({ user_id: userId, recovery_email_sent_at: new Date().toISOString() }, { onConflict: 'user_id' }), 'checkAbandonedCarts:markSent');
    sent++;
  }

  return { checked: userIds.length, sent };
}

module.exports = { checkAbandonedCarts };
