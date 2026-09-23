const express = require('express');
const { supabase, must, getProducts, getVariantById, getDefaultVariant, getVariants } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { resolveCoupon, computeOrderTotals } = require('../utils/pricing');

const router = express.Router();
router.use(requireAuth);

// A cart line is always keyed to one real variant now. Callers that still pass
// a bare `color` string (older client code, or a guest-cart merge from before
// this change) get matched against that product's variants by swatch/color
// name; anything unresolved falls back to the product's default variant.
async function resolveVariantId(productId, variantId, color) {
  if (variantId) return Number(variantId);
  if (color) {
    const variants = await getVariants(Number(productId));
    const match = variants.find(v => v.swatch === color || v.color_name.toLowerCase() === String(color).toLowerCase());
    if (match) return match.id;
  }
  const def = await getDefaultVariant(Number(productId));
  return def ? def.id : null;
}

async function withProductDetails(items) {
  const products = await getProducts();
  return Promise.all(items.map(async item => {
    const product = products.find(p => p.id === item.product_id);
    const variant = item.variant_id ? await getVariantById(item.variant_id) : null;
    return {
      id: item.id,
      productId: item.product_id,
      variantId: item.variant_id || null,
      color: variant ? variant.swatch : item.color,
      colorName: variant ? variant.color_name : item.color,
      qty: item.qty,
      product: (product && variant) ? {
        id: product.id, name: product.name, fabric: product.fabric, occasion: product.occasion,
        price: variant.price, mrp: variant.mrp, rating: product.rating, reviews: product.reviews_count,
        badge: product.badge, swatch: variant.swatch, desc: variant.description || product.description, stock: variant.stock
      } : (product || null)
    };
  }));
}

async function cartResponse(userId) {
  const rawItems = must(await supabase.from('cart_items').select('*').eq('user_id', userId), 'cartResponse:items');
  const items = await withProductDetails(rawItems);
  const subtotal = items.reduce((s, i) => s + (i.product ? i.product.price * i.qty : 0), 0);
  const meta = must(await supabase.from('cart_meta').select('coupon_code').eq('user_id', userId).maybeSingle(), 'cartResponse:meta');
  const { code, discount } = await resolveCoupon(meta && meta.coupon_code, subtotal, userId);

  // Coupon fell out of eligibility (e.g. items removed) — drop it silently.
  if (meta && meta.coupon_code && !code) {
    must(await supabase.from('cart_meta').delete().eq('user_id', userId), 'cartResponse:dropCoupon');
  }

  const { shippingFee, taxAmount, taxRate, taxLabel, total } = await computeOrderTotals(subtotal, discount);
  return { items, subtotal, discount, shippingFee, taxAmount, taxRate, taxLabel, total, coupon: code };
}

