// Cost price, Final CP, selling price and net profit.
//
//   Final CP       = (buying price + shipping) + GST on that            e.g. (3,000 + 79) + 5%  = 3,232.95
//   margin         = 70% if Final CP is up to the threshold, else 50%   (all four numbers are editable in Admin -> Settings)
//   Final selling  = Final CP + margin on the Final CP                  e.g. 3,232.95 + 70%     = 5,496
//
// The selling price is a whole rupee (that is what the shop stores and shows); Final CP keeps its paise.
// Net profit comes from what was really sold: what customers paid minus what the sarees cost (the Final CP saved on each
// order line when it was placed), minus refunds, minus the payment gateway fee when one is entered in Settings.
const { supabase, must, fetchAllRows, fetchAllByIds, getSetting } = require('./db');

const DEFAULTS = { gstRate: 5, shippingCost: 79, marginThreshold: 10000, marginAbove: 50, marginAtOrBelow: 70, gatewayFeePct: 0 };
const MAX_COST = 10000000;

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function getProfitSettings() {
  const raw = await getSetting('profit_settings', null);
  const s = normalizeSettings(raw);
  // Until the numbers have been saved once, the shipping cost starts at the shipping fee the store already charges.
  if (!raw || raw.shippingCost === undefined) {
    const ship = await getSetting('shipping_settings', null);
    if (ship && Number.isFinite(Number(ship.fee))) s.shippingCost = Number(ship.fee);
  }
  return s;
}

function normalizeSettings(raw) {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const n = raw && raw[k] !== undefined && raw[k] !== null && raw[k] !== '' ? Number(raw[k]) : NaN;
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

// Checks what the admin typed in Settings. Returns { error } or { value }.
function validateSettings(body) {
  const b = body || {};
  const num = (key, label, { min = 0, max, gt } = {}) => {
    const v = b[key];
    if (v === undefined || v === null || String(v).trim() === '') return { error: `${label} is required.` };
    const n = Number(v);
    if (!Number.isFinite(n)) return { error: `${label} must be a number.` };
    if (gt !== undefined ? n <= gt : n < min) return { error: gt !== undefined ? `${label} must be more than ${gt}.` : `${label} cannot be less than ${min}.` };
    if (max !== undefined && n > max) return { error: `${label} cannot be more than ${max}.` };
    return { n };
  };
  const checks = [
    ['gstRate', 'GST on product', { min: 0, max: 100 }],
    ['shippingCost', 'Shipping cost', { min: 0, max: 100000 }],
    ['marginThreshold', 'The cost limit between the two margins', { gt: 0, max: MAX_COST }],
    ['marginAbove', 'Margin for sarees above the limit', { min: 0, max: 1000 }],
    ['marginAtOrBelow', 'Margin for sarees up to the limit', { min: 0, max: 1000 }],
    ['gatewayFeePct', 'Payment gateway fee', { min: 0, max: 20 }]
  ];
  const value = {};
  for (const [key, label, opts] of checks) {
    const r = num(key, label, opts);
    if (r.error) return { error: r.error };
    value[key] = round2(r.n);
  }
  return { value };
}

// Buying price in, everything the product form shows out. `s` = profit settings.
function computePricing(buyingPrice, s) {
  const cost = Number(buyingPrice);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const baseCents = Math.round(cost * 100) + Math.round(s.shippingCost * 100);
  const gstCents = Math.round(baseCents * s.gstRate / 100);
  const finalCp = (baseCents + gstCents) / 100;
  const marginPct = finalCp > s.marginThreshold ? s.marginAbove : s.marginAtOrBelow;
  const sellingPrice = Math.max(1, Math.round(finalCp * (1 + marginPct / 100)));
  return {
    buyingPrice: round2(cost), shipping: round2(s.shippingCost), gstRate: s.gstRate, gstAmount: gstCents / 100,
    finalCp: round2(finalCp), marginPct, sellingPrice, profitPerPiece: round2(sellingPrice - finalCp)
  };
}

// What to save on a colour when its buying price is typed (the columns the migration added).
function variantCostColumns(pricing) {
  return pricing
    ? { cost_price: pricing.buyingPrice, final_cp: pricing.finalCp, margin_pct: pricing.marginPct }
    : { cost_price: null, final_cp: null, margin_pct: null };
}

// "" / null / undefined -> no buying price given. Returns { empty } | { error } | { cost }.
function parseBuyingPrice(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { empty: true };
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_COST) return { error: 'Buying price must be a number above 0 (up to 1,00,00,000), for example 3000 or 3250.50.' };
  return { cost: round2(n) };
}

