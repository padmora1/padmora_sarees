// Proactive low-stock email to the store's own contact address — fires once
// per real dip below a variant's threshold (low_stock_notified guards
// repeats on every interval tick) and resets automatically once restocked,
// so a future real dip can alert again.
const { supabase, must, getSetting } = require('./db');
const { sendEmail } = require('./notify');

const SITE_URL = process.env.SITE_URL || 'https://padmorasarees.com';

async function checkLowStock() {
  const variants = must(await supabase.from('product_variants').select('*').eq('archived', false), 'checkLowStock:variants');
  if (!variants.length) return { checked: 0, alerts: 0 };

  const productIds = [...new Set(variants.map(v => v.product_id))];
  const products = must(await supabase.from('products').select('id, name').in('id', productIds), 'checkLowStock:products');
  const nameById = Object.fromEntries(products.map(p => [p.id, p.name]));

  const store = await getSetting('store_info', {});
  const adminEmail = store.contactEmail;

  let alerts = 0;
  const lowOnes = [];
  for (const v of variants) {
    const isLow = v.stock <= v.low_stock_threshold;
    if (isLow && !v.low_stock_notified) {
      lowOnes.push({ ...v, product_name: nameById[v.product_id] });
      must(await supabase.from('product_variants').update({ low_stock_notified: true }).eq('id', v.id), 'checkLowStock:markNotified');
    } else if (!isLow && v.low_stock_notified) {
      must(await supabase.from('product_variants').update({ low_stock_notified: false }).eq('id', v.id), 'checkLowStock:resetNotified');
    }
  }

  if (lowOnes.length && adminEmail) {
    const rows = lowOnes.map(v => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${v.product_name} — ${v.color_name}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${v.stock}</td></tr>`).join('');
    await sendEmail({
      to: adminEmail,
      subject: `Low stock alert — ${lowOnes.length} item${lowOnes.length > 1 ? 's' : ''} need restocking`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A1F2B;">Low stock alert</h2>
        <p>The following variants have dropped at or below their low-stock threshold:</p>
        <table style="width:100%;border-collapse:collapse;margin:14px 0;">
          <thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #7A1F2B;">Item</th><th style="padding:6px 10px;border-bottom:2px solid #7A1F2B;">Stock left</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p><a href="${SITE_URL}/admin" style="color:#7A1F2B;">Open Inventory in the admin dashboard →</a></p>
      </div>`
    });
    alerts = lowOnes.length;
  }

  return { checked: variants.length, alerts };
}

module.exports = { checkLowStock };
