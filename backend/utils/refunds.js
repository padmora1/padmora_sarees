// Money handed back to customers for RETURNED sarees (a return whose status is "Refunded"), worked out per order.
// It is the same amount the profit report already subtracts (the final refund, else the computed one), so Total Revenue,
// Net Profit and the Orders screen all tally. A cancelled order is a different thing (the whole order disappears from the
// figures); this is only for orders that stayed and had a return refunded.
const { supabase, fetchAllRows, fetchAllByIds } = require('./db');

// orderIds omitted = every order. Returns { [orderId]: { amount, returnedUnits, returns: [{ id, amount, refundedAt, method }] } }
async function loadRefundsByOrder(orderIds) {
  const cols = 'id, order_id, final_refund_amount, computed_refund_amount, refunded_at, refund_method, coupon_code';
  let rows;
  if (orderIds) {
    if (!orderIds.length) return {};
    rows = await fetchAllByIds(orderIds, c => supabase.from('return_requests').select(cols).eq('status', 'Refunded').in('order_id', c).order('id'), 'refunds:returns');
  } else {
    rows = await fetchAllRows(() => supabase.from('return_requests').select(cols).eq('status', 'Refunded').order('id'), 'refunds:returns');
  }
  if (!rows.length) return {};
  const items = await fetchAllByIds(rows.map(r => r.id), c => supabase.from('return_request_items').select('return_id, qty').in('return_id', c).order('id'), 'refunds:items');
  const unitsByReturn = {};
  items.forEach(i => { unitsByReturn[i.return_id] = (unitsByReturn[i.return_id] || 0) + Number(i.qty || 0); });
  const out = {};
  for (const r of rows) {
    const amount = Number(r.final_refund_amount ?? r.computed_refund_amount ?? 0);
    const o = out[r.order_id] || (out[r.order_id] = { amount: 0, returnedUnits: 0, returns: [] });
    o.amount += amount;
    o.returnedUnits += unitsByReturn[r.id] || 0;
    o.returns.push({ id: r.id, amount, refundedAt: r.refunded_at, method: r.refund_method, couponCode: r.refund_method === 'store_credit' ? r.coupon_code : null });
  }
  return out;
}

module.exports = { loadRefundsByOrder };