// ---------------------------------------------------------------------------------------------------------------
// The profit report. `data` is plain rows so the arithmetic can be tested without a database:
//   orders [{ id, total, subtotal, discount, shipping_fee, razorpay_payment_id, placed_at }]   (not cancelled)
//   items  [{ id, order_id, product_id, variant_id, name, qty, price, unit_cost }]
//   variantCost { [variantId]: current final_cp }   (used only for lines saved before costs were tracked)
//   refunds [{ id, order_id, amount }]  returnItems [{ return_id, order_item_id, qty }]  restocked { [returnId]: { [variantId]: qty } }
// ---------------------------------------------------------------------------------------------------------------
function buildProfitReport(data, settings) {
  const itemsByOrder = {};
  data.items.forEach(i => (itemsByOrder[i.order_id] || (itemsByOrder[i.order_id] = [])).push(i));
  const refundsByOrder = {};
  (data.refunds || []).forEach(r => (refundsByOrder[r.order_id] || (refundsByOrder[r.order_id] = [])).push(r));
  const returnItemsByReturn = {};
  (data.returnItems || []).forEach(r => (returnItemsByReturn[r.return_id] || (returnItemsByReturn[r.return_id] = [])).push(r));
  const itemById = {};
  data.items.forEach(i => { itemById[i.id] = i; });

  const t = { revenue: 0, shippingCollected: 0, discounts: 0, refunds: 0, cost: 0, restockedCost: 0, gatewayFees: 0 };
  let allRevenue = 0, counted = 0, notCounted = 0, notCountedRevenue = 0, estimatedLines = 0;
  const byProduct = new Map();

  for (const o of data.orders) {
    allRevenue += o.total;
    const lines = itemsByOrder[o.id] || [];
    const unitOf = li => (li.unit_cost !== null && li.unit_cost !== undefined ? Number(li.unit_cost)
      : (li.variant_id && data.variantCost && data.variantCost[li.variant_id] != null ? Number(data.variantCost[li.variant_id]) : null));
    if (!lines.length || lines.some(li => unitOf(li) === null)) { notCounted++; notCountedRevenue += o.total; continue; }
    counted++;

    let cost = 0;
    for (const li of lines) {
      const unit = unitOf(li);
      if (li.unit_cost === null || li.unit_cost === undefined) estimatedLines++;
      cost += unit * li.qty;
      const key = li.product_id == null ? 'ig:' + li.name : 'p:' + li.product_id;
      const row = byProduct.get(key) || { productId: li.product_id, name: li.name, units: 0, sales: 0, cost: 0 };
      row.units += li.qty; row.sales += li.price * li.qty; row.cost += unit * li.qty;
      byProduct.set(key, row);
    }
    let refunded = 0, restockedCost = 0;
    for (const rf of refundsByOrder[o.id] || []) {
      refunded += rf.amount;
      for (const ri of returnItemsByReturn[rf.id] || []) {
        const li = itemById[ri.order_item_id];
        if (!li) continue;
        const back = ((data.restocked || {})[rf.id] || {})[li.variant_id] || 0;   // pieces that really went back on the shelf
        restockedCost += unitOf(li) * Math.min(ri.qty, back);
      }
    }
    const fee = o.razorpay_payment_id ? round2(o.total * (settings.gatewayFeePct || 0) / 100) : 0;
    t.revenue += o.total; t.shippingCollected += o.shipping_fee || 0; t.discounts += o.discount || 0;
    t.refunds += refunded; t.cost += cost; t.restockedCost += restockedCost; t.gatewayFees += fee;
  }

  const netCost = t.cost - t.restockedCost;
  const netRevenue = t.revenue - t.refunds;
  const netProfit = netRevenue - netCost - t.gatewayFees;
  const products = [...byProduct.values()].map(r => ({ ...r, sales: round2(r.sales), cost: round2(r.cost), profit: round2(r.sales - r.cost) }))
    .sort((a, b) => b.profit - a.profit);
  return {
    orders: { total: data.orders.length, counted, notCounted, estimatedLines },
    allRevenue: round2(allRevenue),
    notCountedRevenue: round2(notCountedRevenue),
    revenue: round2(t.revenue),
    shippingCollected: round2(t.shippingCollected),
    discounts: round2(t.discounts),
    refunds: round2(t.refunds),
    cost: round2(t.cost),
    restockedCost: round2(t.restockedCost),
    netCost: round2(netCost),
    gatewayFees: round2(t.gatewayFees),
    netRevenue: round2(netRevenue),
    netProfit: round2(netProfit),
    marginPct: netRevenue > 0 ? round2(netProfit / netRevenue * 100) : 0,
    avgProfitPerOrder: counted ? round2(netProfit / counted) : 0,
    topProducts: products.slice(0, 10),
    lossMakers: products.filter(p => p.profit < 0).slice(0, 5)
  };
}

