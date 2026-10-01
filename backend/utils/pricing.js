const { supabase, getSetting, must } = require('./db');

// Validates a coupon code against a subtotal (and, when known, the customer
// placing the order) and returns the computed discount. Shared by cart.js
// (preview) and orders.js (final, re-validated at checkout so a stale/expired
// code from the client can never be trusted blindly).
async function resolveCoupon(code, subtotal, userId) {
  if (!code) return { code: null, discount: 0 };

  const coupon = must(
    await supabase.from('coupons').select('*').eq('code', code.toUpperCase()).eq('active', true).maybeSingle(),
    'resolveCoupon'
  );
  if (!coupon) return { code: null, discount: 0, error: 'That promo code is not valid.' };
  if (subtotal < coupon.min_subtotal) {
    return { code: null, discount: 0, error: `Add ${coupon.min_subtotal} more to your bag to use ${coupon.code}.` };
  }

  const now = new Date();
  if (coupon.start_date && now < new Date(coupon.start_date)) {
    return { code: null, discount: 0, error: `${coupon.code} isn't active yet.` };
  }
  if (coupon.end_date && now > new Date(coupon.end_date)) {
    return { code: null, discount: 0, error: `${coupon.code} has expired.` };
  }
  if (coupon.usage_limit) {
    const count = (await supabase.from('coupon_usage').select('*', { count: 'exact', head: true }).eq('coupon_code', coupon.code)).count || 0;
    if (count >= coupon.usage_limit) {
      return { code: null, discount: 0, error: `${coupon.code} has reached its usage limit.` };
    }
  }
  if (userId && coupon.per_customer_limit) {
    const count = (await supabase.from('coupon_usage').select('*', { count: 'exact', head: true }).eq('coupon_code', coupon.code).eq('user_id', userId)).count || 0;
    if (count >= coupon.per_customer_limit) {
      return { code: null, discount: 0, error: `You've already used ${coupon.code} the maximum number of times.` };
    }
  }

  let discount = coupon.type === 'percent' ? Math.round(subtotal * (coupon.value / 100)) : coupon.value;
  if (coupon.max_discount) discount = Math.min(discount, coupon.max_discount);
  discount = Math.min(discount, subtotal);

  return { code: coupon.code, discount };
}

// Called once an order is actually placed (not on cart preview) so usage
// limits count real redemptions, not every time a shopper glances at their bag.
// NOTE: normal order placement already records this atomically inside the
// place_order() Postgres function (see orders.js) — this standalone version
// exists for any other path (e.g. admin manually recording a usage) that
// isn't going through that RPC.
async function recordCouponUsage(code, userId, orderId) {
  if (!code) return;
  must(
    await supabase.from('coupon_usage').insert({ coupon_code: code, user_id: userId, order_id: orderId, used_at: new Date().toISOString() }),
    'recordCouponUsage'
  );
}

// Single source of truth for shipping + tax math — used by both the cart
// preview (GET /cart) and the real order placement (POST /orders), so what
// a shopper sees in their bag is exactly what they're charged at checkout.
// Shipping is waived once the post-coupon amount clears the free-shipping
// threshold.
//
// Tax has two modes, set via tax_settings.inclusive (default true):
//   - Inclusive (default): the product price shown everywhere already
//     includes GST — taxAmount is the portion of taxableAmount that's GST,
//     back-calculated rather than added, so the checkout total never comes
//     out higher than the price the customer already saw on the product
//     page. Shown to the customer purely as a transparency breakdown.
//   - Exclusive (the old, pre-existing behaviour, still fully supported for
//     a store that needs to switch back): GST is computed on top of
//     taxableAmount and added into the total, same as before this change.
async function computeOrderTotals(subtotal, discount) {
  const shippingSettings = await getSetting('shipping_settings', { fee: 0, freeShippingThreshold: 0 });
  const taxSettings = await getSetting('tax_settings', { enabled: false, gstRate: 0, inclusive: true });

  const taxableAmount = Math.max(0, subtotal - discount);
  const shippingFee = taxableAmount >= (shippingSettings.freeShippingThreshold || 0) ? 0 : (shippingSettings.fee || 0);
  const taxRate = taxSettings.enabled ? (taxSettings.gstRate || 0) : 0;
  const inclusive = taxSettings.inclusive !== false; // defaults true when unset, e.g. a store that never touched this setting

  const taxAmount = inclusive
    ? Math.round(taxableAmount * (taxRate / (100 + taxRate)) || 0)
    : Math.round(taxableAmount * (taxRate / 100));
  const total = inclusive ? (taxableAmount + shippingFee) : (taxableAmount + shippingFee + taxAmount);

  return { shippingFee, taxAmount, taxRate, taxLabel: taxSettings.label || 'GST', taxInclusive: inclusive, total };
}

module.exports = { resolveCoupon, recordCouponUsage, computeOrderTotals };