router.get('/', async (req, res) => {
  try {
    res.json(await cartResponse(req.userId));
  } catch (err) {
    console.error('GET /cart failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// Abandoned-cart recovery (backend/utils/abandonedCart.js) needs to know when
// a cart last changed — every mutation stamps updated_at, and clears any
// prior "we already emailed about this abandonment" flag so a customer who
// comes back, adds more, then abandons again can be emailed again.
async function touchCartMeta(userId) {
  must(await supabase.from('cart_meta').upsert({ user_id: userId, recovery_email_sent_at: null }, { onConflict: 'user_id' }), 'touchCartMeta');
}

// The one place a cart line's quantity is ever allowed to increase — clamps
// to the variant's real current stock (checkout re-validates against fresh
// stock too, but a cart that already shows more than exists is a confusing,
// avoidable lie: "Only 10 left" right next to a quantity of 22 came from
// here never checking stock at all).
async function addItem(userId, { productId, qty, color, variantId }) {
  if (!productId) return { error: null };
  const resolvedVariantId = await resolveVariantId(productId, variantId, color);
  // A productId/variantId that doesn't match anything real (a stale link, a
  // deleted product, someone poking at the request) used to return success
  // here and add nothing, with no way for the caller to tell. POST /cart below
  // now surfaces this as a real error; POST /cart/merge (folding a guest's
  // localStorage cart in on login) never inspects .error, so a stale merge
  // item is still skipped exactly as quietly as before — this only changes
  // what a direct "add to bag" click sees.
  if (!resolvedVariantId) return { error: 'This saree could not be found.' };
  const variant = await getVariantById(resolvedVariantId);
  if (!variant) return { error: 'This saree could not be found.' };

  const lineId = `${userId}:${resolvedVariantId}`;
  const now = new Date().toISOString();
  const existing = must(await supabase.from('cart_items').select('*').eq('id', lineId).maybeSingle(), 'addItem:lookup');
  const requested = (existing ? existing.qty : 0) + (Number(qty) || 1);
  const finalQty = Math.min(requested, variant.stock);

  if (finalQty <= 0) {
    return { error: 'This colour is out of stock.' };
  }
  if (existing) {
    must(await supabase.from('cart_items').update({ qty: finalQty, updated_at: now }).eq('id', lineId), 'addItem:update');
  } else {
    must(await supabase.from('cart_items').insert({
      id: lineId, user_id: userId, product_id: Number(productId), variant_id: resolvedVariantId,
      color: color || 'default', qty: finalQty, updated_at: now
    }), 'addItem:insert');
  }
  await touchCartMeta(userId);
  return { error: null, clamped: finalQty < requested, available: variant.stock };
}

router.post('/', async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ message: 'productId is required.' });
    const result = await addItem(req.userId, req.body);
    if (result.error) return res.status(400).json({ message: result.error });
    const response = await cartResponse(req.userId);
    if (result.clamped) response.message = `Only ${result.available} left in stock — added the most we have.`;
    res.status(201).json(response);
  } catch (err) {
    console.error('POST /cart failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// Folds a guest's localStorage cart into the now-logged-in user's server cart.
router.post('/merge', async (req, res) => {
  try {
    const { items } = req.body;
    if (Array.isArray(items)) {
      for (const item of items) await addItem(req.userId, item);
    }
    res.json(await cartResponse(req.userId));
  } catch (err) {
    console.error('POST /cart/merge failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.put('/:itemId', async (req, res) => {
  try {
    const { qty } = req.body;
    const line = must(await supabase.from('cart_items').select('*').eq('id', req.params.itemId).eq('user_id', req.userId).maybeSingle(), 'putItem:lookup');
    if (!line) return res.status(404).json({ message: 'Cart item not found.' });

    const variant = line.variant_id ? await getVariantById(line.variant_id) : null;
    const requested = Math.max(1, Number(qty) || 1);
    if (variant && variant.stock <= 0) {
      return res.status(400).json({ message: 'This colour just sold out — remove it from your bag to check out.' });
    }
    const finalQty = variant ? Math.min(requested, variant.stock) : requested;

    must(await supabase.from('cart_items').update({ qty: finalQty, updated_at: new Date().toISOString() }).eq('id', req.params.itemId), 'putItem:update');
    await touchCartMeta(req.userId);
    const response = await cartResponse(req.userId);
    if (finalQty < requested) response.message = `Only ${variant.stock} left in stock — set to the max available.`;
    res.json(response);
  } catch (err) {
    console.error('PUT /cart/:itemId failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.delete('/coupon', async (req, res) => {
  try {
    must(await supabase.from('cart_meta').delete().eq('user_id', req.userId), 'deleteCoupon');
    res.json(await cartResponse(req.userId));
  } catch (err) {
    console.error('DELETE /cart/coupon failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.delete('/:itemId', async (req, res) => {
  try {
    must(await supabase.from('cart_items').delete().eq('id', req.params.itemId).eq('user_id', req.userId), 'deleteItem');
    res.json(await cartResponse(req.userId));
  } catch (err) {
    console.error('DELETE /cart/:itemId failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.delete('/', async (req, res) => {
  try {
    must(await supabase.from('cart_items').delete().eq('user_id', req.userId), 'clearCart:items');
    must(await supabase.from('cart_meta').delete().eq('user_id', req.userId), 'clearCart:meta');
    res.json(await cartResponse(req.userId));
  } catch (err) {
    console.error('DELETE /cart failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/coupon', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: 'Enter a promo code.' });

    const current = await cartResponse(req.userId);
    const { code: validCode, discount, error } = await resolveCoupon(code, current.subtotal, req.userId);
    if (!validCode) return res.status(400).json({ message: error || 'That promo code is not valid.' });

    must(await supabase.from('cart_meta').upsert({ user_id: req.userId, coupon_code: validCode }, { onConflict: 'user_id' }), 'applyCoupon');

    res.json(await cartResponse(req.userId));
  } catch (err) {
    console.error('POST /cart/coupon failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