function rangeStart(range, now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  if (range === 'today') return d;
  if (range === '7') { d.setDate(d.getDate() - 6); return d; }
  if (range === '30') { d.setDate(d.getDate() - 29); return d; }
  if (range === 'month') { d.setDate(1); return d; }
  return null;   // all time
}

async function loadProfitReport(range) {
  const settings = await getProfitSettings();
  const from = rangeStart(range);
  const orders = await fetchAllRows(() => {
    let q = supabase.from('orders').select('id, total, subtotal, discount, shipping_fee, razorpay_payment_id, placed_at').is('cancelled_at', null).order('id');
    if (from) q = q.gte('placed_at', from.toISOString());
    return q;
  }, 'profit:orders');
  const ids = orders.map(o => o.id);
  const items = ids.length ? await fetchAllByIds(ids, c => supabase.from('order_items').select('id, order_id, product_id, variant_id, name, qty, price, unit_cost').in('order_id', c).order('id'), 'profit:items') : [];
  const variantIds = [...new Set(items.filter(i => i.unit_cost === null && i.variant_id).map(i => i.variant_id))];
  const variantCost = {};
  if (variantIds.length) {
    (await fetchAllByIds(variantIds, c => supabase.from('product_variants').select('id, final_cp').in('id', c).order('id'), 'profit:variants'))
      .forEach(v => { if (v.final_cp !== null) variantCost[v.id] = v.final_cp; });
  }
  const returns = ids.length ? await fetchAllByIds(ids, c => supabase.from('return_requests').select('id, order_id, status, final_refund_amount, computed_refund_amount').eq('status', 'Refunded').in('order_id', c).order('id'), 'profit:returns') : [];
  const refunds = returns.map(r => ({ id: r.id, order_id: r.order_id, amount: Number(r.final_refund_amount ?? r.computed_refund_amount ?? 0) }));
  const returnItems = refunds.length ? await fetchAllByIds(refunds.map(r => r.id), c => supabase.from('return_request_items').select('return_id, order_item_id, qty').in('return_id', c).order('id'), 'profit:returnItems') : [];
  const restocked = {};
  if (refunds.length) {
    const hist = await fetchAllByIds(refunds.map(r => 'Return #' + r.id + ' received'), c => supabase.from('inventory_history').select('variant_id, change, reason').in('reason', c).order('id'), 'profit:restocked');
    hist.forEach(h => {
      const id = Number(/^Return #(\d+) received$/.exec(h.reason)[1]);
      ((restocked[id] || (restocked[id] = {}))[h.variant_id] = (restocked[id][h.variant_id] || 0) + h.change);
    });
  }
  const report = buildProfitReport({ orders, items, variantCost, refunds, returnItems, restocked }, settings);
  return { range: range || 'all', from: from ? from.toISOString() : null, settings, ...report };
}

module.exports = { DEFAULTS, getProfitSettings, normalizeSettings, validateSettings, computePricing, variantCostColumns, parseBuyingPrice, buildProfitReport, loadProfitReport, rangeStart, round2 };
