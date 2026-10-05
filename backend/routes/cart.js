const express = require('express');
const { supabase, must, getProductsByIds, getVariantsByIds, getDefaultVariant, getVariants, getPrimaryImagesByVariantIds } = require('../utils/db');
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
  // One query per table for the whole bag (run side by side), not the whole catalogue plus a query per line.
  const [products, variants, photoByVariant] = await Promise.all([
    getProductsByIds(items.map(i => i.product_id)),
    getVariantsByIds(items.map(i => i.variant_id).filter(Boolean)),
    getPrimaryImagesByVariantIds(items.map(i => i.variant_id).filter(Boolean))
  ]);
  const productById = new Map(products.map(p => [p.id, p]));
  const variantById = new Map(variants.map(v => [v.id, v]));
  return items.map(item => {
    const product = productById.get(item.product_id);
    const variant = item.variant_id ? variantById.get(item.variant_id) : null;
    return {
      id: item.id,
      productId: item.product_id,
      variantId: item.variant_id || null,
      color: variant ? variant.swatch : item.color,
      colorName: variant ? variant.color_name : item.color,
      qty: item.qty,
      imageUrl: (item.variant_id && photoByVariant[item.variant_id]) || null,
      product: (product && variant) ? {
        id: product.id, name: product.name, fabric: product.fabric, occasion: product.occasion,
        price: variant.price, mrp: variant.mrp, rating: product.rating, reviews: product.reviews_count,
        badge: product.badge, swatch: variant.swatch, desc: variant.description || product.description, stock: variant.stock
      } : (product || null)
    };
  });
}

async function cartResponse(userId) {
  const [itemsRes, metaRes] = await Promise.all([
    supabase.from('cart_items').select('*').eq('user_id', userId).order('variant_id', { ascending: true }),   // stable row order - without it Postgres reshuffles rows after an update
    supabase.from('cart_meta').select('coupon_code').eq('user_id', userId).maybeSingle()
  ]);
  const rawItems = must(itemsRes, 'cartResponse:items');
  const meta = must(metaRes, 'cartResponse:meta');
  const items = await withProductDetails(rawItems);
  const subtotal = items.reduce((s, i) => s + (i.product ? i.product.price * i.qty : 0), 0);
  const { code, discount } = await resolveCoupon(meta && meta.coupon_code, subtotal, userId);

  // Coupon fell out of eligibility (e.g. items removed) — drop it silently.
  if (meta && meta.coupon_code && !code) {
    must(await supabase.from('cart_meta').delete().eq('user_id', userId), 'cartResponse:dropCoupon');
  }

  const { shippingFee, taxAmount, taxRate, taxLabel, taxInclusive, total } = await computeOrderTotals(subtotal, discount);
  return { items, subtotal, discount, shippingFee, taxAmount, taxRate, taxLabel, taxInclusive, total, coupon: code };
}

// Just the number for the header badge - no pricing, no product details.
router.get('/count', async (req, res) => {
  try {
    const rows = must(await supabase.from('cart_items').select('qty').eq('user_id', req.userId), 'cartCount');
    res.json({ count: rows.reduce((sum, r) => sum + (r.qty || 0), 0) });
  } catch (err) {
    console.error('GET /cart/count failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

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
  const lineId = `${userId}:${resolvedVariantId}`;
  const now = new Date().toISOString();
  const [variantRes, existingRes] = await Promise.all([
    supabase.from('product_variants').select('id, stock').eq('id', resolvedVariantId).maybeSingle(),
    supabase.from('cart_items').select('*').eq('id', lineId).maybeSingle()
  ]);
  const variant = must(variantRes, 'addItem:variant');
  if (!variant) return { error: 'This saree could not be found.' };
  const existing = must(existingRes, 'addItem:lookup');
  const requested = (existing ? existing.qty : 0) + (Number(qty) || 1);
  const finalQty = Math.min(requested, variant.stock);

  if (finalQty <= 0) {
    return { error: 'This colour is out of stock.' };
  }
  const [writeRes, touchRes] = await Promise.all([
    existing
      ? supabase.from('cart_items').update({ qty: finalQty, updated_at: now }).eq('id', lineId)
      : supabase.from('cart_items').insert({
          id: lineId, user_id: userId, product_id: Number(productId), variant_id: resolvedVariantId,
          color: color || 'default', qty: finalQty, updated_at: now
        }),
    supabase.from('cart_meta').upsert({ user_id: userId, recovery_email_sent_at: null }, { onConflict: 'user_id' })
  ]);
  must(writeRes, existing ? 'addItem:update' : 'addItem:insert');
  must(touchRes, 'touchCartMeta');
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

    const variant = line.variant_id ? must(await supabase.from('product_variants').select('id, stock').eq('id', line.variant_id).maybeSingle(), 'putItem:variant') : null;
    const requested = Math.max(1, Number(qty) || 1);
    if (variant && variant.stock <= 0) {
      return res.status(400).json({ message: 'This colour just sold out — remove it from your bag to check out.' });
    }
    const finalQty = variant ? Math.min(requested, variant.stock) : requested;

    const [updRes, touchRes] = await Promise.all([
      supabase.from('cart_items').update({ qty: finalQty, updated_at: new Date().toISOString() }).eq('id', req.params.itemId),
      supabase.from('cart_meta').upsert({ user_id: req.userId, recovery_email_sent_at: null }, { onConflict: 'user_id' })
    ]);
    must(updRes, 'putItem:update');
    must(touchRes, 'touchCartMeta');
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
