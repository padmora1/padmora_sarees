// Post-delivery returns & refunds — shared logic used by both the customer
// route (backend/routes/returns.js) and the admin route (backend/routes/admin.js),
// so eligibility and refund math can never drift between what a customer is
// shown and what admin actually processes.
const { getSetting } = require('./db');

// Every reason falls into one of two buckets, because that's what actually
// decides whether shipping gets refunded (see computeReturnRefund below):
// it was our fault (wrong/damaged/misdescribed item — the store owns the
// cost of that mistake) or the customer's preference (still a completely
// legitimate return, just one where the customer already got the benefit
// of delivery).
const RETURN_REASONS = [
  { key: 'wrong_item', label: 'Received the wrong saree', category: 'seller_fault' },
  { key: 'damaged', label: 'Arrived damaged or defective', category: 'seller_fault' },
  { key: 'not_as_described', label: "Significantly different from the photos/description", category: 'seller_fault' },
  { key: 'quality_issue', label: "Quality isn't what I expected for a handloom piece", category: 'seller_fault' },
  { key: 'color_mismatch', label: 'Colour looks different in person', category: 'customer_preference' },
  { key: 'wrong_choice', label: 'Ordered the wrong colour/fabric by mistake', category: 'customer_preference' },
  { key: 'changed_mind', label: 'Changed my mind', category: 'customer_preference' },
  { key: 'other', label: 'Other', category: 'customer_preference' }
];

const REASON_MAP = new Map(RETURN_REASONS.map(r => [r.key, r]));

function categoryForReason(reasonKey) {
  const r = REASON_MAP.get(reasonKey);
  return r ? r.category : 'customer_preference';
}

async function getReturnPolicy() {
  return getSetting('return_policy', { enabled: true, windowDays: 7 });
}

// Is this order (already known to be Delivered) still inside the return
// window? Pure function of delivered_at + the admin-configured window, so
// changing the policy in Settings takes effect immediately, exactly like
// every other business rule in this app (shipping fee, tax rate, tracking
// timing).
async function isWithinReturnWindow(order) {
  const policy = await getReturnPolicy();
  if (!policy.enabled) return false;
  if (!order.delivered_at) return false;
  const daysSince = (Date.now() - new Date(order.delivered_at).getTime()) / 86400000;
  return daysSince <= policy.windowDays;
}

// Refund = what the customer actually paid for the returned lines (their
// share of the discount is given back proportionally too — never refund
// more than they paid), plus their proportional share of tax, plus the
// full shipping fee ONLY when every line in the order is being returned
// AND the return is our fault. A customer who simply changed their mind
// already received the benefit of shipping; a customer who got the wrong
// or a damaged saree did not, and shouldn't be out that money on top of it.
function computeReturnRefund(order, returnedLines, allItemsReturned, reasonCategory) {
  const itemsValue = returnedLines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const proportion = order.subtotal > 0 ? itemsValue / order.subtotal : 0;
  const discountShare = Math.round((order.discount || 0) * proportion);
  const taxShare = Math.round((order.tax_amount || 0) * proportion);
  let refund = itemsValue - discountShare + taxShare;
  if (reasonCategory === 'seller_fault' && allItemsReturned) {
    refund += Math.round(order.shipping_fee || 0);
  }
  return Math.max(0, refund);
}

// A saree with tags cut or visibly worn can't go back on the shelf even
// though the money still gets refunded — restocking is a separate decision
// admin makes at the "received & inspected" step, always overridable, but
// this is a sane starting default so admin isn't choosing from a blank
// slate every time. Judged per reason, not just per category: a wrong-item
// mistake usually means the piece itself is untouched and perfectly
// resellable, while a damage/quality/mismatch claim means it needs a real
// look before it goes back on the shelf.
const NON_RESTOCK_REASONS = new Set(['damaged', 'quality_issue', 'not_as_described', 'other']);
function defaultRestockFor(reasonKey) {
  return !NON_RESTOCK_REASONS.has(reasonKey);
}

module.exports = {
  RETURN_REASONS, categoryForReason, getReturnPolicy, isWithinReturnWindow,
  computeReturnRefund, defaultRestockFor
};
