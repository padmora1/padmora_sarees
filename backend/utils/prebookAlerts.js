// Pre-Book back-in-stock notifications. A prebook_requests row only ever
// exists for a variant that was out of stock at the moment someone asked to
// be notified (products.js's POST /:id/prebook rejects the request
// otherwise), so "notified = false AND stock > 0" is exactly and only the
// real restock event — no need to track a previous-stock snapshot the way
// wishlist alerts do.
const { supabase, must } = require('./db');
const { sendEmail } = require('./notify');

const SITE_URL = process.env.SITE_URL || 'https://padmorasarees.com';

async function checkPrebookNotifications() {
  const pending = must(await supabase.from('prebook_requests').select('*').eq('notified', false), 'checkPrebookNotifications:pending');
  if (!pending.length) return { checked: 0, sent: 0 };

  const variantIds = [...new Set(pending.map(p => p.variant_id))];
  const variants = must(await supabase.from('product_variants').select('id, product_id, color_name, stock').in('id', variantIds).gt('stock', 0), 'checkPrebookNotifications:variants');
  const variantById = Object.fromEntries(variants.map(v => [v.id, v]));

  const rows = pending.filter(p => variantById[p.variant_id]);
  if (!rows.length) return { checked: 0, sent: 0 };

  const productIds = [...new Set(rows.map(r => variantById[r.variant_id].product_id))];
  const products = must(await supabase.from('products').select('id, name').in('id', productIds), 'checkPrebookNotifications:products');
  const productNameById = Object.fromEntries(products.map(p => [p.id, p.name]));

  const now = new Date().toISOString();
  let sent = 0;

  for (const row of rows) {
    const variant = variantById[row.variant_id];
    const productName = productNameById[variant.product_id];
    await sendEmail({
      to: row.email,
      subject: `${productName} — ${variant.color_name} is back in stock!`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A1F2B;">Good news, ${row.name || 'there'}!</h2>
        <p>You asked to be told when <strong>${productName} — ${variant.color_name}</strong> was back — it's in stock now, with ${variant.stock} available.</p>
        <p><a href="${SITE_URL}/product?id=${variant.product_id}" style="color:#7A1F2B;font-weight:bold;">View it now →</a></p>
        <p style="color:#6f5a5c;font-size:12.5px;">It's first-come, first-served, so it's worth not waiting too long.</p>
      </div>`,
      userId: null
    });
    must(await supabase.from('prebook_requests').update({ notified: true, notified_at: now }).eq('id', row.id), 'checkPrebookNotifications:markNotified');
    sent++;
  }

  return { checked: rows.length, sent };
}

module.exports = { checkPrebookNotifications };
