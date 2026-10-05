// "Price these items for me" - used by Buy Now, where the customer checks out one saree directly and the bag is not
// involved at all. Works for guests and logged-in customers; nothing here changes any stored data.
const express = require('express');
const { getProductsByIds, getVariantsByIds, getPrimaryImagesByVariantIds } = require('../utils/db');
const { getUserIdIfPresent } = require('../middleware/auth');
const { resolveCoupon, computeOrderTotals } = require('../utils/pricing');

const router = express.Router();

const MAX_LINES = 20;

function cleanItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_LINES)
    .filter(i => i && Number.isInteger(Number(i.productId)) && Number(i.productId) > 0 && Number(i.qty) > 0)
    .map(i => ({
      product_id: Number(i.productId),
      variant_id: i.variantId && Number.isInteger(Number(i.variantId)) ? Number(i.variantId) : null,
      qty: Math.min(99, Math.max(1, Math.floor(Number(i.qty))))
    }));
}

router.post('/quote', async (req, res) => {
  try {
    const items = cleanItems(req.body && req.body.items);
    if (!items.length) return res.status(400).json({ message: 'Nothing to buy — choose a saree first.' });

    const [products, variants, photoByVariant] = await Promise.all([
      getProductsByIds(items.map(i => i.product_id)),
      getVariantsByIds(items.map(i => i.variant_id).filter(Boolean)),
      getPrimaryImagesByVariantIds(items.map(i => i.variant_id).filter(Boolean))
    ]);
    const productById = new Map(products.map(p => [p.id, p]));
    const variantById = new Map(variants.map(v => [v.id, v]));

    const lines = [];
    for (const item of items) {
      const product = productById.get(item.product_id);
      if (!product || product.status === 'archived') return res.status(404).json({ message: 'This saree is no longer available.' });
      const variant = item.variant_id ? variantById.get(item.variant_id) : null;
      if (item.variant_id && (!variant || variant.product_id !== product.id)) return res.status(404).json({ message: 'This colour is no longer available.' });
      const stock = variant ? variant.stock : product.stock;
      if (stock <= 0) return res.status(409).json({ message: `"${product.name}"${variant ? ' in ' + variant.color_name : ''} is out of stock right now.` });
      if (stock < item.qty) return res.status(409).json({ message: `Only ${stock} left of "${product.name}"${variant ? ' in ' + variant.color_name : ''}.`, available: stock });
      const price = variant ? variant.price : product.price;
      lines.push({
        id: `${item.product_id}:${item.variant_id || 'default'}`,
        productId: item.product_id,
        variantId: item.variant_id,
        color: variant ? variant.swatch : product.swatch,
        colorName: variant ? variant.color_name : product.swatch,
        qty: item.qty,
        imageUrl: (item.variant_id && photoByVariant[item.variant_id]) || null,
        product: {
          id: product.id, name: product.name, fabric: product.fabric, occasion: product.occasion,
          price, mrp: variant ? variant.mrp : product.mrp, badge: product.badge, swatch: variant ? variant.swatch : product.swatch, stock
        }
      });
    }

    const subtotal = lines.reduce((sum, l) => sum + l.product.price * l.qty, 0);
    const userId = await getUserIdIfPresent(req);
    const requestedCode = req.body && typeof req.body.couponCode === 'string' ? req.body.couponCode.trim().slice(0, 40) : '';
    const { code, discount, error } = requestedCode ? await resolveCoupon(requestedCode, subtotal, userId) : { code: null, discount: 0 };
    const totals = await computeOrderTotals(subtotal, discount);

    res.json({ items: lines, subtotal, discount, ...totals, coupon: code, couponError: requestedCode && !code ? (error || 'That promo code is not valid.') : null });
  } catch (err) {
    console.error('POST /checkout/quote failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
