// Wishlist price-drop / back-in-stock alerts. Only meaningful for logged-in
// customers — a guest's wishlist lives entirely in their browser's
// localStorage (see frontend/js/api.js), so the server has no baseline price
// or stock to compare against and honestly can't alert them by email.
//
// A price-drop alert fires once per dip (notified_price_drop guards repeats);
// it resets automatically if the price returns to/above what the customer
// originally saw, so a later real drop can alert again. A back-in-stock
// alert fires on the actual 0 → >0 transition, detected by comparing against
// last_known_stock, which this same job updates on every run.
const { supabase, must, getProducts } = require('./db');
const { sendEmail } = require('./notify');

const SITE_URL = process.env.SITE_URL || 'https://padmorasarees.com';

async function checkWishlistAlerts() {
  const rows = must(await supabase.from('wishlist_items').select('*'), 'checkWishlistAlerts:items');
  if (!rows.length) return { checked: 0, priceDrops: 0, restocks: 0 };

  const userIds = [...new Set(rows.map(r => r.user_id))];
  const users = must(await supabase.from('users').select('id, email, name').in('id', userIds), 'checkWishlistAlerts:users');
  const userById = Object.fromEntries(users.map(u => [u.id, u]));

  const products = await getProducts();
  let priceDrops = 0, restocks = 0;

  for (const row of rows) {
    const product = products.find(p => p.id === row.product_id);
    const user = userById[row.user_id];
    if (!product || !user || !user.email) continue;

    // Back-in-stock: only a real 0 → >0 transition counts, never an
    // already-in-stock item that just moved between two positive numbers.
    if (row.last_known_stock === 0 && product.stock > 0) {
      await sendEmail({
        to: user.email,
        subject: `${product.name} is back in stock!`,
        html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
          <h2 style="color:#7A1F2B;">Good news, ${user.name || 'there'}!</h2>
          <p><strong>${product.name}</strong> is back in stock — only ${product.stock} left.</p>
          <p><a href="${SITE_URL}/product?id=${product.id}" style="color:#7A1F2B;">View it in your wishlist</a></p>
        </div>`,
        userId: row.user_id
      });
      restocks++;
    }
    if (product.stock !== row.last_known_stock) {
      must(await supabase.from('wishlist_items').update({ last_known_stock: product.stock }).eq('user_id', row.user_id).eq('product_id', row.product_id), 'checkWishlistAlerts:updateStock');
    }

    // Price drop: compare against the price the customer saw when they
    // wishlisted it, not the last-checked price, so a slow multi-step
    // markdown still counts as "dropped since you saved it."
    const priceAtAdd = row.price_at_add != null ? row.price_at_add : product.price;
    if (product.price < priceAtAdd && !row.notified_price_drop) {
      await sendEmail({
        to: user.email,
        subject: `Price drop on ${product.name}`,
        html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
          <h2 style="color:#7A1F2B;">Price drop, ${user.name || 'there'}!</h2>
          <p><strong>${product.name}</strong> just dropped from ₹${priceAtAdd} to <strong>₹${product.price}</strong>.</p>
          <p><a href="${SITE_URL}/product?id=${product.id}" style="color:#7A1F2B;">View it in your wishlist</a></p>
        </div>`,
        userId: row.user_id
      });
      must(await supabase.from('wishlist_items').update({ notified_price_drop: true }).eq('user_id', row.user_id).eq('product_id', row.product_id), 'checkWishlistAlerts:markPriceDrop');
      priceDrops++;
    } else if (product.price >= priceAtAdd && row.notified_price_drop) {
      // Price recovered — allow a future real drop to alert again.
      must(await supabase.from('wishlist_items').update({ notified_price_drop: false }).eq('user_id', row.user_id).eq('product_id', row.product_id), 'checkWishlistAlerts:resetPriceDrop');
    }
  }

  return { checked: rows.length, priceDrops, restocks };
}

module.exports = { checkWishlistAlerts };
