const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const {
  supabase, must, fetchAllRows, fetchAllByIds, getProducts, getProductById, getVariantById, getPrimaryImagesByVariantIds, syncProductMirrorFromDefaultVariant, getSetting, setSetting,
  getFabrics, getOccasions, getBadges, getCollections, getCollectionProductIds, getReelItems, getFaqItems,
  ADMIN_ROLES, logActivity
} = require('../utils/db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');
const { computeStatus, buildTimeline, isCancellable, setOrderManualStatus, getTrackingMode, clearTrackingModeCache, STAGE_NAMES, CANCEL_REASONS } = require('../utils/orderStatus');
const { readOrderIds, buildTemplateXlsx, buildTemplateCsv, normalizeOrderId, MAX_IDS } = require('../utils/spreadsheet');
const { upload } = require('../middleware/upload');
const { saveUpload, removeUpload } = require('../utils/storage');
const { toProductApiShape } = require('../utils/shape');
const { DEFAULT_FOOTER, validateFooter } = require('../utils/footerConfig');
const { sanitizeRich } = require('../utils/richText');
const { splitOccasions, normalizeOccasions } = require('../utils/occasions');
const { DEFAULT_ANNOUNCEMENT, DEFAULT_WEAVE_SECTION, validateAnnouncement, validateWeaveSection } = require('../utils/homeSections');
const { runBackup, listBackups, BACKUP_DIR } = require('../utils/backup');
const { RETURN_REASONS, computeReturnRefund, getReturnPolicy } = require('../utils/returns');
const { inquiryLink } = require('../utils/inquiryToken');
const { sendEmail, sendOrderStatusEmail, emailConfigured, smsConfigured } = require('../utils/notify');
const reviewReminders = require('../utils/reviewReminders');
const { publicEmail } = require('../utils/instagramOrders');
const profit = require('../utils/profit');
const { loadRefundsByOrder } = require('../utils/refunds');
const razorpayUtil = require('../utils/razorpay');
const { MAX_ATTEMPTS: INQUIRY_MAX_ATTEMPTS, decisionEmail } = require('../utils/inquiry');
const { checkWishlistAlerts } = require('../utils/wishlistAlerts');
const { checkAbandonedCarts } = require('../utils/abandonedCart');
const { checkLowStock } = require('../utils/lowStockAlerts');
const { checkPrebookNotifications } = require('../utils/prebookAlerts');

const router = express.Router();
// Every /api/admin/* route now requires a genuine admin_users session (not a
// customer account with is_admin=1), and requirePermission enforces each
// role's scope server-side — a Catalog Manager's token really does get a 403
// from the Orders endpoints, not just a hidden nav link.
router.use(requireAdminAuth, requirePermission);

// Records who did what — surfaced in Admin → Activity Log. Call this from a
// route right after a mutation succeeds.
async function record(req, action, entity, entityId, before, after) {
  await logActivity({ adminId: req.adminId, adminName: req.adminName, action, entity, entityId, before, after });
}

// Admin -> Instagram Orders (upload a sheet of orders taken on Instagram). Its own file; same login and permission as above.
router.use('/instagram-orders', require('./adminInstagram')({ asyncRoute, record }));

// A Postgres unique_violation (23505) surfaces through must()'s wrapped
// error as err.cause.code — used everywhere the old SQLite code checked
// `e.message.includes('UNIQUE')`.
function isUniqueViolation(err) {
  return !!(err && err.cause && err.cause.code === '23505');
}

// Turns a multer failure (bad file type, file too large) into a clean 400
// with the real reason, instead of falling through to the generic 500 handler.
// Raw phone photos are 5-25MB; stored as-is they get served as-is to every
// shopper on the product page, which is what makes the site crawl. The admin
// page shrinks images in the browser before upload, so anything this big
// arriving means that step was skipped (old tab, another client) — refuse it
// with a clear reason instead of silently storing a page-weight bomb. Videos
// (reels) are exempt; they have their own larger cap in middleware/upload.js.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function uploadSingle(req, res, next) { return uploadChecked()(req, res, next); }

// `validate(req)` (optional, may be async) runs once the file is received and BEFORE it is stored; return a message to refuse it.
function uploadChecked(validate) {
  return (req, res, next) => upload.single('file')(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ message: tooBig ? 'That file is over 25MB. For a video (a reel or a product video), trim it to 8–15 seconds or export it at a lower quality, then upload it again.' : (err.message || 'Upload failed.') });
    }
    if (req.file && validate) {
      let why = null;
      try { why = await validate(req); } catch (e) { console.error('upload validation failed:', e); why = 'Could not check this file. Please try again.'; }
      if (why) return res.status(400).json({ message: why });
    }
    if (req.file && req.file.mimetype.startsWith('image/') && req.file.size > MAX_IMAGE_BYTES) {
      const mb = (req.file.size / 1024 / 1024).toFixed(1);
      return res.status(400).json({ message: `That photo is ${mb}MB — please use one under 8MB (a normal phone photo is fine; refresh the admin page so it can shrink photos automatically).` });
    }
    // Store the file permanently (Supabase Storage); routes save req.file.publicUrl in the database.
    if (req.file) {
      try { req.file.publicUrl = await saveUpload(req.file); }
      catch (e) {
        console.error('Upload could not be stored:', e);
        return res.status(502).json({ message: 'The file could not be saved. Please try again in a moment.' });
      }
    }
    next();
  });
}

// Swatch keys are typed by hand in the admin ("Maroon", " green "), but the
// storefront looks colours up by lowercase key — normalise on the way in so
// "Maroon" and "maroon" are one colour, not two filter entries.
function cleanSwatch(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
}

// Whole-number check for every money / quantity field an admin can type. Returns the number, or null when it
// isn't a whole number inside [min, max] (so "", "abc", 2.5, -3 and 99999999999 are all refused up front instead
// of being saved as nonsense or crashing the database with a 500).
const MAX_PRICE = 10000000;   // ₹1 crore
const MAX_STOCK = 1000000;
function wholeNumber(v, { min = 0, max = MAX_STOCK } = {}) {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
// Trims a text field; null when it is blank or longer than `max`.
function cleanText(v, max) {
  const t = typeof v === 'string' ? v.trim() : '';
  return t && t.length <= max ? t : null;
}

// Product codes (SKU) are made automatically so nobody has to invent them: PDM-<product id>-<COLOUR>, with -2, -3...
// added if the same colour name repeats on one product. An admin can still type their own code on a colour.
function skuCodeWord(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'COLOUR';
}
function uniqueSku(productId, colorName, taken) {
  const base = `PDM-${productId}-${skuCodeWord(colorName)}`;
  let sku = base, n = 2;
  while (taken.has(sku)) sku = `${base}-${n++}`;
  taken.add(sku);
  return sku;
}
async function takenSkus(productId) {
  const rows = must(await supabase.from('product_variants').select('sku').eq('product_id', productId), 'takenSkus');
  return new Set(rows.map(r => r.sku).filter(Boolean));
}

// The product as the admin list shows it (with its colour count and total stock).
function adminProductShape(row) {
  const p = toProductApiShape(row);
  // Buying price, Final CP and margin exist only in the admin view - the storefront shape never carries them.
  const raw = {};
  (row.variants || []).forEach(v => { raw[v.id] = v; });
  p.variants = p.variants.map(v => ({
    ...v,
    costPrice: raw[v.id] && raw[v.id].cost_price != null ? Number(raw[v.id].cost_price) : null,
    finalCp: raw[v.id] && raw[v.id].final_cp != null ? Number(raw[v.id].final_cp) : null,
    marginPct: raw[v.id] && raw[v.id].margin_pct != null ? Number(raw[v.id].margin_pct) : null,
    priceManual: !!(raw[v.id] && raw[v.id].price_manual)
  }));
  return { ...p, variantCount: p.variants.length, totalStock: p.variants.reduce((sum, v) => sum + v.stock, 0) };
}

// A colour's price when the admin types a BUYING PRICE: the shop works out Final CP, the selling price and the Final selling price
// (rounded to the nearest 10 rupees) from the Settings, so the price can never disagree with the cost. The admin may type a different
// Final selling price: it is accepted and remembered (price_manual) so later recalculations leave it alone.
// Without a buying price the colour is priced by hand exactly as before (and its profit is simply not tracked).
// `existing` = the colour's current row, when editing.
//  - costPrice given         -> recalculated from it; `price` (if different from the generated one) is the admin's own Final selling price
//                               (for a Sale saree that is the ACTUAL price, before the % off)
//  - costPrice "" / null     -> the buying price is removed; the typed price is used
//  - costPrice not sent      -> an already-costed colour keeps its cost and its actual price; only the sale % may change
async function priceForColour({ costPrice, price, mrp, salePercent, onSale, existing }) {
  const given = costPrice !== undefined;
  const parsed = given ? profit.parseBuyingPrice(costPrice) : { empty: true };
  if (parsed.error) return { error: parsed.error };
  if (given && !parsed.empty) {
    const pricing = profit.computePricing(parsed.cost, await profit.getProfitSettings());
    let actual = pricing.sellingPrice, manual = false;
    if (price !== undefined && price !== null && String(price).trim() !== '') {
      const typed = wholeNumber(price, { min: 1, max: MAX_PRICE });
      if (typed === null) return { error: 'Final selling price must be a whole number of rupees, for example 5530.' };
      if (typed !== pricing.sellingPrice) { actual = typed; manual = true; }
    }
    const prices = resolvePrices({ onSale, price: actual, salePercent });   // the old original price must not leak into the new one
    if (prices.error) return { error: prices.error };
    return { price: prices.price, mrp: prices.mrp, cols: profit.variantCostColumns(pricing, manual), pricing, manual };
  }
  if (!given && existing && existing.cost_price != null) {
    const actual = existing.mrp > existing.price ? existing.mrp : existing.price;
    const prices = resolvePrices({ onSale, price: actual, mrp: existing.mrp, salePercent });
    if (prices.error) return { error: prices.error };
    return { price: prices.price, mrp: prices.mrp, cols: {}, kept: true };
  }
  const prices = resolvePrices({ onSale, price, mrp, salePercent });
  if (prices.error) return { error: prices.error };
  return { price: prices.price, mrp: prices.mrp, cols: given ? profit.variantCostColumns(null) : {} };
}

// Pricing rule: only Sale sarees carry an original price and a discount.
//  - Normal saree: one price. `mrp` is kept equal to it, so nothing downstream can show a fake discount.
//  - Sale saree: the admin enters the ACTUAL price and a sale %; the selling price is worked out here
//    (rounded to the rupee) and the actual price is stored as `mrp` so the storefront can cross it out.
// A request from an older admin page (explicit selling price + original price, no percentage) is still
// honoured for sale sarees.
function resolvePrices({ onSale, price, mrp, salePercent }) {
  const actual = wholeNumber(price, { min: 1, max: MAX_PRICE });
  if (actual === null) return { error: 'Price must be a whole number of rupees, for example 2999 (up to 1,00,00,000).' };
  if (!onSale) return { price: actual, mrp: actual };
  if (salePercent !== undefined && salePercent !== null && salePercent !== '') {
    const pct = Number(salePercent);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 90) return { error: 'Enter a sale percentage between 1 and 90.' };
    return { price: Math.max(1, Math.round(actual * (100 - pct) / 100)), mrp: actual };
  }
  const original = Number(mrp);
  return Number.isFinite(original) && original >= actual ? { price: actual, mrp: original } : { price: actual, mrp: actual };
}

function asyncRoute(handler) {
  return (req, res) => handler(req, res).catch(err => {
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ message: err.publicMessage || 'Something went wrong on the server.' });
  });
}

// ---- Dashboard stats ----
router.get('/stats', asyncRoute(async (req, res) => {
  const orders = must(await supabase.from('orders').select('*'), 'stats:orders');
  const activeOrders = orders.filter(o => !o.cancelled_at);
  // Revenue is what the store actually kept: an order's total minus what was handed back for returns (the same refunds the
  // profit report subtracts), so Total Revenue and Net Profit move together when a return is refunded.
  const refunds = await loadRefundsByOrder();
  const netOf = o => o.total - ((refunds[o.id] && refunds[o.id].amount) || 0);
  const refundedTotal = activeOrders.reduce((s, o) => s + (refunds[o.id] ? refunds[o.id].amount : 0), 0);
  const revenue = activeOrders.reduce((s, o) => s + netOf(o), 0);
  const userCount = (await supabase.from('users').select('*', { count: 'exact', head: true }).eq('is_admin', false)).count || 0;

  // Low stock is variant-level now — "Green" can be down to its last piece
  // even while the product overall still shows stock in other colors.
  const variants = must(await supabase.from('product_variants').select('id, product_id, color_name, stock, low_stock_threshold').eq('archived', false), 'stats:variants');
  const lowVariants = variants.filter(v => v.stock <= v.low_stock_threshold).sort((a, b) => a.stock - b.stock);
  const productIdsForLowStock = [...new Set(lowVariants.map(v => v.product_id))];
  const productsForLowStock = productIdsForLowStock.length
    ? must(await supabase.from('products').select('id, name').in('id', productIdsForLowStock), 'stats:lowStockProducts')
    : [];
  const productNameById = Object.fromEntries(productsForLowStock.map(p => [p.id, p.name]));
  const lowStock = lowVariants.map(v => ({
    variantId: v.id, productId: v.product_id, name: `${productNameById[v.product_id] || ''} — ${v.color_name}`, stock: v.stock
  }));

  const unreadMessages = (await supabase.from('contact_messages').select('*', { count: 'exact', head: true }).eq('read', false)).count || 0;

  // Today, in the server's own local time zone — good enough for a
  // single-store dashboard, not trying to be multi-timezone-aware.
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayOrders = activeOrders.filter(o => new Date(o.placed_at) >= todayStart);
  const todayRevenue = todayOrders.reduce((s, o) => s + netOf(o), 0);
  const avgOrderValue = activeOrders.length ? Math.round(revenue / activeOrders.length) : 0;

  const guestUsers = must(await supabase.from('users').select('id').eq('is_guest', true), 'stats:guestUsers');
  const guestUserIds = guestUsers.map(u => u.id);
  const guestOrderCount = guestUserIds.length ? orders.filter(o => guestUserIds.includes(o.user_id)).length : 0;

  // "Abandoned" mirrors backend/utils/abandonedCart.js's own 3-hour idle
  // threshold, so this number means the same thing the background job acts on.
  const cartItems = must(await supabase.from('cart_items').select('user_id, updated_at'), 'stats:cartItems');
  const lastUpdatedByUser = {};
  cartItems.forEach(c => {
    if (!c.updated_at) return;
    if (!lastUpdatedByUser[c.user_id] || c.updated_at > lastUpdatedByUser[c.user_id]) lastUpdatedByUser[c.user_id] = c.updated_at;
  });
  const now = Date.now();
  const abandonedCarts = Object.values(lastUpdatedByUser).filter(t => now - new Date(t).getTime() >= 3 * 60 * 60 * 1000).length;

  const backups = listBackups();
  const lastBackupAt = backups.length ? backups[0].createdAt : null;

  res.json({
    stats: {
      totalOrders: activeOrders.length,
      cancelledOrders: orders.length - activeOrders.length,
      revenue,
      refundedTotal,
      userCount,
      unreadMessages,
      todayOrders: todayOrders.length,
      todayRevenue,
      avgOrderValue,
      guestOrderCount,
      abandonedCarts,
      lastBackupAt
    },
    lowStock
  });
}));

// ---- Products ----
router.get('/products', asyncRoute(async (req, res) => {
  res.json({ products: (await getProducts({ fresh: true })).map(adminProductShape) });
}));

router.get('/products/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const row = await getProductById(Number(req.params.id));
  if (!row) return res.status(404).json({ message: 'Product not found.' });
  res.json({ product: adminProductShape(row) });
}));

router.post('/products', asyncRoute(async (req, res) => {
  const { name: rawName, fabric: rawFabric, occasion: rawOccasion, price, mrp, salePercent, badge, swatch, desc, stock: rawStock, weaverName, weaverRegion, loomType,
          colorName: rawColor, lowStockThreshold: rawLow, colors, costPrice } = req.body;
  const name = cleanText(rawName, 120), fabric = cleanText(rawFabric, 80), occasion = normalizeOccasions(rawOccasion);
  const hasCost = costPrice !== undefined && costPrice !== null && String(costPrice).trim() !== '';
  if (!name || !fabric || !occasion || (!hasCost && (price === undefined || price === null || price === ''))) {
    return res.status(400).json({ message: 'Name, fabric, at least one occasion (up to 8) and the buying price are required (name up to 120 characters).' });
  }
  const onSale = badge === 'sale';
  // Stock left empty means "the usual 20"; a typed 0 is a real answer (sold out) and must be kept.
  const stock = (rawStock === undefined || rawStock === null || rawStock === '') ? 20 : wholeNumber(rawStock);
  if (stock === null) return res.status(400).json({ message: 'Stock must be a whole number, 0 or more.' });
  const low = (rawLow === undefined || rawLow === null || rawLow === '') ? 10 : wholeNumber(rawLow, { min: 0, max: 100000 });
  if (low === null) return res.status(400).json({ message: '"Low-stock alert" must be a whole number, 0 or more.' });
  const prices = await priceForColour({ costPrice, price, mrp, salePercent, onSale });
  if (prices.error) return res.status(400).json({ message: prices.error });
  const swatchKey = cleanSwatch(swatch) || 'maroon';
  // The first colour's name: what the admin typed, or (older pages) the shade word.
  const colorName = cleanText(rawColor, 60) || swatchKey.replace(/^\w/, c => c.toUpperCase());

  // Any extra colours sent along are checked up front, so a typo in the third colour never leaves a half-made product.
  const extras = [];
  if (colors !== undefined && colors !== null) {
    if (!Array.isArray(colors) || colors.length > 20) return res.status(400).json({ message: 'Add up to 20 extra colours.' });
    for (const [i, c] of colors.entries()) {
      const label = `Extra colour ${i + 1}`;
      const cName = cleanText(c && c.colorName, 60);
      if (!cName) return res.status(400).json({ message: `${label}: enter the colour name (up to 60 characters).` });
      const cPrices = await priceForColour({ costPrice: c.costPrice, price: c.price, mrp: c.mrp, salePercent: c.salePercent, onSale });
      if (cPrices.error) return res.status(400).json({ message: `${label}: ${cPrices.error}` });
      const cStock = (c.stock === undefined || c.stock === null || c.stock === '') ? 0 : wholeNumber(c.stock);
      if (cStock === null) return res.status(400).json({ message: `${label}: stock must be a whole number, 0 or more.` });
      const cLow = (c.lowStockThreshold === undefined || c.lowStockThreshold === null || c.lowStockThreshold === '') ? 10 : wholeNumber(c.lowStockThreshold, { min: 0, max: 100000 });
      if (cLow === null) return res.status(400).json({ message: `${label}: "Low-stock alert" must be a whole number, 0 or more.` });
      extras.push({ colorName: cName, swatch: cleanSwatch(c.swatch) || 'maroon', prices: cPrices, stock: cStock, low: cLow });
    }
  }

  const maxRow = must(await supabase.from('products').select('id').order('id', { ascending: false }).limit(1), 'createProduct:maxId');
  const id = (maxRow[0]?.id || 0) + 1;
  const taken = new Set();
  const rpc = await supabase.rpc('create_product_with_default_variant', {
    p_id: id, p_name: name, p_fabric: fabric, p_occasion: occasion, p_price: prices.price, p_mrp: prices.mrp,
    p_badge: badge || null, p_swatch: swatchKey, p_description: sanitizeRich(desc), p_stock: stock,
    p_weaver_name: weaverName || '', p_weaver_region: weaverRegion || '', p_loom_type: loomType || 'Handloom',
    p_color_name: colorName, p_sku: uniqueSku(id, colorName, taken)
  });
  if (rpc.error) throw new Error(rpc.error.message);
  // The extra colours go in with one insert, and the first colour's low-stock alert is set at the same time.
  const writes = [];
  const firstColumns = { ...(low !== 10 ? { low_stock_threshold: low } : {}), ...(prices.cols || {}) };
  if (Object.keys(firstColumns).length) writes.push(supabase.from('product_variants').update(firstColumns).eq('product_id', id));
  if (extras.length) {
    writes.push(supabase.from('product_variants').insert(extras.map((c, i) => ({
      product_id: id, color_name: c.colorName, swatch: c.swatch, sku: uniqueSku(id, c.colorName, taken),
      price: c.prices.price, mrp: c.prices.mrp, ...(c.prices.cols || {}), stock: c.stock, low_stock_threshold: c.low,
      description: sanitizeRich(undefined), is_default: false, sort_order: i + 1
    }))));
  }
  const results = await Promise.all(writes);
  results.forEach(r => must(r, 'createProduct:variants'));
  await record(req, 'created', 'product', id, null, { name, fabric, price: prices.price, mrp: prices.mrp, buyingPrice: prices.pricing ? prices.pricing.buyingPrice : null, finalCp: prices.pricing ? prices.pricing.finalCp : null, stock, extraColours: extras.length });

  res.status(201).json({ product: adminProductShape(await getProductById(id)) });
}));

router.put('/products/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = must(await supabase.from('products').select('*').eq('id', id).maybeSingle(), 'updateProduct:lookup');
  if (!existing) return res.status(404).json({ message: 'Product not found.' });

  const { name, fabric, occasion, badge, desc, weaverName, weaverRegion, loomType, status } = req.body;
  const occasionText = occasion === undefined ? undefined : normalizeOccasions(occasion);
  if (occasion !== undefined && !occasionText) return res.status(400).json({ message: 'Choose at least one occasion (up to 8).' });
  if (name !== undefined && !cleanText(name, 120)) return res.status(400).json({ message: 'Name can\'t be blank (up to 120 characters).' });
  must(await supabase.from('products').update({
    name: name !== undefined ? name.trim() : existing.name, fabric: fabric ?? existing.fabric, occasion: occasionText ?? existing.occasion,
    badge: badge !== undefined ? badge : existing.badge, description: desc === undefined || desc === null ? existing.description : sanitizeRich(desc),
    weaver_name: weaverName ?? existing.weaver_name, weaver_region: weaverRegion ?? existing.weaver_region,
    loom_type: loomType ?? existing.loom_type, status: status ?? existing.status ?? 'active'
  }).eq('id', id), 'updateProduct:update');
  // The storefront shows a colour's own description when it has one, and the first colour is created with a copy
  // of the product description. So when the product description is edited, every colour that still carries the
  // old copy (or none) follows the edit; a colour with its own different text keeps it.
  if (desc !== undefined && desc !== null) {
    const newDesc = sanitizeRich(desc);
    if (newDesc !== (existing.description || '')) {
      const vs = must(await supabase.from('product_variants').select('id, description').eq('product_id', id), 'updateProduct:descCopies');
      for (const v of vs) {
        if (!v.description || v.description === existing.description) {
          must(await supabase.from('product_variants').update({ description: newDesc }).eq('id', v.id), 'updateProduct:descCopy');
        }
      }
    }
  }
  // Taking the Sale tag off ends the sale: each colour goes back to its actual (original) price.
  if (badge !== undefined && existing.badge === 'sale' && badge !== 'sale') {
    const vs = must(await supabase.from('product_variants').select('id, price, mrp').eq('product_id', id), 'updateProduct:endSale');
    for (const v of vs) {
      must(await supabase.from('product_variants').update({ price: v.mrp > v.price ? v.mrp : v.price, mrp: v.mrp > v.price ? v.mrp : v.price }).eq('id', v.id), 'updateProduct:restorePrice');
    }
    await syncProductMirrorFromDefaultVariant(id);
  }
  await record(req, 'updated', 'product', id, { name: existing.name, status: existing.status, badge: existing.badge }, { name, status, badge });

  res.json({ product: adminProductShape(await getProductById(id)) });
}));

// Archive rather than hard-delete once a product has ever been ordered —
// historical order_items must keep referring to something real.
router.delete('/products/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const wasOrdered = ((await supabase.from('order_items').select('*', { count: 'exact', head: true }).eq('product_id', id)).count || 0) > 0;
  if (wasOrdered) {
    must(await supabase.from('products').update({ status: 'archived' }).eq('id', id), 'deleteProduct:archive');
    await record(req, 'archived', 'product', id);
    return res.json({ message: 'Product archived (it has past orders, so it can’t be deleted outright).', archived: true });
  }
  // A never-ordered product can be removed outright, but several tables point
  // at it and the database refuses the delete while any row remains — photos
  // (via its variants), collection tags, Sarees-in-Motion entries. Clear those
  // first, plus the loose references with no constraint (carts, wishlists,
  // reviews, pre-book requests) so nothing is left pointing at a product that
  // no longer exists (a cart line with no product would break the bag page).
  const variantIds = must(await supabase.from('product_variants').select('id').eq('product_id', id), 'deleteProduct:variantIds').map(v => v.id);
  let photoUrls = [];
  if (variantIds.length) {
    photoUrls = must(await supabase.from('variant_media').select('url').in('variant_id', variantIds), 'deleteProduct:mediaUrls').map(m => m.url);
    must(await supabase.from('variant_media').delete().in('variant_id', variantIds), 'deleteProduct:media');
  }
  for (const table of ['collection_products', 'reel_items', 'cart_items', 'wishlist_items', 'reviews', 'prebook_requests']) {
    must(await supabase.from(table).delete().eq('product_id', id), `deleteProduct:${table}`);
  }
  must(await supabase.from('product_variants').delete().eq('product_id', id), 'deleteProduct:variants');
  must(await supabase.from('products').delete().eq('id', id), 'deleteProduct:product');
  // Best-effort file cleanup — never let a missing file turn a successful delete into an error.
  for (const url of photoUrls) await removeUpload(url);
  await record(req, 'deleted', 'product', id);
  res.json({ message: 'Product deleted.', archived: false });
}));

// ---- Variants ----
router.post('/products/:id(\\d{1,9})/variants', asyncRoute(async (req, res) => {
  const productId = Number(req.params.id);
  const product = must(await supabase.from('products').select('id, badge').eq('id', productId).maybeSingle(), 'addVariant:product');
  if (!product) return res.status(404).json({ message: 'Product not found.' });

  const { colorName: rawColor, swatch, sku, price, mrp, salePercent, stock: rawStock, lowStockThreshold: rawLow, costPrice } = req.body;
  const description = req.body.description !== undefined ? req.body.description : req.body.desc;
  const colorName = cleanText(rawColor, 60);
  const hasCost = costPrice !== undefined && costPrice !== null && String(costPrice).trim() !== '';
  if (!colorName || (!hasCost && (price === undefined || price === null || price === ''))) {
    return res.status(400).json({ message: 'Colour name (up to 60 characters) and the buying price are required.' });
  }
  const stock = (rawStock === undefined || rawStock === null || rawStock === '') ? 0 : wholeNumber(rawStock);
  if (stock === null) return res.status(400).json({ message: 'Stock must be a whole number, 0 or more.' });
  const lowStockThreshold = (rawLow === undefined || rawLow === null || rawLow === '') ? 10 : wholeNumber(rawLow, { min: 0, max: 100000 });
  if (lowStockThreshold === null) return res.status(400).json({ message: '"Low stock at" must be a whole number, 0 or more.' });
  const prices = await priceForColour({ costPrice, price, mrp, salePercent, onSale: product.badge === 'sale' });
  if (prices.error) return res.status(400).json({ message: prices.error });
  const maxSort = must(await supabase.from('product_variants').select('sort_order').eq('product_id', productId).order('sort_order', { ascending: false }).limit(1), 'addVariant:maxSort');
  const sortOrder = (maxSort[0]?.sort_order ?? -1) + 1;
  const inserted = must(await supabase.from('product_variants').insert({
    product_id: productId, color_name: colorName, swatch: cleanSwatch(swatch) || 'maroon',
    sku: cleanText(sku, 60) || uniqueSku(productId, colorName, await takenSkus(productId)),
    price: prices.price, mrp: prices.mrp, ...(prices.cols || {}), stock, low_stock_threshold: lowStockThreshold,
    description: sanitizeRich(description), is_default: false, sort_order: sortOrder
  }).select().single(), 'addVariant:insert');

  res.status(201).json({ variant: await getVariantById(inserted.id) });
}));

router.put('/variants/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = must(await supabase.from('product_variants').select('*').eq('id', id).maybeSingle(), 'updateVariant:lookup');
  if (!existing) return res.status(404).json({ message: 'Variant not found.' });

  const { colorName, swatch, sku, price, mrp, salePercent, stock, lowStockThreshold, isDefault, costPrice } = req.body;
  const description = req.body.description !== undefined ? req.body.description : req.body.desc;
  if (colorName !== undefined && !cleanText(colorName, 60)) return res.status(400).json({ message: 'Colour name can\'t be blank (up to 60 characters).' });
  const newStock = stock !== undefined ? wholeNumber(stock) : existing.stock;
  if (newStock === null) return res.status(400).json({ message: 'Stock must be a whole number, 0 or more.' });
  const newLow = lowStockThreshold !== undefined ? wholeNumber(lowStockThreshold, { min: 0, max: 100000 }) : existing.low_stock_threshold;
  if (newLow === null) return res.status(400).json({ message: '"Low stock at" must be a whole number, 0 or more.' });

  // Price fields follow the product's Sale tag (see resolvePrices).
  const owner = must(await supabase.from('products').select('badge').eq('id', existing.product_id).maybeSingle(), 'updateVariant:product');
  let newPrice = existing.price, newMrp = existing.mrp, costCols = {}, newPricing = null;
  if (price !== undefined || costPrice !== undefined) {
    const prices = await priceForColour({ costPrice, price, mrp: mrp !== undefined ? mrp : existing.mrp, salePercent, onSale: !!owner && owner.badge === 'sale', existing });
    if (prices.error) return res.status(400).json({ message: prices.error });
    newPrice = prices.price; newMrp = prices.mrp; costCols = prices.cols || {}; newPricing = prices.pricing || null;
  } else if (mrp !== undefined && existing.cost_price == null) {
    newMrp = Number(mrp);
  }

  if (isDefault) {
    must(await supabase.from('product_variants').update({ is_default: false }).eq('product_id', existing.product_id), 'updateVariant:clearDefault');
  }

  must(await supabase.from('product_variants').update({
    color_name: colorName !== undefined ? colorName.trim() : existing.color_name, swatch: cleanSwatch(swatch) ?? existing.swatch,
    // blank = keep the colour's code; a colour that never had one gets an automatic one
    sku: (sku !== undefined && cleanText(sku, 60)) || existing.sku || uniqueSku(existing.product_id, colorName !== undefined ? colorName : existing.color_name, await takenSkus(existing.product_id)),
    price: newPrice, mrp: newMrp, ...costCols,
    stock: newStock,
    low_stock_threshold: newLow,
    description: description === undefined || description === null ? existing.description : sanitizeRich(description),
    is_default: isDefault !== undefined ? !!isDefault : existing.is_default
  }).eq('id', id), 'updateVariant:update');

  await syncProductMirrorFromDefaultVariant(existing.product_id);
  await record(req, 'updated', 'variant', id,
    { price: existing.price, mrp: existing.mrp, stock: existing.stock, buyingPrice: existing.cost_price, finalCp: existing.final_cp },
    { price: newPrice, mrp: newMrp, stock: stock ?? existing.stock, buyingPrice: newPricing ? newPricing.buyingPrice : (costCols.cost_price !== undefined ? costCols.cost_price : existing.cost_price), finalCp: newPricing ? newPricing.finalCp : (costCols.final_cp !== undefined ? costCols.final_cp : existing.final_cp) });
  res.json({ variant: await getVariantById(id) });
}));

router.delete('/variants/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = must(await supabase.from('product_variants').select('*').eq('id', id).maybeSingle(), 'deleteVariant:lookup');
  if (!existing) return res.status(404).json({ message: 'Variant not found.' });

  const siblingCount = (await supabase.from('product_variants').select('*', { count: 'exact', head: true }).eq('product_id', existing.product_id).eq('archived', false)).count || 0;
  if (siblingCount <= 1) {
    return res.status(400).json({ message: 'A product needs at least one variant — add another color before removing this one.' });
  }

  const wasOrdered = ((await supabase.from('order_items').select('*', { count: 'exact', head: true }).eq('variant_id', id)).count || 0) > 0;
  if (wasOrdered) {
    must(await supabase.from('product_variants').update({ archived: true }).eq('id', id), 'deleteVariant:archive');
  } else {
    must(await supabase.from('variant_media').delete().eq('variant_id', id), 'deleteVariant:media');
    must(await supabase.from('product_variants').delete().eq('id', id), 'deleteVariant:delete');
  }

  if (existing.is_default) {
    // Promote the next remaining variant to default so the product mirror stays valid.
    const next = must(await supabase.from('product_variants').select('id').eq('product_id', existing.product_id).eq('archived', false).order('sort_order').order('id').limit(1), 'deleteVariant:promote');
    if (next[0]) must(await supabase.from('product_variants').update({ is_default: true }).eq('id', next[0].id), 'deleteVariant:setDefault');
  }
  await syncProductMirrorFromDefaultVariant(existing.product_id);

  res.json({ message: wasOrdered ? 'Variant archived (it has past orders).' : 'Variant deleted.' });
}));

// ---- Variant media ----
// A colour's gallery is ordered: 1st the main photo, 2nd the (optional) product video, then any number of more photos.
// Only the 2nd slide can be a video, and a colour has at most one. The video is a short, light MP4 / WebM: customers see it
// play when they hover a product card and on the second slide of the product page, so it has to be small and quick to start.
const PRODUCT_VIDEO_TYPES = ['video/mp4', 'video/webm'];
const PRODUCT_VIDEO_MAX_BYTES = 20 * 1024 * 1024;

// Rewrites sort_order so the gallery is always [main photo, video, other photos...] and exactly one photo is the primary.
// Safe to call after any add / delete / "make main" - it only reorders and never touches the files.
async function normalizeVariantMedia(variantId) {
  const rows = must(await supabase.from('variant_media').select('id, type, is_primary, sort_order').eq('variant_id', variantId).order('sort_order').order('id'), 'normalizeMedia:read');
  const images = rows.filter(r => r.type === 'image');
  const video = rows.find(r => r.type === 'video') || null;
  const extraVideos = rows.filter(r => r.type === 'video' && r !== video);
  const main = images.find(r => r.is_primary) || images[0] || null;
  const rest = images.filter(r => r !== main);
  const order = [main, video, ...rest, ...extraVideos].filter(Boolean);
  for (const [i, r] of order.entries()) {
    const wantPrimary = !!main && r === main;
    if (r.sort_order !== i || !!r.is_primary !== wantPrimary) {
      must(await supabase.from('variant_media').update({ sort_order: i, is_primary: wantPrimary }).eq('id', r.id), 'normalizeMedia:write');
    }
  }
}

// Checks a product video before it is stored: type, size, a main photo first, and only one video per colour.
async function checkProductMedia(req) {
  const file = req.file;
  if (!file || !file.mimetype.startsWith('video')) return null;
  if (!PRODUCT_VIDEO_TYPES.includes(file.mimetype)) {
    return 'The product video must be an MP4 or WEBM file. A .mov from an iPhone often will not play in every browser - export it as MP4 (H.264) first.';
  }
  if (file.size > PRODUCT_VIDEO_MAX_BYTES) {
    return `That video is ${(file.size / 1024 / 1024).toFixed(1)}MB. Keep the product video under 20MB (about 15 seconds at a normal phone quality) so it starts quickly for customers.`;
  }
  const variantId = Number(req.params.id);
  const rows = must(await supabase.from('variant_media').select('type').eq('variant_id', variantId), 'checkMedia:rows');
  if (!rows.some(r => r.type === 'image')) return 'Add the main photo first - the video is always the second slide, after the main photo.';
  if (rows.some(r => r.type === 'video')) return 'This colour already has a video. Remove it first to upload a different one.';
  return null;
}

router.post('/variants/:id(\\d{1,9})/media', uploadChecked(async req => {
  const exists = must(await supabase.from('product_variants').select('id').eq('id', Number(req.params.id)).maybeSingle(), 'addMedia:exists');
  if (!exists) return 'Variant not found.';
  return checkProductMedia(req);
}), asyncRoute(async (req, res) => {
  const variantId = Number(req.params.id);
  const variant = must(await supabase.from('product_variants').select('*').eq('id', variantId).maybeSingle(), 'addMedia:variant');
  if (!variant) return res.status(404).json({ message: 'Variant not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

  const type = req.file.mimetype.startsWith('video') ? 'video' : 'image';
  const url = req.file.publicUrl;
  const hasAny = ((await supabase.from('variant_media').select('*', { count: 'exact', head: true }).eq('variant_id', variantId)).count || 0) > 0;
  const maxSort = must(await supabase.from('variant_media').select('sort_order').eq('variant_id', variantId).order('sort_order', { ascending: false }).limit(1), 'addMedia:maxSort');
  const sortOrder = (maxSort[0]?.sort_order ?? -1) + 1;

  const inserted = must(await supabase.from('variant_media').insert({
    variant_id: variantId, type, url, alt_text: cleanText(req.body.alt, 200) || '', is_primary: type === 'image' && !hasAny, sort_order: sortOrder
  }).select().single(), 'addMedia:insert');
  await normalizeVariantMedia(variantId);   // a video always lands second, more photos after it

  res.status(201).json({ media: inserted });
}));

router.delete('/media/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const media = must(await supabase.from('variant_media').select('*').eq('id', id).maybeSingle(), 'deleteMedia:lookup');
  if (!media) return res.status(404).json({ message: 'Media not found.' });

  must(await supabase.from('variant_media').delete().eq('id', id), 'deleteMedia:delete');
  await normalizeVariantMedia(media.variant_id);   // the next photo becomes the main one; the video stays second
  // Best-effort file cleanup — never let a missing file block the API response.
  await removeUpload(media.url);

  res.json({ message: 'Media removed.' });
}));

// Alt text: the short description of a photo that screen readers read out and search engines use for image search.
router.put('/media/:id(\\d{1,9})/alt', asyncRoute(async (req, res) => {
  const media = must(await supabase.from('variant_media').select('id, alt_text').eq('id', Number(req.params.id)).maybeSingle(), 'altMedia:lookup');
  if (!media) return res.status(404).json({ message: 'Photo not found.' });
  const raw = req.body && req.body.alt;
  const alt = typeof raw === 'string' ? raw.trim() : '';
  if (alt.length > 200) return res.status(400).json({ message: 'Keep the description under 200 characters.' });
  must(await supabase.from('variant_media').update({ alt_text: alt }).eq('id', media.id), 'altMedia:update');
  await record(req, 'updated alt text', 'photo', media.id, { alt: media.alt_text }, { alt });
  res.json({ message: 'Alt text saved.', alt });
}));

router.put('/media/:id(\\d{1,9})/primary', asyncRoute(async (req, res) => {
  const media = must(await supabase.from('variant_media').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'primaryMedia:lookup');
  if (!media) return res.status(404).json({ message: 'Media not found.' });
  if (media.type !== 'image') return res.status(400).json({ message: 'Only a photo can be the main photo. The video always stays second.' });
  must(await supabase.from('variant_media').update({ is_primary: false }).eq('variant_id', media.variant_id), 'primaryMedia:clear');
  must(await supabase.from('variant_media').update({ is_primary: true }).eq('id', media.id), 'primaryMedia:set');
  await normalizeVariantMedia(media.variant_id);
  res.json({ message: 'Set as primary.' });
}));

// ---- Inventory ----
router.get('/inventory', asyncRoute(async (req, res) => {
  const variants = must(
    await supabase.from('product_variants').select('id, product_id, color_name, sku, stock, low_stock_threshold').eq('archived', false),
    'inventory:variants'
  );
  const productIds = [...new Set(variants.map(v => v.product_id))];
  const products = productIds.length ? must(await supabase.from('products').select('id, name').in('id', productIds), 'inventory:products') : [];
  const nameById = Object.fromEntries(products.map(p => [p.id, p.name]));

  const rows = variants
    .map(v => ({
      variantId: v.id, productId: v.product_id, productName: nameById[v.product_id] || '', colorName: v.color_name,
      sku: v.sku, stock: v.stock, lowStockThreshold: v.low_stock_threshold,
      status: v.stock <= 0 ? 'Out of Stock' : (v.stock <= v.low_stock_threshold ? 'Low Stock' : 'In Stock')
    }))
    .sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));
  res.json({ inventory: rows });
}));

router.post('/inventory/adjust', asyncRoute(async (req, res) => {
  const { variantId, change, reason } = req.body;
  const id = Number(variantId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return res.status(400).json({ message: 'Choose a valid variant.' });
  const variant = must(await supabase.from('product_variants').select('*').eq('id', id).maybeSingle(), 'adjustInventory:lookup');
  if (!variant) return res.status(404).json({ message: 'Variant not found.' });
  const delta = wholeNumber(change, { min: -MAX_STOCK, max: MAX_STOCK });
  if (!delta) return res.status(400).json({ message: 'Enter a non-zero whole number (use a minus sign to take stock out).' });

  const after = Math.max(0, variant.stock + delta);
  must(await supabase.from('product_variants').update({ stock: after }).eq('id', id), 'adjustInventory:update');
  must(await supabase.from('inventory_history').insert({
    variant_id: id, change: after - variant.stock, before_stock: variant.stock, after_stock: after,
    reason: reason || 'Manual correction', changed_by: req.adminName, created_at: new Date().toISOString()
  }), 'adjustInventory:log');
  await syncProductMirrorFromDefaultVariant(variant.product_id);
  await record(req, 'stock adjusted', 'variant', id, { stock: variant.stock }, { stock: after, reason: reason || 'Manual correction' });

  res.json({ variant: await getVariantById(id) });
}));

router.get('/inventory/:variantId(\\d{1,9})/history', asyncRoute(async (req, res) => {
  const rows = must(
    await supabase.from('inventory_history').select('*').eq('variant_id', Number(req.params.variantId)).order('created_at', { ascending: false }),
    'inventoryHistory'
  );
  res.json({ history: rows });
}));

// ---- Bulk price/stock CSV (export + re-import) ----
function csvEscape(val) {
  const s = String(val == null ? '' : val);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Minimal RFC-4180-ish parser — good enough for a file this same export just
// produced (quoted fields, escaped quotes, commas inside quotes); not meant
// to be a general-purpose CSV library.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else { field += c; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function variantCsvRows() {
  const variants = must(await supabase.from('product_variants').select('id, product_id, color_name, sku, price, mrp, stock').eq('archived', false), 'variantCsvRows:variants');
  const productIds = [...new Set(variants.map(v => v.product_id))];
  const products = productIds.length ? must(await supabase.from('products').select('id, name').in('id', productIds), 'variantCsvRows:products') : [];
  const nameById = Object.fromEntries(products.map(p => [p.id, p.name]));
  return variants
    .map(v => ({ variantId: v.id, productName: nameById[v.product_id] || '', colorName: v.color_name, sku: v.sku, price: v.price, mrp: v.mrp, stock: v.stock }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

// A small, honest starting point for the import format — real column names
// and one real example row (not fabricated placeholder data), so an admin
// can see exactly what's expected without wading through the full catalog.
// The full Export CSV button is still the right tool for actually bulk-editing
// every variant; this is just "what does a valid row look like."
router.get('/variants/template.csv', asyncRoute(async (req, res) => {
  const rows = await variantCsvRows();
  const example = rows[0];
  const header = ['variantId', 'productName', 'colorName', 'sku', 'price', 'mrp', 'stock'];
  const lines = [header.join(',')];
  if (example) lines.push(header.map(h => csvEscape(example[h])).join(','));
  res.header('Content-Type', 'text/csv');
  res.header('Content-Disposition', 'attachment; filename="padmora-variants-import-template.csv"');
  res.send(lines.join('\n'));
}));

router.get('/variants/export.csv', asyncRoute(async (req, res) => {
  const rows = await variantCsvRows();
  const header = ['variantId', 'productName', 'colorName', 'sku', 'price', 'mrp', 'stock'];
  const csv = [header.join(',')]
    .concat(rows.map(r => header.map(h => csvEscape(r[h])).join(',')))
    .join('\n');
  res.header('Content-Type', 'text/csv');
  res.header('Content-Disposition', `attachment; filename="padmora-variants-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

router.post('/variants/import', asyncRoute(async (req, res) => {
  const { csv } = req.body || {};
  if (!csv || typeof csv !== 'string') return res.status(400).json({ message: 'Paste or upload a CSV file first.' });

  const rows = parseCsv(csv.trim());
  if (!rows.length) return res.status(400).json({ message: 'That CSV looks empty.' });
  const header = rows[0].map(h => h.trim());
  const idx = { variantId: header.indexOf('variantId'), price: header.indexOf('price'), mrp: header.indexOf('mrp'), stock: header.indexOf('stock') };
  if (idx.variantId === -1) return res.status(400).json({ message: 'CSV must have a variantId column — export the current file first and edit that.' });

  let updated = 0;
  const errors = [];
  const dataRows = rows.slice(1);
  for (let i = 0; i < dataRows.length; i++) {
    const cols = dataRows[i];
    const rowNum = i + 2; // +1 for header, +1 for 1-indexing
    const variantId = Number(cols[idx.variantId]);
    const variant = variantId ? must(await supabase.from('product_variants').select('*').eq('id', variantId).maybeSingle(), 'importVariants:lookup') : null;
    if (!variant) { errors.push({ row: rowNum, reason: `No variant with id ${cols[idx.variantId]}` }); continue; }

    const price = idx.price > -1 && cols[idx.price] !== '' ? wholeNumber(cols[idx.price], { min: 1, max: MAX_PRICE }) : variant.price;
    const mrp = idx.mrp > -1 && cols[idx.mrp] !== '' ? wholeNumber(cols[idx.mrp], { min: 1, max: MAX_PRICE }) : variant.mrp;
    const stock = idx.stock > -1 && cols[idx.stock] !== '' ? wholeNumber(cols[idx.stock]) : variant.stock;
    if (price === null) { errors.push({ row: rowNum, reason: 'Invalid price (whole rupees, 1 or more)' }); continue; }
    if (mrp === null) { errors.push({ row: rowNum, reason: 'Invalid MRP (whole rupees, 1 or more)' }); continue; }
    if (stock === null) { errors.push({ row: rowNum, reason: 'Invalid stock (whole number, 0 or more)' }); continue; }

    must(await supabase.from('product_variants').update({ price, mrp, stock }).eq('id', variantId), 'importVariants:update');
    await syncProductMirrorFromDefaultVariant(variant.product_id);
    updated++;
  }

  await record(req, 'bulk CSV import', 'variants', null, null, { updated, errorCount: errors.length });
  res.json({ updated, skipped: errors.length, errors: errors.slice(0, 50) });
}));

// ---- Orders ----
async function attachOrderExtras(orders) {
  const userIds = [...new Set(orders.map(o => o.user_id))];
  const users = userIds.length ? await fetchAllByIds(userIds, c => supabase.from('users').select('id, name, email').in('id', c).order('id'), 'attachOrderExtras:users') : [];
  const userById = Object.fromEntries(users.map(u => [u.id, u]));
  return orders.map(o => ({ ...o, customer_name: userById[o.user_id]?.name, customer_email: publicEmail(userById[o.user_id]?.email) }));
}

// Each order line's product code (SKU) - looked up live from its colour, in one query for any number of orders.
async function attachSkus(orders) {
  const ids = [...new Set(orders.flatMap(o => o.items.map(i => i.variantId)).filter(Boolean))];
  const skuById = {};
  for (let i = 0; i < ids.length; i += 200) {
    const rows = must(await supabase.from('product_variants').select('id, sku').in('id', ids.slice(i, i + 200)), 'attachSkus');
    rows.forEach(r => { skuById[r.id] = r.sku; });
  }
  // an Instagram order's saree is not in the catalogue, so its code is the one typed in the sheet
  orders.forEach(o => o.items.forEach(i => { i.sku = skuById[i.variantId] || i.productCode || ''; }));
  return orders;
}

// The Orders list shapes hundreds of orders at once: read all their items and pictures together instead of per order.
async function shapeAdminOrderList(orders) {
  const items = orders.length ? await fetchAllByIds(orders.map(o => o.id), c => supabase.from('order_items').select('*').in('order_id', c).order('id'), 'adminOrderList:items') : [];
  const itemsByOrder = {};
  items.forEach(li => (itemsByOrder[li.order_id] || (itemsByOrder[li.order_id] = [])).push(li));
  const imageByVariant = {};
  const variantIds = [...new Set(items.map(li => li.variant_id).filter(Boolean))];
  for (let i = 0; i < variantIds.length; i += 150) Object.assign(imageByVariant, await getPrimaryImagesByVariantIds(variantIds.slice(i, i + 150)));
  const refunds = await loadRefundsByOrder(orders.map(o => o.id));
  return Promise.all(orders.map(o => shapeAdminOrder(o, { preloaded: { items: itemsByOrder[o.id] || [], imageByVariant, refunds } })));
}

async function shapeAdminOrder(o, { full, preloaded } = {}) {
  const items = preloaded ? preloaded.items : must(await supabase.from('order_items').select('*').eq('order_id', o.id), 'shapeAdminOrder:items');
  const imageByVariant = preloaded ? preloaded.imageByVariant : await getPrimaryImagesByVariantIds(items.map(li => li.variant_id));
  const refundInfo = (preloaded ? (preloaded.refunds || {}) : await loadRefundsByOrder([o.id]))[o.id] || null;
  const totalUnits = items.reduce((n, li) => n + Number(li.qty || 0), 0);
  const status = await computeStatus(o);
  const base = {
    id: o.id,
    source: o.source || 'website',
    customerName: o.customer_name,
    customerEmail: o.customer_email,
    items: items.map(li => ({
      productId: li.product_id, variantId: li.variant_id, name: li.name, color: li.color, qty: li.qty, price: li.price,
      productCode: li.product_code || '', imageUrl: imageByVariant[li.variant_id] || null
    })),
    subtotal: o.subtotal,
    discount: o.discount,
    shippingFee: o.shipping_fee,
    taxAmount: o.tax_amount,
    couponCode: o.coupon_code,
    payment: o.payment,
    total: o.total,
    status,
    manualStatus: o.manual_status,
    cancelReason: o.cancel_reason,
    refundStatus: o.refund_status,
    cancelRequestStatus: o.cancel_request_status,
    cancelRequestReason: o.cancel_request_reason,
    cancelRequestDetail: o.cancel_request_detail,
    cancelRequestedAt: o.cancel_requested_at,
    cancelAdminNote: o.cancel_admin_note,
    // Money handed back for returned sarees (a return marked Refunded). null when nothing was returned and refunded. `full` = every
    // saree of the order came back; otherwise only some did. This is what Total Revenue and Net Profit subtract.
    returnRefund: refundInfo ? {
      amount: refundInfo.amount, returnedUnits: refundInfo.returnedUnits, totalUnits,
      full: totalUnits > 0 && refundInfo.returnedUnits >= totalUnits,
      returns: refundInfo.returns
    } : null,
    address: { name: o.address_name, city: o.address_city, state: o.address_state, pincode: o.address_pincode },
    placedAt: o.placed_at,
    viewedAt: o.admin_viewed_at
  };
  if (!full) return base;
  const notifications = must(
    await supabase.from('notifications_log').select('channel, recipient, subject, status, detail, created_at').eq('order_id', o.id).order('created_at', { ascending: false }),
    'shapeAdminOrder:notifications'
  );
  const productIds = [...new Set(items.map(li => li.product_id).filter(Boolean))];
  const fabrics = productIds.length ? must(await supabase.from('products').select('id, fabric').in('id', productIds), 'shapeAdminOrder:fabrics') : [];
  const fabricById = Object.fromEntries(fabrics.map(p => [p.id, p.fabric]));
  base.items.forEach(li => { li.fabric = fabricById[li.productId] || ''; });
  await attachSkus([base]);
  const inquiryRows = must(await supabase.from('return_requests').select('id, attempt, part, status').eq('order_id', o.id).order('id'), 'shapeAdminOrder:inquiries');
  const extraLive = Number(o.extra_inquiries || 0) > 0 && o.extra_inquiry_until && new Date(o.extra_inquiry_until).getTime() >= Date.now();
  return {
    ...base,
    // the order's inquiries (each request is one group of sarees) and any extra inquiry an admin has allowed that is still waiting to be used
    inquiry: { requests: inquiryRows.map(r => ({ id: r.id, attempt: r.attempt || 1, part: r.part || 1, status: r.status })), extraAllowed: extraLive ? Number(o.extra_inquiries) : 0, extraUntil: extraLive ? o.extra_inquiry_until : null },
    customerPhone: o.address_phone,
    address: {
      name: o.address_name, line1: o.address_line1, city: o.address_city,
      state: o.address_state, pincode: o.address_pincode, phone: o.address_phone
    },
    payment: o.payment,
    cancelledAt: o.cancelled_at,
    razorpayPaymentId: o.razorpay_payment_id || null,
    razorpayRefundId: o.razorpay_refund_id && o.razorpay_refund_id !== 'pending' ? o.razorpay_refund_id : null,
    refundAmount: o.refund_amount,
    refundProcessedAt: o.refund_processed_at,
    timeline: await buildTimeline(o),
    notifications
  };
}

router.get('/orders', asyncRoute(async (req, res) => {
  const orders = await attachOrderExtras(await fetchAllRows(() => supabase.from('orders').select('*').order('placed_at', { ascending: false }).order('id', { ascending: false }), 'listOrders'));

  let shaped = await attachSkus(await shapeAdminOrderList(orders));
  const { status } = req.query;
  if (status && status !== 'all') {
    shaped = shaped.filter(o => o.status.toLowerCase() === String(status).toLowerCase());
  }

  res.json({ orders: shaped, stageNames: STAGE_NAMES });
}));

// Registered ahead of /orders/:id below — otherwise Express would match this
// path as an :id lookup for an order literally named "export.csv" and 404.
router.get('/orders/export.csv', asyncRoute(async (req, res) => {
  const orders = await attachOrderExtras(await fetchAllRows(() => supabase.from('orders').select('*').order('placed_at', { ascending: false }).order('id', { ascending: false }), 'exportOrders'));
  const orderIds = orders.map(o => o.id);
  const allItems = orderIds.length ? await fetchAllByIds(orderIds, c => supabase.from('order_items').select('order_id, name, color, qty, variant_id, product_code').in('order_id', c).order('id'), 'exportOrders:items') : [];
  const skuOf = (await attachSkus([{ items: allItems.map(i => ({ variantId: i.variant_id, productCode: i.product_code })) }]))[0].items;
  allItems.forEach((i, k) => { i.sku = skuOf[k].sku; });
  const itemsByOrder = {};
  allItems.forEach(i => (itemsByOrder[i.order_id] || (itemsByOrder[i.order_id] = [])).push(i));

  const header = ['orderId', 'source', 'placedAt', 'customerName', 'customerEmail', 'status', 'payment', 'items', 'units', 'subtotal', 'discount', 'shippingFee', 'total'];
  const rows = [];
  for (const o of orders) {
    const items = itemsByOrder[o.id] || [];
    const itemsSummary = items.map(i => `${i.name}${i.color ? ' (' + i.color + ')' : ''}${i.sku ? ' [' + i.sku + ']' : ''} x${i.qty}`).join('; ');
    rows.push([
      o.id, o.source || 'website', o.placed_at, o.customer_name, o.customer_email, await computeStatus(o), o.payment,
      itemsSummary, items.reduce((n, i) => n + i.qty, 0), o.subtotal, o.discount, o.shipping_fee, o.total
    ]);
  }
  const csv = [header.join(',')]
    .concat(rows.map(r => r.map(csvEscape).join(',')))
    .join('\n');

  res.header('Content-Type', 'text/csv');
  res.header('Content-Disposition', `attachment; filename="padmora-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// Bulk packing-slip printing — one round trip for however many orders were
// selected, rather than the print page making one request per order.
// Also registered ahead of /orders/:id for the same reason as export.csv above.
router.get('/orders/bulk', asyncRoute(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ message: 'No order IDs given.' });
  const orders = await attachOrderExtras(must(await supabase.from('orders').select('*').in('id', ids), 'bulkOrders'));
  // Preserve the order the caller asked for (SQL's IN doesn't guarantee it),
  // and silently drop any id that didn't match a real order rather than 404ing
  // the whole batch over one bad id.
  const byId = new Map(orders.map(o => [o.id, o]));
  const shaped = await Promise.all(ids.map(id => byId.get(id)).filter(Boolean).map(o => shapeAdminOrder(o, { full: true })));
  res.json({ orders: shaped });
}));

// What is waiting for the store owner right now - shown at the top of the Overview, each with the screen that handles it.
// Counts only (cheap head-only queries); the Orders / Returns screens hold the detail. Sits under /orders so only a Super Admin
// or an Order Manager can read it. Must stay ahead of '/orders/:id'.
router.get('/orders/action-items', asyncRoute(async (req, res) => {
  const count = async build => { const r = await build(supabase.from('orders').select('id', { count: 'exact', head: true })); if (r.error) throw new Error(r.error.message); return r.count || 0; };
  const countReturns = async status => { const r = await supabase.from('return_requests').select('id', { count: 'exact', head: true }).eq('status', status); if (r.error) throw new Error(r.error.message); return r.count || 0; };
  const [newOrders, cancelRequests, refundsDue, returnsToRefund, returnsToReceive, inquiries] = await Promise.all([
    count(q => q.is('admin_viewed_at', null)),                                              // not opened by any admin yet (bold in the Orders list)
    count(q => q.eq('cancel_request_status', 'Requested').is('cancelled_at', null)),         // customer asked to cancel, not decided
    count(q => q.not('cancelled_at', 'is', null).eq('refund_status', 'Pending')),            // cancelled and paid online: money still to send back
    countReturns('Received'),                                                                 // saree is back: refund to pay
    countReturns('Approved'),                                                                 // approved: waiting for the saree to come back
    countReturns('Requested')                                                                 // new inquiries nobody has decided on
  ]);
  res.json({ actions: { newOrders, cancelRequests, refundsDue, returnsToRefund, returnsToReceive, inquiries } });
}));

router.get('/orders/:id', asyncRoute(async (req, res) => {
  const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle(), 'getAdminOrder');
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  const [o] = await attachOrderExtras([order]);
  res.json({ order: await shapeAdminOrder(o, { full: true }) });
}));

// The first time any admin opens an order, remember it - the Orders list shows unopened orders in bold.
router.post('/orders/:id/viewed', asyncRoute(async (req, res) => {
  const upd = await supabase.from('orders').update({ admin_viewed_at: new Date().toISOString() }).eq('id', req.params.id).is('admin_viewed_at', null);
  if (upd.error) throw new Error(upd.error.message);
  res.json({ ok: true });
}));

router.put('/orders/:id/status', asyncRoute(async (req, res) => {
  const { status } = req.body; // one of STAGE_NAMES, or null/'auto' to revert to time-based
  const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle(), 'setOrderStatus:lookup');
  if (!order) return res.status(404).json({ message: 'Order not found.' });

  const manualStatus = (!status || status === 'auto') ? null : status;
  if (manualStatus && !STAGE_NAMES.includes(manualStatus)) {
    return res.status(400).json({ message: 'Invalid status.' });
  }
  // A cancelled order has no steps left (and would otherwise e-mail the customer "your order has shipped").
  if (order.cancelled_at) {
    return res.status(409).json({ message: 'This order has been cancelled, so its status cannot be changed.' });
  }
  // Returned and refunded: the money has gone back, so the order's story is over - same as a cancelled order, its status is final.
  if ((await loadRefundsByOrder([order.id]))[order.id]) {
    return res.status(409).json({ message: 'This order has been returned and refunded, so its status can no longer be changed.' });
  }
  // The customer has asked to cancel: the order must not move on (to Shipped, say) until that request has been approved or
  // rejected - otherwise the request could be answered after the saree has already left. (The bulk upload skips these too.)
  if (order.cancel_request_status === 'Requested') {
    return res.status(409).json({ message: 'The customer has asked to cancel this order. Approve or reject the cancellation request first - the order status cannot be changed until then.' });
  }

  const { advanced } = await setOrderManualStatus(order, manualStatus, 'manual');
  await record(req, 'status changed', 'order', order.id, { manualStatus: order.manual_status }, { manualStatus });
  // Same customer email as the bulk upload, but only when moving forward — fixing a
  // mistake (stepping back, or reverting to automatic) never emails anyone.
  if (advanced) notifyStatusChange([order.id], manualStatus);
  const updated = must(await supabase.from('orders').select('*').eq('id', order.id).single(), 'setOrderStatus:reread');
  res.json({ status: await computeStatus(updated), timeline: await buildTimeline(updated) });
}));

// ---- Bulk status update from an uploaded sheet of order IDs ----
// The store ships by hand (no courier integration), so the day's packed orders
// are listed in a spreadsheet and uploaded here. Two steps — preview (read the
// file, show exactly what would change) then apply (re-checks every order at
// that moment before touching anything).
const BULK_TARGETS = ['Packed', 'Shipped', 'Out for Delivery', 'Delivered'];

async function classifyBulk(ids, target) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const orders = await attachOrderExtras(must(await supabase.from('orders').select('*').in('id', chunk), 'bulkStatus:orders'));
    orders.forEach(o => found.set(o.id, o));
  }
  const targetIdx = STAGE_NAMES.indexOf(target);
  const refundedByOrder = await loadRefundsByOrder(ids);
  const rows = [];
  for (const id of ids) {
    const o = found.get(id);
    if (!o) { rows.push({ orderId: id, outcome: 'notfound', message: 'No order with this ID.' }); continue; }
    const base = { orderId: id, customer: o.address_name || o.customer_name || '' };
    const current = await computeStatus(o);
    if (current === 'Cancelled') { rows.push({ ...base, outcome: 'skip', current, message: 'Order is cancelled.' }); continue; }
    if (refundedByOrder[id]) { rows.push({ ...base, outcome: 'skip', current, message: 'Order was returned and refunded — its status is final.' }); continue; }
    if (o.cancel_request_status === 'Requested') { rows.push({ ...base, outcome: 'skip', current, message: 'Customer has requested a cancellation — review it first.' }); continue; }
    if (current === target) { rows.push({ ...base, outcome: 'skip', current, message: `Already ${target}.` }); continue; }
    if (STAGE_NAMES.indexOf(current) > targetIdx) { rows.push({ ...base, outcome: 'skip', current, message: `Already ${current} — won't move it back to ${target}.` }); continue; }
    rows.push({ ...base, outcome: 'update', current, message: `${current} → ${target}` });
  }
  return { rows, found };
}

// Emails go out after the response, one at a time, so a 200-order upload never waits
// on (or fails because of) the mail server; every attempt lands in notifications_log.
function notifyStatusChange(orderIds, status) {
  setImmediate(async () => {
    try {
      for (let i = 0; i < orderIds.length; i += 100) {
        const orders = await attachOrderExtras(must(await supabase.from('orders').select('*').in('id', orderIds.slice(i, i + 100)), 'notifyStatus:orders'));
        for (const o of orders) {
          try { await sendOrderStatusEmail(o, { id: o.user_id, name: o.address_name || o.customer_name, email: o.customer_email }, status); }
          catch (err) { console.error('Status email failed for', o.id, err.message); }
        }
      }
    } catch (err) { console.error('notifyStatusChange failed:', err); }
  });
}

router.get('/orders/bulk-status/template.xlsx', (req, res) => {
  res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.header('Content-Disposition', 'attachment; filename="padmora-order-ids-template.xlsx"');
  res.send(buildTemplateXlsx());
});

router.get('/orders/bulk-status/template.csv', (req, res) => {
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.header('Content-Disposition', 'attachment; filename="padmora-order-ids-template.csv"');
  res.send(buildTemplateCsv());
});

router.post('/orders/bulk-status/preview', express.raw({ type: () => true, limit: '3mb' }), asyncRoute(async (req, res) => {
  const target = String(req.query.status || '');
  if (!BULK_TARGETS.includes(target)) return res.status(400).json({ message: 'Choose which status to apply.' });
  let parsed;
  try { parsed = readOrderIds(req.body); }
  catch (err) { return res.status(400).json({ message: err.message }); }
  if (!parsed.ids.length) return res.status(400).json({ message: 'No order IDs found. Put one order ID per row in column A.' });
  const { rows } = await classifyBulk(parsed.ids, target);
  res.json({
    status: target,
    rows,
    counts: {
      total: parsed.ids.length,
      update: rows.filter(r => r.outcome === 'update').length,
      skip: rows.filter(r => r.outcome === 'skip').length,
      notFound: rows.filter(r => r.outcome === 'notfound').length,
      duplicates: parsed.duplicates
    }
  });
}));

router.post('/orders/bulk-status/apply', asyncRoute(async (req, res) => {
  const { status, orderIds, notify } = req.body || {};
  if (!BULK_TARGETS.includes(status)) return res.status(400).json({ message: 'Choose which status to apply.' });
  if (!Array.isArray(orderIds) || !orderIds.length) return res.status(400).json({ message: 'No orders to update.' });
  const ids = [...new Set(orderIds.map(normalizeOrderId).filter(Boolean))];
  if (ids.length > MAX_IDS) return res.status(400).json({ message: `At most ${MAX_IDS} orders at a time.` });

  // Re-check at apply time: an order may have been cancelled or moved on since the preview.
  const { rows } = await classifyBulk(ids, status);
  const toUpdate = rows.filter(r => r.outcome === 'update').map(r => r.orderId);
  const now = new Date().toISOString();
  for (let i = 0; i < toUpdate.length; i += 100) {
    const chunk = toUpdate.slice(i, i + 100);
    must(await supabase.from('order_status_events').insert(chunk.map(id => ({ order_id: id, status, source: 'bulk' }))), 'bulkStatus:events');
    must(await supabase.from('orders').update({ manual_status: status }).in('id', chunk), 'bulkStatus:update');
    if (status === 'Delivered') {
      must(await supabase.from('orders').update({ delivered_at: now }).in('id', chunk).is('delivered_at', null), 'bulkStatus:delivered');
    }
  }
  if (toUpdate.length) {
    await record(req, 'bulk status changed', 'order', 'bulk', null, { status, count: toUpdate.length, orderIds: toUpdate.slice(0, 200), emailed: notify !== false });
    if (notify !== false) notifyStatusChange(toUpdate, status);
  }
  res.json({
    updated: toUpdate.length,
    skipped: rows.filter(r => r.outcome !== 'update').map(r => ({ orderId: r.orderId, message: r.message })),
    emailsQueued: notify !== false ? toUpdate.length : 0
  });
}));

// Recent notification attempts across all orders — lets an admin confirm
// whether confirmation emails/texts are actually configured and firing,
// without needing server console access.
router.get('/notifications', asyncRoute(async (req, res) => {
  const rows = must(await supabase.from('notifications_log').select('*').order('created_at', { ascending: false }).limit(200), 'listNotifications');
  const orderIds = [...new Set(rows.map(r => r.order_id).filter(Boolean))];
  const orders = orderIds.length ? must(await supabase.from('orders').select('id, address_name').in('id', orderIds), 'listNotifications:orders') : [];
  const nameByOrder = Object.fromEntries(orders.map(o => [o.id, o.address_name]));
  res.json({
    notifications: rows.map(r => ({ ...r, customer_name: nameByOrder[r.order_id] })),
    emailConfigured: emailConfigured(),
    smsConfigured: smsConfigured(),
    razorpayConfigured: razorpayUtil.isConfigured()
  });
}));

// ---- Database backups ----
router.get('/backups', asyncRoute(async (req, res) => {
  res.json({ backups: listBackups() });
}));

router.post('/backups/run', asyncRoute(async (req, res) => {
  const backup = await runBackup();
  await record(req, 'backup created', 'backup', backup.file, null, backup);
  res.status(201).json({ backup });
}));

// Manual "run now" triggers for the background jobs — same functions the
// server's own setInterval timers call, exposed here so an admin (or a
// tester) doesn't have to wait for the next scheduled tick.
router.post('/jobs/wishlist-alerts/run', asyncRoute(async (req, res) => {
  res.json({ result: await checkWishlistAlerts() });
}));
router.post('/jobs/abandoned-cart/run', asyncRoute(async (req, res) => {
  res.json({ result: await checkAbandonedCarts() });
}));
router.post('/jobs/low-stock/run', asyncRoute(async (req, res) => {
  res.json({ result: await checkLowStock() });
}));
router.post('/jobs/prebook/run', asyncRoute(async (req, res) => {
  res.json({ result: await checkPrebookNotifications() });
}));

// Manual "Notify Now" for one saree/colour — same send logic as the
// background job, scoped to a single variant so it can't ping anyone
// pre-booked on a different saree that also happens to be in stock.
router.post('/prebooks/:variantId(\\d{1,9})/notify', asyncRoute(async (req, res) => {
  const variantId = Number(req.params.variantId);
  const variant = must(await supabase.from('product_variants').select('stock').eq('id', variantId).maybeSingle(), 'notifyPrebook:lookup');
  if (!variant) return res.status(404).json({ message: 'Variant not found.' });
  if (variant.stock <= 0) return res.status(400).json({ message: 'This colour is still out of stock — nothing to notify.' });

  const result = await checkPrebookNotifications(variantId);
  if (!result.sent) return res.status(400).json({ message: 'Everyone who pre-booked this colour has already been notified.' });
  res.json({ message: `Notified ${result.sent} customer${result.sent === 1 ? '' : 's'}.`, result });
}));

// Pre-Book demand — grouped by variant so "14 people want this back" reads
// at a glance, with each requester's email/date available underneath.
router.get('/prebooks', asyncRoute(async (req, res) => {
  const rows = must(await supabase.from('prebook_requests').select('*').order('created_at', { ascending: false }), 'prebooks:rows');
  const variantIds = [...new Set(rows.map(r => r.variant_id))];
  const variants = variantIds.length ? must(await supabase.from('product_variants').select('id, product_id, color_name, stock').in('id', variantIds), 'prebooks:variants') : [];
  const variantById = Object.fromEntries(variants.map(v => [v.id, v]));
  const productIds = [...new Set(variants.map(v => v.product_id))];
  const products = productIds.length ? must(await supabase.from('products').select('id, name').in('id', productIds), 'prebooks:products') : [];
  const nameById = Object.fromEntries(products.map(p => [p.id, p.name]));

  const groups = new Map();
  rows.forEach(r => {
    const variant = variantById[r.variant_id];
    if (!variant) return;
    const key = r.variant_id;
    if (!groups.has(key)) {
      groups.set(key, {
        variantId: r.variant_id, productId: variant.product_id, productName: nameById[variant.product_id] || '',
        colorName: variant.color_name, stock: variant.stock, requests: []
      });
    }
    groups.get(key).requests.push({ email: r.email, name: r.name, createdAt: r.created_at, notified: !!r.notified });
  });

  const groupList = Array.from(groups.values()).sort((a, b) => b.requests.length - a.requests.length);
  res.json({ groups: groupList });
}));

router.get('/backups/:file/download', asyncRoute(async (req, res) => {
  // Reject anything that isn't a bare filename we generated ourselves —
  // no path separators, no traversal, before it ever touches the filesystem.
  const file = req.params.file;
  if (!/^padmora-[\w-]+\.json$/.test(file)) return res.status(400).json({ message: 'Invalid backup file.' });
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ message: 'Backup not found.' });
  res.download(full);
}));

router.put('/orders/:id/refund', asyncRoute(async (req, res) => {
  const { refundStatus } = req.body;
  const allowed = ['Pending', 'Processed', 'Not Applicable'];
  if (!allowed.includes(refundStatus)) {
    return res.status(400).json({ message: 'refundStatus must be one of: ' + allowed.join(', ') });
  }
  const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle(), 'setRefundStatus:lookup');
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  if (!order.cancelled_at) return res.status(400).json({ message: 'Only cancelled orders have a refund to manage.' });

  must(await supabase.from('orders').update({ refund_status: refundStatus }).eq('id', order.id), 'setRefundStatus:update');
  res.json({ message: 'Refund status updated.' });
}));

// Refunds a cancelled, prepaid order to the customer's original payment method
// through Razorpay. Additive to the manual refund-status dropdown above (which
// stays as the fallback for legacy/COD orders with no Razorpay payment id).
// Double-click safe: the order is "claimed" with a conditional update before
// the Razorpay call, and the claim is released if Razorpay rejects it.
router.post('/orders/:id/refund/razorpay', asyncRoute(async (req, res) => {
  const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle(), 'rzpRefund:lookup');
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  if (!order.cancelled_at) return res.status(400).json({ message: 'Only cancelled orders can be refunded.' });
  if (order.payment === 'COD') return res.status(400).json({ message: 'This was a Cash on Delivery order — nothing was charged, so there is nothing to refund.' });
  if (!order.razorpay_payment_id) return res.status(400).json({ message: 'This order has no Razorpay payment on record — refund it manually from the Razorpay Dashboard, then mark it Processed here.' });
  if (order.razorpay_refund_id || order.refund_status === 'Processed') return res.status(409).json({ message: 'This order has already been refunded.' });
  if (!razorpayUtil.isConfigured()) return res.status(503).json({ message: 'Razorpay is not configured on the server.' });

  const claimed = must(await supabase.from('orders').update({ razorpay_refund_id: 'pending' })
    .eq('id', order.id).is('razorpay_refund_id', null).select('id'), 'rzpRefund:claim');
  if (!claimed.length) return res.status(409).json({ message: 'A refund for this order is already in progress.' });

  let refund;
  try {
    refund = await razorpayUtil.refundPayment(order.razorpay_payment_id, order.total, { order_id: order.id, reason: 'Order cancelled' }, 'rfnd-order-' + order.id);
  } catch (err) {
    await supabase.from('orders').update({ razorpay_refund_id: null }).eq('id', order.id);
    console.error(`[razorpay] Refund failed for order ${order.id}:`, err);
    return res.status(502).json({ message: 'Razorpay could not process this refund: ' + razorpayUtil.refundErrorMessage(err) });
  }

  must(await supabase.from('orders').update({
    razorpay_refund_id: refund.id, refund_amount: order.total, refund_processed_at: new Date().toISOString(), refund_status: 'Processed'
  }).eq('id', order.id), 'rzpRefund:save');
  await record(req, 'refunded via razorpay', 'order', order.id, { refundStatus: order.refund_status }, { refundStatus: 'Processed', razorpayRefundId: refund.id, amount: order.total });

  const updated = must(await supabase.from('orders').select('*').eq('id', order.id).single(), 'rzpRefund:reread');
  const [withExtras] = await attachOrderExtras([updated]);
  res.json({ message: 'Refund sent to Razorpay.', order: await shapeAdminOrder(withExtras, { full: true }) });
}));

// Deciding a pending cancellation request: approving here is the only place
// that actually cancels + restocks the order now (see routes/orders.js,
// which only ever writes a pending request, never cancels directly).
// Lets ONE more order inquiry be sent for this order (e.g. the customer wrote in through Contact Us, or only part of their first
// inquiry was approved). Reopens the inquiry window for the store's return-window days; the customer is e-mailed the link.
router.post('/orders/:id/allow-inquiry', asyncRoute(async (req, res) => {
  const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle(), 'allowInquiry:order');
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  if ((await computeStatus(order)) !== 'Delivered') return res.status(400).json({ message: 'Order inquiries open once the order has been delivered.' });
  const policy = await getReturnPolicy();
  if (!policy.enabled) return res.status(400).json({ message: 'Returns are switched off in Settings, so no inquiry can be sent.' });
  const rows = must(await supabase.from('return_requests').select('id, status').eq('order_id', order.id), 'allowInquiry:requests');
  if (rows.some(r => ['Requested', 'Approved', 'Received'].includes(r.status))) {
    return res.status(400).json({ message: 'An inquiry for this order is still being handled. Finish it in Returns first.' });
  }
  const taken = rows.filter(r => r.status !== 'Rejected').map(r => r.id);
  const takenItems = taken.length ? must(await supabase.from('return_request_items').select('order_item_id').in('return_id', taken), 'allowInquiry:taken') : [];
  const orderItems = must(await supabase.from('order_items').select('id').eq('order_id', order.id), 'allowInquiry:items');
  if (orderItems.length && orderItems.every(i => takenItems.some(t => t.order_item_id === i.id))) {
    return res.status(400).json({ message: 'Every saree of this order is already part of an inquiry that was refunded, so there is nothing left to send.' });
  }

  const until = new Date(Date.now() + policy.windowDays * 864e5).toISOString();
  const credits = Number(order.extra_inquiries || 0) > 0 && order.extra_inquiry_until && new Date(order.extra_inquiry_until).getTime() >= Date.now() ? Number(order.extra_inquiries) : 0;
  must(await supabase.from('orders').update({ extra_inquiries: credits + 1, extra_inquiry_until: until }).eq('id', order.id), 'allowInquiry:update');
  await record(req, 'allowed another inquiry', 'order', order.id, { extraInquiries: credits }, { extraInquiries: credits + 1, until });

  const customer = order.user_id ? must(await supabase.from('users').select('name, email').eq('id', order.user_id).maybeSingle(), 'allowInquiry:customer') : null;
  if (customer && customer.email) {
    const first = String(customer.name || '').trim().split(/\s+/)[0] || 'there';
    const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await sendEmail({
      to: customer.email, subject: `You can send another inquiry for order ${order.id}`, orderId: order.id, userId: order.user_id,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;color:#2b1015;">
        <h2 style="color:#7A1F2B;">Another inquiry is open for you</h2>
        <p>Hi ${esc(first)},</p>
        <p>Thank you for getting in touch. Our team has opened <strong>another inquiry</strong> for order <strong>${esc(order.id)}</strong>. You can send it here until ${esc(new Date(until).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }))}:</p>
        <p><a href="${esc(inquiryLink(order.id))}" style="display:inline-block;background:#ad3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-family:Arial,sans-serif;font-weight:bold;">Send my inquiry</a></p>
        <p style="font-size:12.5px;color:#8a6f6f;">You will find it under Account &rarr; Order History too (the Order Inquiry button on this order).</p>
      </div>`
    });
  }
  res.json({ ok: true, extraAllowed: credits + 1, extraUntil: until });
}));

router.put('/orders/:id/cancel-decision', asyncRoute(async (req, res) => {
  const { approve, adminNote } = req.body || {};
  const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle(), 'decideCancel:lookup');
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  if (order.cancel_request_status !== 'Requested') {
    return res.status(400).json({ message: 'No pending cancellation request for this order.' });
  }
  if (!approve && !(adminNote || '').trim()) {
    return res.status(400).json({ message: 'Add a note explaining why — the customer will see it.' });
  }

  const cleanNote = (adminNote || '').trim() || null;
  const reasonLabel = (CANCEL_REASONS.find(r => r.key === order.cancel_request_reason) || {}).label || order.cancel_request_reason;
  const fullReason = order.cancel_request_detail ? `${reasonLabel} — ${order.cancel_request_detail}` : reasonLabel;

  if (approve) {
    if (!(await isCancellable(order))) {
      return res.status(400).json({ message: 'This order has since shipped and can no longer be cancelled — reject the request instead.' });
    }
    const refundStatus = order.payment === 'COD' ? 'Not Applicable' : 'Pending';
    const rpc = await supabase.rpc('cancel_order', { p_order_id: order.id, p_reason: fullReason, p_refund_status: refundStatus });
    if (rpc.error) throw new Error(rpc.error.message);
    must(await supabase.from('orders').update({
      cancel_request_status: 'Approved', cancel_decided_at: new Date().toISOString(), cancel_admin_note: cleanNote
    }).eq('id', order.id), 'decideCancel:approve');
  } else {
    must(await supabase.from('orders').update({
      cancel_request_status: 'Rejected', cancel_decided_at: new Date().toISOString(), cancel_admin_note: cleanNote
    }).eq('id', order.id), 'decideCancel:reject');
  }

  await record(req, approve ? 'approved' : 'rejected', 'order_cancel_request', order.id, { cancelRequestStatus: order.cancel_request_status }, { cancelRequestStatus: approve ? 'Approved' : 'Rejected', adminNote: cleanNote });

  const customer = must(await supabase.from('users').select('name, email').eq('id', order.user_id).maybeSingle(), 'decideCancel:customer');
  if (customer && customer.email) {
    await sendEmail({
      to: customer.email,
      subject: approve ? `Order ${order.id} has been cancelled` : `Update on your cancellation request for order ${order.id}`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A1F2B;">${approve ? 'Order cancelled' : 'Cancellation request update'}</h2>
        <p>Hi ${customer.name || 'there'},</p>
        <p>${approve
          ? `Your order <strong>${order.id}</strong> has been cancelled as requested.${order.payment === 'COD' ? '' : ' Your refund will be processed shortly.'}`
          : `We're not able to cancel your order <strong>${order.id}</strong> right now.`}</p>
        ${cleanNote ? `<p style="color:#6f5a5c;">Note from our team: ${cleanNote}</p>` : ''}
      </div>`,
      orderId: order.id,
      userId: order.user_id
    });
  }

  const updated = must(await supabase.from('orders').select('*').eq('id', order.id).single(), 'decideCancel:reread');
  res.json({ order: await shapeAdminOrder(updated, { full: true }) });
}));

// ---- Returns & Refunds (post-delivery) ----
// A deliberately linear state machine, matching how a small store actually
// runs this: Requested -> Approved/Rejected -> (Approved only) Received ->
// Refunded. Refund can only happen after Received on purpose — money never
// moves before the returned saree has actually been inspected.
// The other requests of the same inquiry (same order + attempt): when only some sarees are acted on they are split off into their own
// "part", so one inquiry can be several requests, each with its own status.
async function loadReturnSiblings(rows) {
  const orderIds = [...new Set(rows.map(r => r.order_id))];
  if (!orderIds.length) return {};
  const all = await fetchAllByIds(orderIds, c => supabase.from('return_requests').select('id, order_id, attempt, part, status').in('order_id', c).order('id'), 'returnSiblings');
  const out = {};
  all.forEach(x => { const k = x.order_id + ':' + (x.attempt || 1); (out[k] || (out[k] = [])).push({ id: x.id, part: x.part || 1, status: x.status }); });
  return out;
}

// Everything the Returns screen needs about a set of requests, read in a handful of queries (not five per request).
async function loadReturnContext(rows) {
  const ids = rows.map(r => r.id);
  const orderIds = [...new Set(rows.map(r => r.order_id))];
  const userIds = [...new Set(rows.map(r => r.user_id))];
  const [orders, users, items, photos] = await Promise.all([
    orderIds.length ? fetchAllByIds(orderIds, c => supabase.from('orders').select('id, total, payment, subtotal, discount, address_name, address_line1, address_city, address_state, address_pincode, address_phone').in('id', c).order('id'), 'returnCtx:orders') : [],
    userIds.length ? fetchAllByIds(userIds, c => supabase.from('users').select('id, name, email, phone').in('id', c).order('id'), 'returnCtx:users') : [],
    ids.length ? fetchAllByIds(ids, c => supabase.from('return_request_items').select('id, return_id, qty, order_item_id').in('return_id', c).order('id'), 'returnCtx:items') : [],
    ids.length ? fetchAllByIds(ids, c => supabase.from('return_request_photos').select('id, return_id, url').in('return_id', c).order('id'), 'returnCtx:photos') : []
  ]);
  const orderItemIds = [...new Set(items.map(i => i.order_item_id))];
  const orderItems = orderItemIds.length ? await fetchAllByIds(orderItemIds, c => supabase.from('order_items').select('id, name, color, price, variant_id').in('id', c).order('id'), 'returnCtx:orderItems') : [];
  const group = (list, key) => { const out = {}; list.forEach(x => (out[x[key]] || (out[x[key]] = [])).push(x)); return out; };
  return {
    orderById: Object.fromEntries(orders.map(o => [o.id, o])),
    userById: Object.fromEntries(users.map(u => [u.id, u])),
    itemsByReturn: group(items, 'return_id'),
    photosByReturn: group(photos, 'return_id'),
    orderItemById: Object.fromEntries(orderItems.map(oi => [oi.id, oi]))
  };
}

async function shapeAdminReturn(r, siblingsMap, context) {
  const sibMap = siblingsMap || await loadReturnSiblings([r]);
  const ctx = context || await loadReturnContext([r]);
  const siblings = (sibMap[r.order_id + ':' + (r.attempt || 1)] || []).sort((a, b) => a.part - b.part);
  const order = ctx.orderById[r.order_id] || null;
  const customer = ctx.userById[r.user_id] || null;
  const returnItems = ctx.itemsByReturn[r.id] || [];
  const orderItemById = ctx.orderItemById;
  const photos = ctx.photosByReturn[r.id] || [];
  return {
    id: r.id,
    orderId: r.order_id,
    attempt: r.attempt || 1,
    part: r.part || 1,
    partCount: siblings.length || 1,
    siblings,
    maxAttempts: Math.max(INQUIRY_MAX_ATTEMPTS, r.attempt || 1),
    orderTotal: order ? order.total : null,
    orderPayment: order ? order.payment : null,
    customerName: customer ? customer.name : null,
    customerEmail: customer ? publicEmail(customer.email) : null,
    customerPhone: customer ? customer.phone : null,
    // where the order was delivered (and where a return pickup would be arranged)
    address: order ? { name: order.address_name, line1: order.address_line1, city: order.address_city, state: order.address_state, pincode: order.address_pincode, phone: order.address_phone } : null,
    reason: r.reason,
    reasonLabel: (RETURN_REASONS.find(x => x.key === r.reason) || {}).label || r.reason,
    reasonCategory: r.reason_category,
    reasonDetail: r.reason_detail,
    status: r.status,
    refundMethod: r.refund_method,
    refundAccountDetail: r.refund_account_detail,
    computedRefundAmount: r.computed_refund_amount,
    finalRefundAmount: r.final_refund_amount,
    restock: r.restock === null ? null : !!r.restock,
    adminNote: r.admin_note,
    couponCode: r.coupon_code,
    items: returnItems.map(i => {
      const oi = orderItemById[i.order_item_id] || {};
      // refundShare: what this line is worth back to the customer (its price less its share of the order discount) - the admin screen adds
      // up the ticked lines to suggest an amount
      const value = (oi.price || 0) * i.qty;
      const share = order && order.subtotal > 0 ? Math.round((order.discount || 0) * value / order.subtotal) : 0;
      return { returnItemId: i.id, orderItemId: i.order_item_id, name: oi.name, color: oi.color, price: oi.price, qty: i.qty, variantId: oi.variant_id, refundShare: Math.max(0, value - share) };
    }),
    photos: photos.map(p => ({ id: p.id, url: p.url })),
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    receivedAt: r.received_at,
    refundedAt: r.refunded_at
  };
}

router.get('/returns', asyncRoute(async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('return_requests').select('*').order('requested_at', { ascending: false });
  if (status && status !== 'all') query = query.eq('status', status);
  const rows = must(await query, 'listReturns');
  const [sibs, ctx] = await Promise.all([loadReturnSiblings(rows), loadReturnContext(rows)]);
  res.json({ returns: await Promise.all(rows.map(r => shapeAdminReturn(r, sibs, ctx))) });
}));

router.get('/returns/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const row = must(await supabase.from('return_requests').select('*').eq('id', req.params.id).maybeSingle(), 'getAdminReturn');
  if (!row) return res.status(404).json({ message: 'Return request not found.' });
  res.json({ return: await shapeAdminReturn(row) });
}));

// Acting on only SOME of a request's sarees. The chosen sarees are split off into their own request (a new "part" of the same
// inquiry, with the same status so far) and the action then applies to that part; the sarees not chosen stay behind in the original
// request, still waiting, still listed and still counted. Nothing chosen = the whole request, as before.
// -> { row, split } or { error: { status, message } }
async function resolveReturnTarget(existing, itemIds, opts = {}) {
  if (itemIds === undefined || itemIds === null) return { row: existing, split: false };
  if (!Array.isArray(itemIds) || !itemIds.length) return { error: { status: 400, message: 'Tick at least one saree.' } };
  const items = must(await supabase.from('return_request_items').select('id, order_item_id, qty').eq('return_id', existing.id), 'returnPart:items');
  const wanted = new Set(itemIds.map(Number));
  const chosen = items.filter(i => wanted.has(i.id));
  if (chosen.length !== wanted.size) return { error: { status: 400, message: 'Some of those sarees are no longer in this request. Refresh the page and try again.' } };
  if (chosen.length === items.length) return { row: existing, split: false };
  if (opts.blockIfRefundStarted && existing.razorpay_refund_id) {
    return { error: { status: 409, message: 'A refund for this request has already been started. Finish it for all of its sarees first.' } };
  }

  const order = must(await supabase.from('orders').select('subtotal, discount').eq('id', existing.order_id).maybeSingle(), 'returnPart:order');
  const orderItems = must(await supabase.from('order_items').select('id, price').in('id', chosen.map(i => i.order_item_id)), 'returnPart:orderItems');
  const priceById = Object.fromEntries(orderItems.map(oi => [oi.id, oi.price]));
  const partRefund = computeReturnRefund(order || {}, chosen.map(i => ({ price: priceById[i.order_item_id] || 0, qty: i.qty })), false, existing.reason_category);
  const restRefund = Math.max(0, (existing.computed_refund_amount || 0) - partRefund);   // the rest keeps whatever else the request was worth (e.g. shipping)

  const rpc = await supabase.rpc('split_return_request', {
    p_return_id: existing.id, p_order_item_ids: chosen.map(i => i.order_item_id), p_part_refund: partRefund, p_rest_refund: restRefund, p_expected_status: existing.status
  });
  if (rpc.error) {
    if (/already been updated|none of those items/i.test(rpc.error.message)) return { error: { status: 409, message: 'Someone has just updated this request. Refresh the page and try again.' } };
    throw new Error(rpc.error.message);
  }
  const row = must(await supabase.from('return_requests').select('*').eq('id', rpc.data).single(), 'returnPart:reread');
  return { row, split: row.id !== existing.id };
}

// "Saree A, Saree B" for the e-mail a customer gets about part of an inquiry
async function returnItemsText(returnId) {
  const items = must(await supabase.from('return_request_items').select('order_item_id').eq('return_id', returnId), 'returnItemsText:items');
  if (!items.length) return '';
  const oi = must(await supabase.from('order_items').select('id, name, color').in('id', items.map(i => i.order_item_id)), 'returnItemsText:orderItems');
  return oi.map(x => x.name + (x.color ? ' (' + x.color + ')' : '')).join(', ');
}

router.put('/returns/:id(\\d{1,9})/decision', asyncRoute(async (req, res) => {
  const { approve, adminNote, itemIds } = req.body || {};
  const existing = must(await supabase.from('return_requests').select('*').eq('id', req.params.id).maybeSingle(), 'decideReturn:lookup');
  if (!existing) return res.status(404).json({ message: 'Return request not found.' });
  if (existing.status !== 'Requested') return res.status(400).json({ message: 'This request has already been decided.' });
  if (!approve && !(adminNote || '').trim()) {
    return res.status(400).json({ message: "Add a note explaining why — the customer will see it." });
  }

  const target = await resolveReturnTarget(existing, itemIds);
  if (target.error) return res.status(target.error.status).json({ message: target.error.message });
  const row = target.row;

  const nextStatus = approve ? 'Approved' : 'Rejected';
  must(await supabase.from('return_requests').update({
    status: nextStatus, admin_note: (adminNote || '').trim() || null, decided_at: new Date().toISOString()
  }).eq('id', row.id).eq('status', 'Requested'), 'decideReturn:update');
  await record(req, approve ? 'approved' : 'rejected', 'return_request', row.id, { status: existing.status }, { status: nextStatus, adminNote, part: row.part || 1, splitFrom: target.split ? existing.id : undefined });

  const customer = must(await supabase.from('users').select('name, email').eq('id', row.user_id).maybeSingle(), 'decideReturn:customer');
  if (customer && customer.email) {
    const sibs = must(await supabase.from('return_requests').select('id, status').eq('order_id', row.order_id).eq('attempt', row.attempt), 'decideReturn:siblings');
    const partial = sibs.length > 1;
    const mail = decisionEmail({
      approve: !!approve, name: customer.name, orderId: row.order_id, adminNote: (adminNote || '').trim(), attempt: row.attempt,
      itemsText: partial ? await returnItemsText(row.id) : '',
      // a second chance is offered only when nothing of the inquiry was approved
      allRejected: sibs.every(x => x.status === 'Rejected')
    });
    await sendEmail({ to: customer.email, subject: mail.subject, html: mail.html, orderId: row.order_id, userId: row.user_id });
  }

  const updated = must(await supabase.from('return_requests').select('*').eq('id', row.id).single(), 'decideReturn:reread');
  res.json({ return: await shapeAdminReturn(updated), split: target.split });
}));

router.put('/returns/:id(\\d{1,9})/receive', asyncRoute(async (req, res) => {
  const { itemRestock, itemIds } = req.body || {}; // itemRestock: { [returnItemId]: true/false }
  const existing = must(await supabase.from('return_requests').select('*').eq('id', req.params.id).maybeSingle(), 'receiveReturn:lookup');
  if (!existing) return res.status(404).json({ message: 'Return request not found.' });
  if (existing.status !== 'Approved') return res.status(400).json({ message: 'Only an approved return can be marked received.' });

  const target = await resolveReturnTarget(existing, itemIds);
  if (target.error) return res.status(target.error.status).json({ message: target.error.message });
  const row = target.row;

  const rpc = await supabase.rpc('return_mark_received', {
    p_return_id: row.id, p_item_restock: itemRestock || {}, p_changed_by: req.adminName
  });
  if (rpc.error) throw new Error(rpc.error.message);

  await record(req, 'marked received', 'return_request', row.id, { status: existing.status }, { status: 'Received', restocked: rpc.data, part: row.part || 1, splitFrom: target.split ? existing.id : undefined });
  const updated = must(await supabase.from('return_requests').select('*').eq('id', row.id).single(), 'receiveReturn:reread');
  res.json({ return: await shapeAdminReturn(updated), split: target.split });
}));

router.put('/returns/:id(\\d{1,9})/refund', asyncRoute(async (req, res) => {
  const { refundMethod, finalAmount, itemIds } = req.body || {};
  const first = must(await supabase.from('return_requests').select('*').eq('id', req.params.id).maybeSingle(), 'refundReturn:lookup');
  if (!first) return res.status(404).json({ message: 'Return request not found.' });
  if (first.status !== 'Received') return res.status(400).json({ message: 'Only a received return can be refunded.' });

  const method = refundMethod || first.refund_method;
  if (!['original', 'bank_transfer', 'store_credit'].includes(method)) {
    return res.status(400).json({ message: 'Invalid refund method.' });
  }
  if (finalAmount != null && (!Number.isFinite(Number(finalAmount)) || Number(finalAmount) < 0)) {
    return res.status(400).json({ message: 'Enter a valid refund amount.' });
  }

  const target = await resolveReturnTarget(first, itemIds, { blockIfRefundStarted: true });
  if (target.error) return res.status(target.error.status).json({ message: target.error.message });
  const existing = target.row;   // the sarees being refunded (a part split off the request, or the whole request)
  const amount = finalAmount != null ? Number(finalAmount) : existing.computed_refund_amount;
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ message: 'Enter a valid refund amount.' });
  }

  // "Original payment method" on a Razorpay-paid order means a real Razorpay
  // refund, sent BEFORE the return is marked Refunded. If a previous attempt
  // already sent it (razorpay_refund_id saved) but the bookkeeping below
  // failed, a retry skips straight to the bookkeeping instead of paying twice.
  // Orders with no Razorpay payment on record keep the old manual behaviour.
  let rzpRefundId = null;
  if (method === 'original' && amount > 0) {
    const order = must(await supabase.from('orders').select('id, payment, razorpay_payment_id').eq('id', existing.order_id).maybeSingle(), 'refundReturn:order');
    if (order && order.razorpay_payment_id && order.payment !== 'COD') {
      if (existing.razorpay_refund_id === 'pending') {
        return res.status(409).json({ message: 'A refund for this return is already in progress.' });
      }
      rzpRefundId = existing.razorpay_refund_id;
      if (!rzpRefundId) {
        if (!razorpayUtil.isConfigured()) return res.status(503).json({ message: 'Razorpay is not configured on the server.' });
        const claimed = must(await supabase.from('return_requests').update({ razorpay_refund_id: 'pending' })
          .eq('id', existing.id).is('razorpay_refund_id', null).select('id'), 'refundReturn:claim');
        if (!claimed.length) return res.status(409).json({ message: 'A refund for this return is already in progress.' });
        try {
          const refund = await razorpayUtil.refundPayment(order.razorpay_payment_id, amount, { order_id: order.id, return_id: String(existing.id), reason: 'Return refund' }, 'rfnd-return-' + existing.id);
          rzpRefundId = refund.id;
        } catch (err) {
          await supabase.from('return_requests').update({ razorpay_refund_id: null }).eq('id', existing.id);
          console.error(`[razorpay] Refund failed for return ${existing.id}:`, err);
          return res.status(502).json({ message: 'Razorpay could not process this refund: ' + razorpayUtil.refundErrorMessage(err) });
        }
        // Money has moved — record the id; if even this fails, say so loudly rather than lose it.
        const saved = await supabase.from('return_requests').update({ razorpay_refund_id: rzpRefundId }).eq('id', existing.id);
        if (saved.error) console.error(`[razorpay] Refund ${rzpRefundId} sent for return ${existing.id} but could not be saved:`, saved.error);
      }
    }
  }

  let couponCode;
  try {
    const rpc = await supabase.rpc('process_return_refund', {
      p_return_id: existing.id, p_order_id: existing.order_id, p_method: method, p_amount: amount
    });
    if (rpc.error) throw new Error(rpc.error.message);
    couponCode = rpc.data;
  } catch (e) {
    const already = rzpRefundId ? ` The money was already sent via Razorpay (refund ${rzpRefundId}) — press Process Refund again to finish recording it; it won't be paid twice.` : '';
    return res.status(500).json({ message: 'Could not process refund: ' + e.message + already });
  }

  await record(req, 'refunded', 'return_request', existing.id, { status: existing.status }, { status: 'Refunded', method, amount, couponCode, razorpayRefundId: rzpRefundId, part: existing.part || 1, splitFrom: target.split ? first.id : undefined });

  const customer = must(await supabase.from('users').select('name, email').eq('id', existing.user_id).maybeSingle(), 'refundReturn:customer');
  if (customer && customer.email) {
    await sendEmail({
      to: customer.email,
      subject: `Your refund for order ${existing.order_id} is on its way`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A1F2B;">Refund processed</h2>
        <p>Hi ${customer.name || 'there'},</p>
        <p>We've processed a refund of <strong>₹${amount}</strong> for your return on order <strong>${existing.order_id}</strong>.</p>
        ${method === 'store_credit'
          ? `<p>This has been issued as store credit — use code <strong>${couponCode}</strong> at checkout on your next order.</p>`
          : method === 'bank_transfer'
            ? `<p>This will be transferred to the bank/UPI details you provided within a few business days.</p>`
            : `<p>This will reflect back on your original payment method within a few business days.</p>`}
      </div>`,
      orderId: existing.order_id,
      userId: existing.user_id
    });
  }

  const updated = must(await supabase.from('return_requests').select('*').eq('id', existing.id).single(), 'refundReturn:reread');
  res.json({ return: await shapeAdminReturn(updated), split: target.split });
}));

// ---- Product pricing & profit ----
// What the product form needs to show Shipping / GST / Final CP / margin / Final selling price while the admin types a buying
// price. Not the Super Admin settings screen itself (that is /settings/profit): anyone who may edit products needs these numbers.
router.get('/products/pricing-config', asyncRoute(async (req, res) => {
  res.json({ settings: await profit.getProfitSettings() });
}));

router.get('/settings/profit', asyncRoute(async (req, res) => {
  res.json({ settings: await profit.getProfitSettings(), defaults: profit.DEFAULTS });
}));

router.put('/settings/profit', asyncRoute(async (req, res) => {
  const checked = profit.validateSettings(req.body);
  if (checked.error) return res.status(400).json({ message: checked.error });
  const before = await profit.getProfitSettings();
  await setSetting('profit_settings', checked.value);
  await record(req, 'settings updated', 'profit_settings', null, before, checked.value);
  res.json({ settings: checked.value });
}));

// "Update prices of existing sarees": the settings only apply to a colour when it is saved. This lists what would change if
// every colour that has a buying price were worked out again with today's settings, and (apply: true) does it.
async function repricePlan() {
  const settings = await profit.getProfitSettings();
  const variants = await fetchAllRows(() => supabase.from('product_variants').select('id, product_id, color_name, price, mrp, cost_price, final_cp, margin_pct, price_manual')
    .eq('archived', false).not('cost_price', 'is', null).order('id'), 'reprice:variants');
  const productIds = [...new Set(variants.map(v => v.product_id))];
  const products = productIds.length ? await fetchAllByIds(productIds, c => supabase.from('products').select('id, name, badge').in('id', c).order('id'), 'reprice:products') : [];
  const productById = Object.fromEntries(products.map(p => [p.id, p]));
  const items = [];
  for (const v of variants) {
    const pricing = profit.computePricing(Number(v.cost_price), settings);
    if (!pricing) continue;
    const onSale = (productById[v.product_id] || {}).badge === 'sale';
    const pct = onSale && v.mrp > v.price ? Math.round((1 - v.price / v.mrp) * 100) : 0;
    // a price the admin typed by hand stays; only its cost figures are refreshed
    const manual = !!v.price_manual;
    const newMrp = manual ? v.mrp : pricing.sellingPrice;
    const newPrice = manual ? v.price : (pct ? Math.max(1, Math.round(newMrp * (100 - pct) / 100)) : newMrp);
    const same = newPrice === v.price && newMrp === v.mrp && Number(v.final_cp) === pricing.finalCp && Number(v.margin_pct) === pricing.marginPct;
    if (same) continue;
    items.push({
      variantId: v.id, productId: v.product_id, product: (productById[v.product_id] || {}).name || '', colour: v.color_name, buyingPrice: Number(v.cost_price), manual,
      oldPrice: v.price, newPrice, oldFinalCp: v.final_cp != null ? Number(v.final_cp) : null, newFinalCp: pricing.finalCp, oldMargin: v.margin_pct != null ? Number(v.margin_pct) : null, newMargin: pricing.marginPct,
      columns: { price: newPrice, mrp: newMrp, ...profit.variantCostColumns(pricing, manual) }
    });
  }
  return { settings, items, total: variants.length };
}

router.post('/settings/profit/reprice', asyncRoute(async (req, res) => {
  const plan = await repricePlan();
  const shown = plan.items.map(({ columns, ...rest }) => rest);
  if (!(req.body && req.body.apply === true)) return res.json({ total: plan.total, changes: shown.length, items: shown.slice(0, 300) });
  for (const it of plan.items) must(await supabase.from('product_variants').update(it.columns).eq('id', it.variantId), 'reprice:update');
  for (const pid of [...new Set(plan.items.map(i => i.productId))]) await syncProductMirrorFromDefaultVariant(pid);
  if (plan.items.length) await record(req, 'prices recalculated', 'profit_settings', null, null, { colours: plan.items.length, settings: plan.settings });
  res.json({ updated: plan.items.length, total: plan.total });
}));

// Net profit for the Overview (Super Admin only - see PATH_SCOPES).
router.get('/analytics/profit', asyncRoute(async (req, res) => {
  const range = String(req.query.range || 'all');
  if (!['all', 'today', '7', '30', 'month'].includes(range)) return res.status(400).json({ message: 'Choose a valid period.' });
  res.json(await profit.loadProfitReport(range));
}));

// ---- Tracking settings ----
router.get('/settings/tracking', asyncRoute(async (req, res) => {
  const { mode, since } = await getTrackingMode();
  res.json({ timing: await getSetting('tracking_timing', {}), mode, since: since ? new Date(since).toISOString() : null });
}));

router.put('/settings/tracking', asyncRoute(async (req, res) => {
  const { timing, mode } = req.body;
  if (mode !== undefined && !['manual', 'simulated'].includes(mode)) return res.status(400).json({ message: 'Invalid tracking mode.' });
  if (timing !== undefined) {
    if (!timing || typeof timing !== 'object') return res.status(400).json({ message: 'A timing object is required.' });
    for (const stage of STAGE_NAMES) {
      if (timing[stage] === undefined || isNaN(Number(timing[stage])) || Number(timing[stage]) < 0) {
        return res.status(400).json({ message: `Enter a valid hour count for "${stage}".` });
      }
    }
    await setSetting('tracking_timing', STAGE_NAMES.reduce((acc, s) => ({ ...acc, [s]: Number(timing[s]) }), {}));
  }
  if (mode) {
    const current = await getTrackingMode();
    // Staying on manual keeps the original cut-off; switching to it starts a new one,
    // so orders placed before today keep behaving exactly as they did.
    const since = mode === 'manual' ? (current.mode === 'manual' && current.since ? new Date(current.since).toISOString() : new Date().toISOString()) : null;
    await setSetting('tracking_mode', { mode, since });
    clearTrackingModeCache();
    await record(req, 'tracking mode changed', 'settings', 'tracking_mode', { mode: current.mode }, { mode });
  }
  const now = await getTrackingMode();
  res.json({ timing: await getSetting('tracking_timing', {}), mode: now.mode, since: now.since ? new Date(now.since).toISOString() : null });
}));

// ---- Is Razorpay set up correctly on THIS server? (Super Admin only: it sits under /settings) ----
router.post('/settings/razorpay-check', asyncRoute(async (req, res) => {
  res.json(await razorpayUtil.checkConnection());
}));

// ---- Store / Shipping settings (Phase 7) ----
router.get('/settings/store', asyncRoute(async (req, res) => {
  res.json({ store: await getSetting('store_info', {}) });
}));

router.put('/settings/store', asyncRoute(async (req, res) => {
  const { brandName, logoUrl, faviconUrl, contactEmail, contactPhone, whatsapp, instagram, youtube, shipperAddress } = req.body || {};
  if (!brandName || !String(brandName).trim()) {
    return res.status(400).json({ message: 'Brand name is required.' });
  }
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return res.status(400).json({ message: 'Enter a valid contact email.' });
  }
  const before = await getSetting('store_info', {});
  const next = {
    brandName: String(brandName).trim(),
    logoUrl: logoUrl || '', faviconUrl: faviconUrl || '',
    contactEmail: contactEmail || '', contactPhone: contactPhone || '',
    whatsapp: whatsapp || '', instagram: instagram || '', youtube: youtube || '',
    shipperAddress: String(shipperAddress || '').replace(/\r/g, '').trim().slice(0, 400)
  };
  await setSetting('store_info', next);
  await record(req, 'settings updated', 'store_info', null, before, next);
  res.json({ store: next });
}));

router.get('/settings/footer', asyncRoute(async (req, res) => {
  res.json({ footer: await getSetting('footer_config', DEFAULT_FOOTER), defaults: DEFAULT_FOOTER });
}));

router.put('/settings/footer', asyncRoute(async (req, res) => {
  const { value, error } = validateFooter(req.body);
  if (error) return res.status(400).json({ message: error });
  const before = await getSetting('footer_config', DEFAULT_FOOTER);
  await setSetting('footer_config', value);
  await record(req, 'settings updated', 'footer_config', null, before, value);
  res.json({ footer: value });
}));

router.get('/settings/shipping', asyncRoute(async (req, res) => {
  res.json({ shipping: await getSetting('shipping_settings', {}) });
}));

router.put('/settings/shipping', asyncRoute(async (req, res) => {
  const { fee, freeShippingThreshold, regions, estimatedDays } = req.body || {};
  if (isNaN(Number(fee)) || Number(fee) < 0) {
    return res.status(400).json({ message: 'Shipping fee must be a non-negative number.' });
  }
  if (isNaN(Number(freeShippingThreshold)) || Number(freeShippingThreshold) < 0) {
    return res.status(400).json({ message: 'Free-shipping threshold must be a non-negative number.' });
  }
  const before = await getSetting('shipping_settings', {});
  const next = {
    fee: Number(fee),
    freeShippingThreshold: Number(freeShippingThreshold),
    regions: Array.isArray(regions) ? regions.filter(Boolean) : (before.regions || ['All India']),
    estimatedDays: estimatedDays || before.estimatedDays || ''
  };
  await setSetting('shipping_settings', next);
  await record(req, 'settings updated', 'shipping_settings', null, before, next);
  res.json({ shipping: next });
}));

// ---- "Please review your saree" e-mail (sent a few days after delivery) ----
router.get('/settings/review-reminder', asyncRoute(async (req, res) => {
  const cfg = await reviewReminders.getConfig();
  res.json({ reminder: { enabled: cfg.enabled, days: cfg.days }, emailConfigured: emailConfigured() });
}));

router.put('/settings/review-reminder', asyncRoute(async (req, res) => {
  const days = Number(req.body && req.body.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) return res.status(400).json({ message: 'Choose a number of days between 1 and 30.' });
  const before = await reviewReminders.getConfig();
  const next = { enabled: !!(req.body && req.body.enabled), days, since: before.since || undefined };
  await setSetting('review_reminder', next);
  await record(req, 'settings updated', 'review_reminder', null, { enabled: before.enabled, days: before.days }, { enabled: next.enabled, days: next.days });
  res.json({ reminder: { enabled: next.enabled, days: next.days } });
}));

// Sends the reminder to an address you type, using a recent real order's sarees, so you can see exactly what customers get.
router.post('/settings/review-reminder/test', asyncRoute(async (req, res) => {
  const to = String((req.body && req.body.to) || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ message: 'Enter a valid e-mail address to send the preview to.' });
  if (!emailConfigured()) return res.status(400).json({ message: 'E-mail is not set up yet (SMTP settings), so nothing can be sent.' });
  const lastOrder = must(await supabase.from('orders').select('id').order('placed_at', { ascending: false }).limit(1), 'reminderTest:order')[0];
  const lines = lastOrder ? must(await supabase.from('order_items').select('id, name, color, variant_id').eq('order_id', lastOrder.id).limit(2), 'reminderTest:items') : [];
  if (!lines.length) return res.status(400).json({ message: 'There is no order yet to build a preview from.' });
  const images = await getPrimaryImagesByVariantIds(lines.map(l => l.variant_id).filter(Boolean));
  const mail = reviewReminders.buildReviewReminderEmail({ name: 'there', orderId: lastOrder.id, items: lines.map(l => ({ id: l.id, name: l.name, color: l.color, imageUrl: images[l.variant_id] || '' })) });
  const r = await sendEmail({ to, subject: '[Preview] ' + mail.subject, html: mail.html, text: mail.text });
  if (r.status !== 'sent') return res.status(502).json({ message: 'The preview could not be sent (' + (r.error || r.status) + ').' });
  res.json({ message: 'Preview sent to ' + to + '.' });
}));

router.get('/settings/return-policy', asyncRoute(async (req, res) => {
  res.json({ returnPolicy: await getSetting('return_policy', { enabled: true, windowDays: 7 }) });
}));

router.put('/settings/return-policy', asyncRoute(async (req, res) => {
  const { enabled, windowDays } = req.body || {};
  if (!Number.isFinite(Number(windowDays)) || Number(windowDays) < 0) {
    return res.status(400).json({ message: 'Return window must be a non-negative number of days.' });
  }
  const before = await getSetting('return_policy', {});
  const next = { enabled: !!enabled, windowDays: Number(windowDays) };
  await setSetting('return_policy', next);
  await record(req, 'settings updated', 'return_policy', null, before, next);
  res.json({ returnPolicy: next });
}));

// ---- Contact messages ----
router.get('/contact', asyncRoute(async (req, res) => {
  const messages = must(await supabase.from('contact_messages').select('*').order('created_at', { ascending: false }), 'listContact');
  res.json({ messages });
}));

router.put('/contact/:id(\\d{1,9})/read', asyncRoute(async (req, res) => {
  must(await supabase.from('contact_messages').update({ read: true }).eq('id', Number(req.params.id)), 'markContactRead');
  res.json({ message: 'Marked as read.' });
}));

router.put('/contact/:id(\\d{1,9})/reply', asyncRoute(async (req, res) => {
  const { reply } = req.body || {};
  const cleanReply = String(reply || '').trim();
  if (!cleanReply) return res.status(400).json({ message: 'Write a reply before sending.' });

  const existing = must(await supabase.from('contact_messages').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'replyContact:lookup');
  if (!existing) return res.status(404).json({ message: 'Message not found.' });

  const sent = await sendEmail({
    to: existing.email,
    subject: `Re: ${existing.subject}`,
    html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
      <h2 style="color:#7A1F2B;">A reply from Padmora</h2>
      <p>Hi ${existing.name || 'there'},</p>
      <p>${cleanReply.replace(/\n/g, '<br>')}</p>
      <p style="color:#6f5a5c;font-size:12px;margin-top:20px;">In reply to your message: "${existing.message}"</p>
    </div>`
  });

  must(await supabase.from('contact_messages').update({
    admin_reply: cleanReply, replied_at: new Date().toISOString(), read: true
  }).eq('id', existing.id), 'replyContact:update');
  await record(req, 'replied', 'contact_message', existing.id, null, { reply: cleanReply });

  const updated = must(await supabase.from('contact_messages').select('*').eq('id', existing.id).single(), 'replyContact:reread');
  res.json({
    message: sent.status === 'sent' ? 'Reply sent.' : 'Reply saved, but email delivery is not configured — the customer will not receive it by email.',
    contactMessage: updated
  });
}));

// ---- Fabrics / Weaves ----
router.get('/fabrics', asyncRoute(async (req, res) => {
  res.json({ fabrics: await getFabrics({ activeOnly: false }) });
}));

router.post('/fabrics', asyncRoute(async (req, res) => {
  const { name, slug, shortDesc, fullDesc, region, state, craftType, swatch, story } = req.body;
  if (!name || !slug) return res.status(400).json({ message: 'Name and slug are required.' });
  try {
    const maxOrder = must(await supabase.from('fabrics').select('display_order').order('display_order', { ascending: false }).limit(1), 'addFabric:maxOrder');
    const inserted = must(await supabase.from('fabrics').insert({
      name, slug, short_description: shortDesc || '', full_description: fullDesc || '', region: region || '', state: state || '',
      craft_type: craftType || 'Handloom', swatch: cleanSwatch(swatch) || 'maroon', story: story || '', active: true,
      display_order: (maxOrder[0]?.display_order ?? -1) + 1
    }).select().single(), 'addFabric:insert');
    res.status(201).json({ fabric: inserted });
  } catch (e) {
    res.status(400).json({ message: isUniqueViolation(e) ? 'That name or slug is already in use.' : e.message });
  }
}));

router.put('/fabrics/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('fabrics').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateFabric:lookup');
  if (!existing) return res.status(404).json({ message: 'Fabric not found.' });
  const { name, slug, shortDesc, fullDesc, region, state, craftType, swatch, story, active, displayOrder, heroImage, thumbnail } = req.body;
  const updated = must(await supabase.from('fabrics').update({
    name: name ?? existing.name, slug: slug ?? existing.slug, short_description: shortDesc ?? existing.short_description,
    full_description: fullDesc ?? existing.full_description, region: region ?? existing.region, state: state ?? existing.state,
    craft_type: craftType ?? existing.craft_type, swatch: cleanSwatch(swatch) ?? existing.swatch, story: story ?? existing.story,
    active: active !== undefined ? !!active : existing.active,
    display_order: displayOrder !== undefined ? Number(displayOrder) : existing.display_order,
    hero_image: heroImage !== undefined ? heroImage : existing.hero_image, thumbnail: thumbnail !== undefined ? thumbnail : existing.thumbnail
  }).eq('id', existing.id).select().single(), 'updateFabric:update');
  if (thumbnail === '' && existing.thumbnail) await removeUpload(existing.thumbnail);
  if (heroImage === '' && existing.hero_image) await removeUpload(existing.hero_image);
  res.json({ fabric: updated });
}));

router.delete('/fabrics/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('fabrics').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'deleteFabric:lookup');
  if (!existing) return res.status(404).json({ message: 'Fabric not found.' });
  const inUse = (await supabase.from('products').select('*', { count: 'exact', head: true }).eq('fabric', existing.name)).count || 0;
  if (inUse > 0) {
    must(await supabase.from('fabrics').update({ active: false }).eq('id', existing.id), 'deleteFabric:deactivate');
    return res.json({ message: `${inUse} product(s) still use "${existing.name}" — deactivated instead of deleted.`, deactivated: true });
  }
  must(await supabase.from('fabrics').delete().eq('id', existing.id), 'deleteFabric:delete');
  res.json({ message: 'Fabric deleted.', deactivated: false });
}));

// slot is 'hero' or 'thumbnail'
router.post('/fabrics/:id(\\d{1,9})/image', uploadSingle, asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('fabrics').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'fabricImage:lookup');
  if (!existing) return res.status(404).json({ message: 'Fabric not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const slot = req.body.slot === 'thumbnail' ? 'thumbnail' : 'hero_image';
  const updated = must(await supabase.from('fabrics').update({ [slot]: req.file.publicUrl }).eq('id', existing.id).select().single(), 'fabricImage:update');
  // The picture it replaces is deleted from storage so old photos don't pile up.
  if (existing[slot] && existing[slot] !== req.file.publicUrl) await removeUpload(existing[slot]);
  res.json({ fabric: updated });
}));

// ---- Occasions ----
router.get('/occasions', asyncRoute(async (req, res) => {
  res.json({ occasions: await getOccasions({ activeOnly: false }) });
}));

router.post('/occasions', asyncRoute(async (req, res) => {
  const { name, slug, description, featuredOnHome, homeCardTitle } = req.body;
  if (!name || !slug) return res.status(400).json({ message: 'Name and slug are required.' });
  try {
    const maxOrder = must(await supabase.from('occasions').select('display_order').order('display_order', { ascending: false }).limit(1), 'addOccasion:maxOrder');
    const inserted = must(await supabase.from('occasions').insert({
      name, slug, description: description || '', featured_on_home: !!featuredOnHome, home_card_title: homeCardTitle || '',
      active: true, display_order: (maxOrder[0]?.display_order ?? -1) + 1
    }).select().single(), 'addOccasion:insert');
    res.status(201).json({ occasion: inserted });
  } catch (e) {
    res.status(400).json({ message: isUniqueViolation(e) ? 'That name or slug is already in use.' : e.message });
  }
}));

router.put('/occasions/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('occasions').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateOccasion:lookup');
  if (!existing) return res.status(404).json({ message: 'Occasion not found.' });
  const { name, slug, description, featuredOnHome, homeCardTitle, active, displayOrder, image } = req.body;
  const updated = must(await supabase.from('occasions').update({
    name: name ?? existing.name, slug: slug ?? existing.slug, description: description ?? existing.description,
    featured_on_home: featuredOnHome !== undefined ? !!featuredOnHome : existing.featured_on_home,
    home_card_title: homeCardTitle ?? existing.home_card_title, active: active !== undefined ? !!active : existing.active,
    display_order: displayOrder !== undefined ? Number(displayOrder) : existing.display_order,
    image: image !== undefined ? image : existing.image
  }).eq('id', existing.id).select().single(), 'updateOccasion:update');
  res.json({ occasion: updated });
}));

router.delete('/occasions/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('occasions').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'deleteOccasion:lookup');
  if (!existing) return res.status(404).json({ message: 'Occasion not found.' });
  const inUse = must(await supabase.from('products').select('occasion'), 'deleteOccasion:inUse').filter(p => splitOccasions(p.occasion).includes(existing.name)).length;
  if (inUse > 0) {
    must(await supabase.from('occasions').update({ active: false }).eq('id', existing.id), 'deleteOccasion:deactivate');
    return res.json({ message: `${inUse} product(s) still use "${existing.name}" — deactivated instead of deleted.`, deactivated: true });
  }
  must(await supabase.from('occasions').delete().eq('id', existing.id), 'deleteOccasion:delete');
  res.json({ message: 'Occasion deleted.', deactivated: false });
}));

router.post('/occasions/:id(\\d{1,9})/image', uploadSingle, asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('occasions').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'occasionImage:lookup');
  if (!existing) return res.status(404).json({ message: 'Occasion not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const updated = must(await supabase.from('occasions').update({ image: req.file.publicUrl }).eq('id', existing.id).select().single(), 'occasionImage:update');
  // The picture it replaces is deleted from storage so old photos don't pile up.
  if (existing.image && existing.image !== req.file.publicUrl) await removeUpload(existing.image);
  res.json({ occasion: updated });
}));

// ---- Badges ----
router.get('/badges', asyncRoute(async (req, res) => {
  res.json({ badges: await getBadges() });
}));

router.post('/badges', asyncRoute(async (req, res) => {
  const { key, label, priority } = req.body;
  if (!key || !label) return res.status(400).json({ message: 'Key and label are required.' });
  try {
    const inserted = must(await supabase.from('badges').insert({ key, label, active: true, priority: Number(priority) || 0 }).select().single(), 'addBadge:insert');
    res.status(201).json({ badge: inserted });
  } catch (e) {
    res.status(400).json({ message: isUniqueViolation(e) ? 'That key is already in use.' : e.message });
  }
}));

router.put('/badges/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('badges').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateBadge:lookup');
  if (!existing) return res.status(404).json({ message: 'Badge not found.' });
  const { key, label, active, priority } = req.body;
  const updated = must(await supabase.from('badges').update({
    key: key ?? existing.key, label: label ?? existing.label, active: active !== undefined ? !!active : existing.active,
    priority: priority !== undefined ? Number(priority) : existing.priority
  }).eq('id', existing.id).select().single(), 'updateBadge:update');
  res.json({ badge: updated });
}));

router.delete('/badges/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('badges').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'deleteBadge:lookup');
  if (!existing) return res.status(404).json({ message: 'Badge not found.' });
  const inUse = (await supabase.from('products').select('*', { count: 'exact', head: true }).eq('badge', existing.key)).count || 0;
  if (inUse > 0) {
    must(await supabase.from('badges').update({ active: false }).eq('id', existing.id), 'deleteBadge:deactivate');
    return res.json({ message: `${inUse} product(s) still use this badge — deactivated instead of deleted.`, deactivated: true });
  }
  must(await supabase.from('badges').delete().eq('id', existing.id), 'deleteBadge:delete');
  res.json({ message: 'Badge deleted.', deactivated: false });
}));

// ---- Collections ----
// A collection is a hand-picked set of products (collection_products). The
// count shown is what a shopper can actually see in it — tagged, active and
// not sale-badged (sale sarees live only on /sale) — so admin and storefront
// always agree.
router.get('/collections', asyncRoute(async (req, res) => {
  const [collections, products] = await Promise.all([getCollections({ activeOnly: false }), getProducts({ fresh: true })]);
  const visibleIds = new Set(products.filter(p => p.status !== 'archived' && p.badge !== 'sale').map(p => p.id));
  res.json({
    collections: collections.map(c => ({ ...c, productCount: c.productIds.filter(id => visibleIds.has(id)).length }))
  });
}));

router.post('/collections', asyncRoute(async (req, res) => {
  const { name, slug, description, tagline, weaves, startDate, endDate } = req.body;
  if (!name || !slug) return res.status(400).json({ message: 'Name and slug are required.' });
  try {
    const maxOrder = must(await supabase.from('collections').select('display_order').order('display_order', { ascending: false }).limit(1), 'addCollection:maxOrder');
    const inserted = must(await supabase.from('collections').insert({
      name, slug, description: description || '', tagline: tagline || '', weaves: Array.isArray(weaves) ? weaves : [],
      active: true, display_order: (maxOrder[0]?.display_order ?? -1) + 1,
      start_date: startDate || null, end_date: endDate || null
    }).select().single(), 'addCollection:insert');
    res.status(201).json({ collection: { ...inserted, productIds: [] } });
  } catch (e) {
    res.status(400).json({ message: isUniqueViolation(e) ? 'That slug is already in use.' : e.message });
  }
}));

router.put('/collections/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('collections').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateCollection:lookup');
  if (!existing) return res.status(404).json({ message: 'Collection not found.' });
  const { name, slug, description, tagline, weaves, active, displayOrder, startDate, endDate, bannerImage, thumbnail } = req.body;
  const updated = must(await supabase.from('collections').update({
    name: name ?? existing.name, slug: slug ?? existing.slug, description: description ?? existing.description,
    tagline: tagline ?? existing.tagline, weaves: Array.isArray(weaves) ? weaves : existing.weaves,
    active: active !== undefined ? !!active : existing.active,
    display_order: displayOrder !== undefined ? Number(displayOrder) : existing.display_order,
    start_date: startDate !== undefined ? startDate : existing.start_date, end_date: endDate !== undefined ? endDate : existing.end_date,
    banner_image: bannerImage !== undefined ? bannerImage : existing.banner_image, thumbnail: thumbnail !== undefined ? thumbnail : existing.thumbnail
  }).eq('id', existing.id).select().single(), 'updateCollection:update');
  res.json({ collection: { ...updated, productIds: await getCollectionProductIds(existing.id) } });
}));

router.delete('/collections/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  must(await supabase.from('collection_products').delete().eq('collection_id', Number(req.params.id)), 'deleteCollection:products');
  must(await supabase.from('collections').delete().eq('id', Number(req.params.id)), 'deleteCollection:collection');
  res.json({ message: 'Collection deleted.' });
}));

// slot is 'banner' or 'thumbnail'
router.post('/collections/:id(\\d{1,9})/image', uploadSingle, asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('collections').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'collectionImage:lookup');
  if (!existing) return res.status(404).json({ message: 'Collection not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const slot = req.body.slot === 'thumbnail' ? 'thumbnail' : 'banner_image';
  const updated = must(await supabase.from('collections').update({ [slot]: req.file.publicUrl }).eq('id', existing.id).select().single(), 'collectionImage:update');
  // The picture it replaces is deleted from storage so old photos don't pile up.
  if (existing[slot] && existing[slot] !== req.file.publicUrl) await removeUpload(existing[slot]);
  res.json({ collection: { ...updated, productIds: await getCollectionProductIds(existing.id) } });
}));

// Replaces the full tagged-product list in one call — simpler for the admin
// checklist than diffing adds/removes. Goes through the
// replace_collection_products() Postgres function so the collection is never
// briefly empty to a concurrent reader.
router.put('/collections/:id(\\d{1,9})/products', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = must(await supabase.from('collections').select('*').eq('id', id).maybeSingle(), 'setCollectionProducts:lookup');
  if (!existing) return res.status(404).json({ message: 'Collection not found.' });
  const { productIds } = req.body;
  if (!Array.isArray(productIds)) return res.status(400).json({ message: 'productIds must be an array.' });

  const rpc = await supabase.rpc('replace_collection_products', { p_collection_id: id, p_product_ids: productIds.map(Number) });
  if (rpc.error) throw new Error(rpc.error.message);

  res.json({ productIds: await getCollectionProductIds(id) });
}));

// ---- Coupons ----
router.get('/coupons', asyncRoute(async (req, res) => {
  const coupons = must(await supabase.from('coupons').select('*').order('code'), 'listCoupons');
  const usage = must(await supabase.from('coupon_usage').select('coupon_code'), 'listCoupons:usage');
  const usedCountByCode = {};
  usage.forEach(u => { usedCountByCode[u.coupon_code] = (usedCountByCode[u.coupon_code] || 0) + 1; });
  res.json({ coupons: coupons.map(c => ({ ...c, usedCount: usedCountByCode[c.code] || 0 })) });
}));

router.post('/coupons', asyncRoute(async (req, res) => {
  const { code, type, value, minSubtotal, maxDiscount, usageLimit, perCustomerLimit, startDate, endDate, description } = req.body;
  if (!code || !type || !value) return res.status(400).json({ message: 'Code, type and value are required.' });
  if (!['percent', 'flat'].includes(type)) return res.status(400).json({ message: 'Type must be "percent" or "flat".' });
  try {
    must(await supabase.from('coupons').insert({
      code: code.toUpperCase(), type, value: Number(value), min_subtotal: Number(minSubtotal) || 0,
      max_discount: maxDiscount ? Number(maxDiscount) : null, active: true,
      usage_limit: usageLimit ? Number(usageLimit) : null, per_customer_limit: perCustomerLimit ? Number(perCustomerLimit) : null,
      start_date: startDate || null, end_date: endDate || null, description: description || ''
    }), 'addCoupon:insert');
    await record(req, 'created', 'coupon', code.toUpperCase(), null, { type, value });
    const created = must(await supabase.from('coupons').select('*').eq('code', code.toUpperCase()).single(), 'addCoupon:reread');
    res.status(201).json({ coupon: created });
  } catch (e) {
    res.status(400).json({ message: isUniqueViolation(e) ? 'That coupon code already exists.' : e.message });
  }
}));

router.put('/coupons/:code', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('coupons').select('*').eq('code', req.params.code.toUpperCase()).maybeSingle(), 'updateCoupon:lookup');
  if (!existing) return res.status(404).json({ message: 'Coupon not found.' });
  const { type, value, minSubtotal, maxDiscount, active, usageLimit, perCustomerLimit, startDate, endDate, description } = req.body;
  const updated = must(await supabase.from('coupons').update({
    type: type ?? existing.type, value: value !== undefined ? Number(value) : existing.value,
    min_subtotal: minSubtotal !== undefined ? Number(minSubtotal) : existing.min_subtotal,
    max_discount: maxDiscount !== undefined ? (maxDiscount ? Number(maxDiscount) : null) : existing.max_discount,
    active: active !== undefined ? !!active : existing.active,
    usage_limit: usageLimit !== undefined ? (usageLimit ? Number(usageLimit) : null) : existing.usage_limit,
    per_customer_limit: perCustomerLimit !== undefined ? (perCustomerLimit ? Number(perCustomerLimit) : null) : existing.per_customer_limit,
    start_date: startDate !== undefined ? startDate : existing.start_date, end_date: endDate !== undefined ? endDate : existing.end_date,
    description: description !== undefined ? description : existing.description
  }).eq('code', existing.code).select().single(), 'updateCoupon:update');
  await record(req, 'updated', 'coupon', existing.code, { active: existing.active }, { active });
  res.json({ coupon: updated });
}));

router.delete('/coupons/:code', asyncRoute(async (req, res) => {
  must(await supabase.from('coupons').delete().eq('code', req.params.code.toUpperCase()), 'deleteCoupon');
  await record(req, 'deleted', 'coupon', req.params.code.toUpperCase());
  res.json({ message: 'Coupon deleted.' });
}));

// ---- Storefront content: Hero banner ----
router.get('/content/hero', asyncRoute(async (req, res) => {
  res.json({ hero: await getSetting('hero_banner', {}) });
}));

router.put('/content/hero', asyncRoute(async (req, res) => {
  const current = await getSetting('hero_banner', {});
  const body = { ...req.body };
  // which part of the picture stays in view in the homepage banner: a percentage, 0-100
  for (const k of ['focusX', 'focusY']) {
    if (!(k in body)) continue;
    const n = Number(body[k]);
    if (body[k] === '' || body[k] === null || !Number.isFinite(n)) delete body[k]; else body[k] = Math.min(100, Math.max(0, Math.round(n)));
  }
  const next = { ...current, ...body };
  await setSetting('hero_banner', next);
  res.json({ hero: next });
}));

// slot is 'desktop' (default) or 'mobile' — the mobile image is optional; when
// absent the desktop one is used at every width.
router.post('/content/hero/image', uploadSingle, asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const current = await getSetting('hero_banner', {});
  const field = req.body.slot === 'mobile' ? 'mobileImage' : 'desktopImage';
  const next = { ...current, [field]: req.file.publicUrl };
  await setSetting('hero_banner', next);
  // The picture it replaces is deleted from storage so old photos don't pile up.
  if (current[field] && current[field] !== req.file.publicUrl) await removeUpload(current[field]);
  res.json({ hero: next });
}));

// ---- Storefront content: "Shop all sarees" homepage band ----
// Up to three hand-picked sarees shown in the fan on the homepage band. Stored
// as plain ids; an empty list means "auto" (the public route falls back to the
// most popular sarees), so clearing the picks can never leave the band blank.
router.get('/content/shop-all', asyncRoute(async (req, res) => {
  const cfg = await getSetting('shop_all_showcase', {});
  res.json({ productIds: Array.isArray(cfg.productIds) ? cfg.productIds : [] });
}));

router.put('/content/shop-all', asyncRoute(async (req, res) => {
  const raw = Array.isArray(req.body.productIds) ? req.body.productIds : [];
  const productIds = [];
  for (const v of raw) {
    const id = Number(v);
    if (Number.isInteger(id) && id > 0 && id <= 2147483647 && !productIds.includes(id)) productIds.push(id);
  }
  await setSetting('shop_all_showcase', { productIds: productIds.slice(0, 3) });
  res.json({ productIds: productIds.slice(0, 3) });
}));

// ---- Storefront content: announcement bar (top of every page) and the "Shop by Weave" section ----
router.get('/content/announcement', asyncRoute(async (req, res) => {
  res.json({ announcement: await getSetting('announcement_bar', DEFAULT_ANNOUNCEMENT), defaults: DEFAULT_ANNOUNCEMENT });
}));

router.put('/content/announcement', asyncRoute(async (req, res) => {
  const { value, error } = validateAnnouncement(req.body);
  if (error) return res.status(400).json({ message: error });
  const before = await getSetting('announcement_bar', DEFAULT_ANNOUNCEMENT);
  await setSetting('announcement_bar', value);
  await record(req, 'settings updated', 'announcement_bar', null, before, value);
  res.json({ announcement: value });
}));

router.get('/content/weave-section', asyncRoute(async (req, res) => {
  res.json({ section: await getSetting('weave_section', DEFAULT_WEAVE_SECTION), defaults: DEFAULT_WEAVE_SECTION });
}));

router.put('/content/weave-section', asyncRoute(async (req, res) => {
  const { value, error } = validateWeaveSection(req.body);
  if (error) return res.status(400).json({ message: error });
  const before = await getSetting('weave_section', DEFAULT_WEAVE_SECTION);
  await setSetting('weave_section', value);
  await record(req, 'settings updated', 'weave_section', null, before, value);
  res.json({ section: value });
}));

// ---- Storefront content: Promo band ----
router.get('/content/promo-band', asyncRoute(async (req, res) => {
  res.json({ promoBand: await getSetting('promo_band', {}) });
}));

router.put('/content/promo-band', asyncRoute(async (req, res) => {
  const current = await getSetting('promo_band', {});
  const next = { ...current, ...req.body };
  await setSetting('promo_band', next);
  res.json({ promoBand: next });
}));

// ---- Sarees in Motion (reel curation) ----
router.get('/reels', asyncRoute(async (req, res) => {
  res.json({ reels: await getReelItems({ activeOnly: false }) });
}));

router.post('/reels', asyncRoute(async (req, res) => {
  const { productId } = req.body;
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return res.status(400).json({ message: 'Choose a saree to add.' });
  const product = must(await supabase.from('products').select('id').eq('id', id).maybeSingle(), 'addReel:product');
  if (!product) return res.status(404).json({ message: 'Product not found.' });
  const alreadyIn = must(await supabase.from('reel_items').select('id').eq('product_id', id).maybeSingle(), 'addReel:existing');
  if (alreadyIn) return res.status(400).json({ message: 'That product is already in the reel carousel.' });

  const maxOrder = must(await supabase.from('reel_items').select('sort_order').order('sort_order', { ascending: false }).limit(1), 'addReel:maxOrder');
  const inserted = must(await supabase.from('reel_items').insert({ product_id: id, active: true, sort_order: (maxOrder[0]?.sort_order ?? -1) + 1 }).select().single(), 'addReel:insert');
  res.status(201).json({ reelItem: inserted });
}));

// Registered before '/:id' — otherwise Express would match "reorder" as an
// :id and this route would never be reached (exactly what happened until
// this was caught during testing).
router.put('/reels/reorder', asyncRoute(async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ message: 'orderedIds must be an array.' });
  for (let i = 0; i < orderedIds.length; i++) {
    must(await supabase.from('reel_items').update({ sort_order: i }).eq('id', Number(orderedIds[i])), 'reorderReels');
  }
  res.json({ reels: await getReelItems({ activeOnly: false }) });
}));

router.put('/reels/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('reel_items').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateReel:lookup');
  if (!existing) return res.status(404).json({ message: 'Reel item not found.' });
  const { active, sortOrder, clearVideo, clearThumbnail } = req.body;
  const updated = must(await supabase.from('reel_items').update({
    active: active !== undefined ? !!active : existing.active,
    sort_order: sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
    video_url: clearVideo ? null : existing.video_url,
    thumbnail_url: clearThumbnail ? null : existing.thumbnail_url
  }).eq('id', existing.id).select().single(), 'updateReel:update');
  // A removed video/thumbnail is deleted from storage too, so nothing is left behind.
  if (clearVideo && existing.video_url) await removeUpload(existing.video_url);
  if (clearThumbnail && existing.thumbnail_url) await removeUpload(existing.thumbnail_url);
  res.json({ reelItem: updated });
}));

router.delete('/reels/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const gone = must(await supabase.from('reel_items').select('video_url, thumbnail_url').eq('id', Number(req.params.id)).maybeSingle(), 'deleteReel:lookup');
  must(await supabase.from('reel_items').delete().eq('id', Number(req.params.id)), 'deleteReel');
  if (gone) { await removeUpload(gone.video_url); await removeUpload(gone.thumbnail_url); }
  res.json({ message: 'Removed from Sarees in Motion.' });
}));

router.post('/reels/:id(\\d{1,9})/video', uploadSingle, asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('reel_items').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'reelVideo:lookup');
  if (!existing) return res.status(404).json({ message: 'Reel item not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const isVideo = req.file.mimetype.startsWith('video');
  const field = isVideo ? 'video_url' : 'thumbnail_url';
  const updated = must(await supabase.from('reel_items').update({ [field]: req.file.publicUrl }).eq('id', existing.id).select().single(), 'reelVideo:update');
  // Replacing a video/thumbnail frees the old file.
  if (existing[field] && existing[field] !== req.file.publicUrl) await removeUpload(existing[field]);
  res.json({ reelItem: updated });
}));

// ---- Upcoming Sarees (launch teaser + "notify me" list) ----
// A separate, parallel system from the Pre-Book feature (prebook_requests) —
// these entries have no real product/variant, so "going live" here is always
// an admin action (the Notify Now button below), never an automatic
// stock-crossed-zero signal the way prebookAlerts.js's background job is.
async function shapeAdminUpcoming(row) {
  const requests = must(
    await supabase.from('upcoming_saree_notify_requests').select('*').eq('upcoming_saree_id', row.id).order('created_at', { ascending: false }),
    'shapeAdminUpcoming:requests'
  );
  return {
    id: row.id, name: row.name, fabric: row.fabric, imageUrl: row.image_url,
    description: row.description, expectedLabel: row.expected_label, active: row.active, sortOrder: row.sort_order,
    requests: requests.map(r => ({ id: r.id, email: r.email, name: r.name, createdAt: r.created_at, notified: !!r.notified }))
  };
}

router.get('/upcoming-sarees', asyncRoute(async (req, res) => {
  const rows = must(await supabase.from('upcoming_sarees').select('*').order('sort_order').order('id'), 'listAdminUpcoming');
  res.json({ upcomingSarees: await Promise.all(rows.map(shapeAdminUpcoming)) });
}));

router.post('/upcoming-sarees', asyncRoute(async (req, res) => {
  const { name, fabric, description, expectedLabel } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ message: 'Name is required.' });
  const maxSort = must(await supabase.from('upcoming_sarees').select('sort_order').order('sort_order', { ascending: false }).limit(1), 'createUpcoming:maxSort');
  const inserted = must(await supabase.from('upcoming_sarees').insert({
    name: name.trim(), fabric: fabric || null, description: description || null, expected_label: expectedLabel || null,
    active: true, sort_order: (maxSort[0]?.sort_order ?? -1) + 1
  }).select().single(), 'createUpcoming:insert');
  await record(req, 'created', 'upcoming_saree', inserted.id, null, { name });
  res.status(201).json({ upcomingSaree: await shapeAdminUpcoming(inserted) });
}));

router.put('/upcoming-sarees/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('upcoming_sarees').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateUpcoming:lookup');
  if (!existing) return res.status(404).json({ message: 'Not found.' });
  const { name, fabric, description, expectedLabel, active, sortOrder } = req.body || {};
  const updated = must(await supabase.from('upcoming_sarees').update({
    name: name !== undefined ? name : existing.name,
    fabric: fabric !== undefined ? fabric : existing.fabric,
    description: description !== undefined ? description : existing.description,
    expected_label: expectedLabel !== undefined ? expectedLabel : existing.expected_label,
    active: active !== undefined ? !!active : existing.active,
    sort_order: sortOrder !== undefined ? Number(sortOrder) : existing.sort_order
  }).eq('id', existing.id).select().single(), 'updateUpcoming:update');
  await record(req, 'updated', 'upcoming_saree', existing.id, { name: existing.name, active: existing.active }, { name, active });
  res.json({ upcomingSaree: await shapeAdminUpcoming(updated) });
}));

router.delete('/upcoming-sarees/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  must(await supabase.from('upcoming_sarees').delete().eq('id', Number(req.params.id)), 'deleteUpcoming');
  await record(req, 'deleted', 'upcoming_saree', req.params.id);
  res.json({ message: 'Deleted.' });
}));

router.post('/upcoming-sarees/:id(\\d{1,9})/image', uploadSingle, asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('upcoming_sarees').select('id').eq('id', Number(req.params.id)).maybeSingle(), 'upcomingImage:lookup');
  if (!existing) return res.status(404).json({ message: 'Not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const updated = must(await supabase.from('upcoming_sarees').update({ image_url: req.file.publicUrl }).eq('id', existing.id).select().single(), 'upcomingImage:update');
  // The picture it replaces is deleted from storage so old photos don't pile up.
  if (existing.image_url && existing.image_url !== req.file.publicUrl) await removeUpload(existing.image_url);
  res.json({ upcomingSaree: await shapeAdminUpcoming(updated) });
}));

router.post('/upcoming-sarees/:id(\\d{1,9})/notify', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const entry = must(await supabase.from('upcoming_sarees').select('*').eq('id', id).maybeSingle(), 'notifyUpcoming:lookup');
  if (!entry) return res.status(404).json({ message: 'Not found.' });

  const pending = must(
    await supabase.from('upcoming_saree_notify_requests').select('*').eq('upcoming_saree_id', id).eq('notified', false),
    'notifyUpcoming:pending'
  );
  if (!pending.length) return res.status(400).json({ message: 'Everyone on this list has already been notified.' });

  const now = new Date().toISOString();
  for (const row of pending) {
    await sendEmail({
      to: row.email,
      subject: `${entry.name} is here!`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A1F2B;">Good news, ${row.name || 'there'}!</h2>
        <p>You asked to be told when <strong>${entry.name}</strong> launched — it's live now.</p>
        <p><a href="${process.env.SITE_URL || 'https://padmorasarees.com'}/shop" style="color:#7A1F2B;font-weight:bold;">Shop now →</a></p>
      </div>`
    });
    must(await supabase.from('upcoming_saree_notify_requests').update({ notified: true, notified_at: now }).eq('id', row.id), 'notifyUpcoming:markNotified');
  }
  await record(req, 'notified', 'upcoming_saree', id, null, { sent: pending.length });
  res.json({ message: `Notified ${pending.length} customer${pending.length === 1 ? '' : 's'}.` });
}));

// ---- FAQ ----
router.get('/faq', asyncRoute(async (req, res) => {
  res.json({ faq: await getFaqItems({ activeOnly: false }) });
}));

router.post('/faq', asyncRoute(async (req, res) => {
  const { question, answer, category } = req.body;
  if (!question || !answer) return res.status(400).json({ message: 'Question and answer are required.' });
  const maxOrder = must(await supabase.from('faq_items').select('display_order').order('display_order', { ascending: false }).limit(1), 'addFaq:maxOrder');
  const inserted = must(await supabase.from('faq_items').insert({
    question, answer, category: category || 'General', active: true, display_order: (maxOrder[0]?.display_order ?? -1) + 1
  }).select().single(), 'addFaq:insert');
  res.status(201).json({ faqItem: inserted });
}));

router.put('/faq/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('faq_items').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateFaq:lookup');
  if (!existing) return res.status(404).json({ message: 'FAQ item not found.' });
  const { question, answer, category, active, displayOrder } = req.body;
  const updated = must(await supabase.from('faq_items').update({
    question: question ?? existing.question, answer: answer ?? existing.answer, category: category ?? existing.category,
    active: active !== undefined ? !!active : existing.active,
    display_order: displayOrder !== undefined ? Number(displayOrder) : existing.display_order
  }).eq('id', existing.id).select().single(), 'updateFaq:update');
  res.json({ faqItem: updated });
}));

router.delete('/faq/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  must(await supabase.from('faq_items').delete().eq('id', Number(req.params.id)), 'deleteFaq');
  res.json({ message: 'FAQ item deleted.' });
}));

// ---- Customers ----
router.get('/customers', asyncRoute(async (req, res) => {
  const users = await fetchAllRows(() => supabase.from('users').select('*').eq('is_admin', false).order('created_at', { ascending: false }).order('id'), 'listCustomers');
  const orders = users.length ? await fetchAllRows(() => supabase.from('orders').select('user_id, total, cancelled_at, placed_at').order('id'), 'listCustomers:orders') : [];
  const aggByUser = {};
  orders.forEach(o => {
    const agg = aggByUser[o.user_id] || (aggByUser[o.user_id] = { orderCount: 0, totalSpent: 0, lastOrderAt: null });
    if (!o.cancelled_at) { agg.orderCount++; agg.totalSpent += o.total; }
    if (!agg.lastOrderAt || o.placed_at > agg.lastOrderAt) agg.lastOrderAt = o.placed_at;
  });

  res.json({
    customers: users.map(c => {
      const agg = aggByUser[c.id] || { orderCount: 0, totalSpent: 0, lastOrderAt: null };
      return {
        id: c.id, name: c.name, email: publicEmail(c.email), phone: c.phone, status: c.status || 'active',
        isGuest: !!c.is_guest, flag: c.flag, adminNote: c.admin_note,
        createdAt: c.created_at, orderCount: agg.orderCount, totalSpent: agg.totalSpent, lastOrderAt: agg.lastOrderAt
      };
    })
  });
}));

router.get('/customers/:id', asyncRoute(async (req, res) => {
  const user = must(await supabase.from('users').select('*').eq('id', req.params.id).eq('is_admin', false).maybeSingle(), 'getCustomer:lookup');
  if (!user) return res.status(404).json({ message: 'Customer not found.' });

  const rawOrders = must(await supabase.from('orders').select('*').eq('user_id', user.id).order('placed_at', { ascending: false }), 'getCustomer:orders');
  const orders = await Promise.all(rawOrders.map(async o => ({ id: o.id, total: o.total, status: await computeStatus(o), placedAt: o.placed_at })));
  const addresses = must(await supabase.from('addresses').select('*').eq('user_id', user.id), 'getCustomer:addresses');

  const wishlistRows = must(await supabase.from('wishlist_items').select('product_id').eq('user_id', user.id), 'getCustomer:wishlistRows');
  const cartRows = must(await supabase.from('cart_items').select('id, qty, product_id').eq('user_id', user.id), 'getCustomer:cartRows');
  const productIds = [...new Set([...wishlistRows.map(w => w.product_id), ...cartRows.map(c => c.product_id)])];
  const products = productIds.length ? must(await supabase.from('products').select('id, name, price').in('id', productIds), 'getCustomer:products') : [];
  const productById = Object.fromEntries(products.map(p => [p.id, p]));
  const wishlist = wishlistRows.map(w => productById[w.product_id]).filter(Boolean);
  const cart = cartRows.map(c => ({ id: c.id, qty: c.qty, ...(productById[c.product_id] ? { name: productById[c.product_id].name, price: productById[c.product_id].price } : {}) }));

  res.json({
    customer: {
      id: user.id, name: user.name, email: user.email, phone: user.phone, status: user.status || 'active',
      isGuest: !!user.is_guest, flag: user.flag, adminNote: user.admin_note,
      createdAt: user.created_at,
      address: { line1: user.address_line1, city: user.address_city, state: user.address_state, pincode: user.address_pincode }
    },
    orders, addresses, wishlist, cart
  });
}));

router.put('/customers/:id/status', asyncRoute(async (req, res) => {
  const { status } = req.body;
  if (!['active', 'blocked'].includes(status)) return res.status(400).json({ message: 'status must be "active" or "blocked".' });
  const user = must(await supabase.from('users').select('*').eq('id', req.params.id).eq('is_admin', false).maybeSingle(), 'setCustomerStatus:lookup');
  if (!user) return res.status(404).json({ message: 'Customer not found.' });
  must(await supabase.from('users').update({ status }).eq('id', user.id), 'setCustomerStatus:update');
  await record(req, status === 'blocked' ? 'blocked' : 'reactivated', 'customer', user.id, { status: user.status || 'active' }, { status });
  res.json({ message: status === 'blocked' ? 'Customer blocked — they are signed out immediately.' : 'Customer reactivated.' });
}));

router.put('/customers/:id/flag', asyncRoute(async (req, res) => {
  const { flag, adminNote } = req.body || {};
  const allowedFlags = [null, '', 'vip', 'watch'];
  if (!allowedFlags.includes(flag)) return res.status(400).json({ message: 'flag must be "vip", "watch", or empty.' });
  const user = must(await supabase.from('users').select('*').eq('id', req.params.id).eq('is_admin', false).maybeSingle(), 'setCustomerFlag:lookup');
  if (!user) return res.status(404).json({ message: 'Customer not found.' });

  const nextFlag = flag || null;
  must(await supabase.from('users').update({ flag: nextFlag, admin_note: adminNote || null }).eq('id', user.id), 'setCustomerFlag:update');
  await record(req, 'flag updated', 'customer', user.id, { flag: user.flag, adminNote: user.admin_note }, { flag: nextFlag, adminNote: adminNote || null });
  res.json({ message: 'Customer updated.' });
}));

// ---- Reviews moderation ----
router.get('/reviews', asyncRoute(async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('reviews').select('*').order('created_at', { ascending: false });
  if (status && status !== 'all') query = query.eq('status', status);
  const rows = must(await query, 'listAdminReviews');
  const productIds = [...new Set(rows.map(r => r.product_id))];
  const products = productIds.length ? must(await supabase.from('products').select('id, name').in('id', productIds), 'listAdminReviews:products') : [];
  const nameById = Object.fromEntries(products.map(p => [p.id, p.name]));
  res.json({
    reviews: rows.map(r => ({
      id: r.id, productId: r.product_id, productName: nameById[r.product_id] || '', userName: r.user_name,
      rating: r.rating, title: r.title, body: r.body, verified: !!r.verified, featured: !!r.featured,
      status: r.status, createdAt: r.created_at, adminReply: r.admin_reply, repliedAt: r.replied_at,
      photos: Array.isArray(r.photos) ? r.photos : []
    }))
  });
}));

router.put('/reviews/:id(\\d{1,9})/reply', asyncRoute(async (req, res) => {
  const { reply } = req.body || {};
  const cleanReply = String(reply || '').trim();
  if (!cleanReply) return res.status(400).json({ message: 'Write a reply before sending.' });

  const existing = must(await supabase.from('reviews').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'replyReview:lookup');
  if (!existing) return res.status(404).json({ message: 'Review not found.' });

  must(await supabase.from('reviews').update({
    admin_reply: cleanReply, replied_at: new Date().toISOString()
  }).eq('id', existing.id), 'replyReview:update');
  await record(req, 'replied', 'review', existing.id, null, { reply: cleanReply });

  const customer = must(await supabase.from('users').select('name, email').eq('id', existing.user_id).maybeSingle(), 'replyReview:customer');
  if (customer && customer.email) {
    await sendEmail({
      to: customer.email,
      subject: `Padmora replied to your review`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A1F2B;">A reply to your review</h2>
        <p>Hi ${customer.name || 'there'},</p>
        <p>${cleanReply.replace(/\n/g, '<br>')}</p>
        <p style="color:#6f5a5c;font-size:12px;margin-top:20px;">In response to your review: "${existing.body}"</p>
      </div>`,
      userId: existing.user_id
    });
  }

  res.json({ message: 'Reply posted — it now shows on the product page.' });
}));

router.put('/reviews/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('reviews').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'moderateReview:lookup');
  if (!existing) return res.status(404).json({ message: 'Review not found.' });
  const { status, featured } = req.body;
  if (status && !['pending', 'published', 'rejected'].includes(status)) {
    return res.status(400).json({ message: 'status must be pending, published, or rejected.' });
  }
  must(await supabase.from('reviews').update({
    status: status ?? existing.status, featured: featured !== undefined ? !!featured : existing.featured
  }).eq('id', existing.id), 'moderateReview:update');
  await record(req, 'moderated', 'review', existing.id, { status: existing.status, featured: !!existing.featured }, { status: status ?? existing.status, featured });
  res.json({ message: 'Review updated.' });
}));

router.delete('/reviews/:id(\\d{1,9})', asyncRoute(async (req, res) => {
  const old = must(await supabase.from('reviews').select('photos').eq('id', Number(req.params.id)).maybeSingle(), 'deleteReview:lookup');
  must(await supabase.from('reviews').delete().eq('id', Number(req.params.id)), 'deleteReview');
  for (const url of (old && Array.isArray(old.photos) ? old.photos : [])) await removeUpload(url);   // best effort
  await record(req, 'deleted', 'review', req.params.id);
  res.json({ message: 'Review deleted.' });
}));

// ---- Revenue trend (last N days, cancelled orders excluded) ----
router.get('/analytics/revenue-trend', asyncRoute(async (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);

  const orders = must(
    await supabase.from('orders').select('id, placed_at, total, cancelled_at').gte('placed_at', since.toISOString()),
    'revenueTrend:orders'
  );
  const refunds = await loadRefundsByOrder(orders.filter(o => !o.cancelled_at).map(o => o.id));   // money handed back for returns comes off the day the order was placed

  // One bucket per calendar day (server-local), oldest first, zero-filled so
  // a quiet day still shows as a real bar instead of a gap in the axis.
  // Days are the server's own calendar days on both sides (the buckets and each order's date). They used to be built from local
  // midnights but matched against UTC dates, so on a server not running in UTC today's orders fell into no bucket at all.
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(since); d.setDate(d.getDate() + i);
    byDay.set(dayKey(d), { date: dayKey(d), revenue: 0, orders: 0 });
  }
  orders.forEach(o => {
    if (o.cancelled_at) return;
    const key = dayKey(new Date(o.placed_at));
    const bucket = byDay.get(key);
    if (bucket) { bucket.revenue += o.total - ((refunds[o.id] && refunds[o.id].amount) || 0); bucket.orders += 1; }
  });

  res.json({ days: Array.from(byDay.values()) });
}));

// ---- Revenue by day of week (which days actually sell) ----
router.get('/analytics/day-of-week', asyncRoute(async (req, res) => {
  const orders = must(await supabase.from('orders').select('id, placed_at, total, cancelled_at'), 'dayOfWeek:orders');
  const refunds = await loadRefundsByOrder();
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const buckets = DOW.map(name => ({ day: name, revenue: 0, orders: 0 }));
  orders.forEach(o => {
    if (o.cancelled_at) return;
    buckets[new Date(o.placed_at).getDay()].revenue += o.total - ((refunds[o.id] && refunds[o.id].amount) || 0);
    buckets[new Date(o.placed_at).getDay()].orders += 1;
  });
  res.json({ days: buckets });
}));

// ---- Sales by fabric (revenue + units, non-cancelled orders only) ----
router.get('/analytics/sales-by-fabric', asyncRoute(async (req, res) => {
  const liveOrderIds = must(await supabase.from('orders').select('id').is('cancelled_at', null), 'salesByFabric:orders').map(o => o.id);
  if (!liveOrderIds.length) return res.json({ fabrics: [], totalRevenue: 0 });

  const items = await fetchAllByIds(liveOrderIds, c => supabase.from('order_items').select('product_id, qty, price').in('order_id', c).order('id'), 'salesByFabric:items');
  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];   // Instagram sarees have no product, they count under "Other"
  const products = productIds.length ? must(await supabase.from('products').select('id, fabric').in('id', productIds), 'salesByFabric:products') : [];
  const fabricByProduct = Object.fromEntries(products.map(p => [p.id, p.fabric || 'Other']));

  const byFabric = new Map();
  items.forEach(i => {
    const fabric = fabricByProduct[i.product_id] || 'Other';
    if (!byFabric.has(fabric)) byFabric.set(fabric, { fabric, revenue: 0, units: 0 });
    const bucket = byFabric.get(fabric);
    bucket.revenue += i.price * i.qty;
    bucket.units += i.qty;
  });

  const rows = Array.from(byFabric.values()).sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  res.json({ fabrics: rows, totalRevenue });
}));

// ---- Top-selling products (last N days, non-cancelled orders) ----
router.get('/analytics/top-products', asyncRoute(async (req, res) => {
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
  const since = new Date(); since.setDate(since.getDate() - days);

  const liveOrders = must(
    await supabase.from('orders').select('id').is('cancelled_at', null).gte('placed_at', since.toISOString()),
    'topProducts:orders'
  ).map(o => o.id);
  if (!liveOrders.length) return res.json({ products: [] });

  const items = await fetchAllByIds(liveOrders, c => supabase.from('order_items').select('product_id, name, color, qty, price').in('order_id', c).order('id'), 'topProducts:items');
  const byProduct = new Map();
  items.forEach(i => {
    // Instagram sarees have no product id; each is counted under its own name instead of all piling into one "null" row
    const key = i.product_id == null ? 'ig:' + i.name : i.product_id;
    if (!byProduct.has(key)) byProduct.set(key, { productId: i.product_id, name: i.name, revenue: 0, units: 0 });
    const bucket = byProduct.get(key);
    bucket.revenue += i.price * i.qty;
    bucket.units += i.qty;
  });

  const rows = Array.from(byProduct.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  res.json({ products: rows, days });
}));

// ---- Slow movers: active products with stock but no sales in the window ----
router.get('/analytics/slow-movers', asyncRoute(async (req, res) => {
  const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
  const since = new Date(); since.setDate(since.getDate() - days);

  const products = must(await supabase.from('products').select('id, name, fabric').eq('status', 'active'), 'slowMovers:products');
  const variants = must(await supabase.from('product_variants').select('product_id, stock').eq('archived', false), 'slowMovers:variants');
  const stockByProduct = {};
  variants.forEach(v => { stockByProduct[v.product_id] = (stockByProduct[v.product_id] || 0) + v.stock; });

  const recentOrders = must(await supabase.from('orders').select('id').is('cancelled_at', null).gte('placed_at', since.toISOString()), 'slowMovers:orders').map(o => o.id);
  const recentItems = recentOrders.length
    ? await fetchAllByIds(recentOrders, c => supabase.from('order_items').select('product_id').in('order_id', c).order('id'), 'slowMovers:items')
    : [];
  const soldRecently = new Set(recentItems.map(i => i.product_id));

  const rows = products
    .filter(p => (stockByProduct[p.id] || 0) > 0 && !soldRecently.has(p.id))
    .map(p => ({ productId: p.id, name: p.name, fabric: p.fabric, stock: stockByProduct[p.id] || 0 }))
    .sort((a, b) => b.stock - a.stock);

  res.json({ products: rows, days });
}));

// ---- New vs returning customers, weekly buckets over the last N weeks ----
router.get('/analytics/customer-growth', asyncRoute(async (req, res) => {
  const weeks = Math.min(26, Math.max(4, Number(req.query.weeks) || 12));
  const orders = must(await supabase.from('orders').select('user_id, placed_at, cancelled_at').is('cancelled_at', null).order('placed_at', { ascending: true }), 'customerGrowth:orders');

  const firstOrderAt = new Map();
  orders.forEach(o => { if (!firstOrderAt.has(o.user_id)) firstOrderAt.set(o.user_id, o.placed_at); });

  const since = new Date(); since.setDate(since.getDate() - weeks * 7); since.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(since); start.setDate(start.getDate() + i * 7);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    buckets.push({ weekStart: start.toISOString().slice(0, 10), newCustomers: 0, returningCustomers: 0, _start: start, _end: end });
  }
  orders.forEach(o => {
    const placed = new Date(o.placed_at);
    const bucket = buckets.find(b => placed >= b._start && placed < b._end);
    if (!bucket) return;
    const isNew = firstOrderAt.get(o.user_id) === o.placed_at;
    if (isNew) bucket.newCustomers += 1; else bucket.returningCustomers += 1;
  });

  res.json({ weeks: buckets.map(({ _start, _end, ...b }) => b) });
}));

// ---- Guest vs registered order share (all-time snapshot) ----
router.get('/analytics/customer-mix', asyncRoute(async (req, res) => {
  const orders = must(await supabase.from('orders').select('user_id').is('cancelled_at', null), 'customerMix:orders');
  const userIds = [...new Set(orders.map(o => o.user_id))];
  const users = userIds.length ? await fetchAllByIds(userIds, c => supabase.from('users').select('id, is_guest').in('id', c).order('id'), 'customerMix:users') : [];
  const guestByUser = Object.fromEntries(users.map(u => [u.id, !!u.is_guest]));
  let guestOrders = 0, registeredOrders = 0;
  orders.forEach(o => { if (guestByUser[o.user_id]) guestOrders += 1; else registeredOrders += 1; });
  res.json({ guestOrders, registeredOrders });
}));

// ---- Top customers by lifetime spend (non-cancelled orders) ----
router.get('/analytics/top-customers', asyncRoute(async (req, res) => {
  const orders = must(await supabase.from('orders').select('user_id, total').is('cancelled_at', null), 'topCustomers:orders');
  const byUser = new Map();
  orders.forEach(o => {
    if (!byUser.has(o.user_id)) byUser.set(o.user_id, { userId: o.user_id, spend: 0, orders: 0 });
    const bucket = byUser.get(o.user_id);
    bucket.spend += o.total;
    bucket.orders += 1;
  });
  const top = Array.from(byUser.values()).sort((a, b) => b.spend - a.spend).slice(0, 10);
  const userIds = top.map(t => t.userId);
  const users = userIds.length ? must(await supabase.from('users').select('id, name, email, is_guest').in('id', userIds), 'topCustomers:users') : [];
  const userById = Object.fromEntries(users.map(u => [u.id, u]));
  res.json({
    customers: top.map(t => ({ ...t, name: userById[t.userId]?.name || 'Unknown', email: userById[t.userId]?.email || '', isGuest: !!userById[t.userId]?.is_guest }))
  });
}));

// ---- Current order pipeline snapshot (computed status for every order) ----
router.get('/analytics/order-pipeline', asyncRoute(async (req, res) => {
  const orders = must(await supabase.from('orders').select('*'), 'orderPipeline:orders');
  const statuses = await Promise.all(orders.map(o => computeStatus(o)));
  const counts = {};
  statuses.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
  res.json({ counts, total: orders.length });
}));

// ---- Cancellation reasons (from the cancellation-request flow) ----
router.get('/analytics/cancellation-reasons', asyncRoute(async (req, res) => {
  const orders = must(await supabase.from('orders').select('cancel_request_reason').not('cancel_request_reason', 'is', null), 'cancellationReasons:orders');
  const counts = {};
  orders.forEach(o => { counts[o.cancel_request_reason] = (counts[o.cancel_request_reason] || 0) + 1; });
  const reasons = Object.entries(counts).map(([key, count]) => ({
    key, label: (CANCEL_REASONS.find(r => r.key === key) || {}).label || key, count
  })).sort((a, b) => b.count - a.count);
  res.json({ reasons, total: orders.length });
}));

// ---- Return reasons (category + specific reason) ----
router.get('/analytics/return-reasons', asyncRoute(async (req, res) => {
  const returns = must(await supabase.from('return_requests').select('reason, reason_category'), 'returnReasons:rows');
  const byCategory = {};
  const byReason = {};
  returns.forEach(r => {
    byCategory[r.reason_category] = (byCategory[r.reason_category] || 0) + 1;
    byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  });
  res.json({
    byCategory: Object.entries(byCategory).map(([key, count]) => ({ key, count })),
    byReason: Object.entries(byReason).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    total: returns.length
  });
}));

// ---- Coupon performance (non-cancelled orders that used a coupon) ----
router.get('/analytics/coupon-performance', asyncRoute(async (req, res) => {
  const orders = must(await supabase.from('orders').select('coupon_code, discount').is('cancelled_at', null).not('coupon_code', 'is', null), 'couponPerformance:orders');
  const byCode = new Map();
  orders.forEach(o => {
    if (!byCode.has(o.coupon_code)) byCode.set(o.coupon_code, { code: o.coupon_code, uses: 0, totalDiscount: 0 });
    const bucket = byCode.get(o.coupon_code);
    bucket.uses += 1;
    bucket.totalDiscount += o.discount || 0;
  });
  const rows = Array.from(byCode.values()).sort((a, b) => b.totalDiscount - a.totalDiscount);
  res.json({ coupons: rows });
}));

// ---- Wishlist analytics ----
router.get('/analytics/wishlist', asyncRoute(async (req, res) => {
  const wishlistRows = must(await supabase.from('wishlist_items').select('user_id, product_id'), 'wishlistAnalytics:rows');
  const productIds = [...new Set(wishlistRows.map(w => w.product_id))];
  const products = productIds.length ? must(await supabase.from('products').select('id, name, fabric').in('id', productIds), 'wishlistAnalytics:products') : [];
  const productById = Object.fromEntries(products.map(p => [p.id, p]));

  // Build the "has this user actually bought this product on a non-cancelled
  // order" set once, then check membership per wishlist row — the JS
  // equivalent of the old correlated EXISTS subquery.
  const nonCancelledOrders = must(await supabase.from('orders').select('id, user_id').is('cancelled_at', null), 'wishlistAnalytics:orders');
  const userByOrderId = Object.fromEntries(nonCancelledOrders.map(o => [o.id, o.user_id]));
  const orderIds = nonCancelledOrders.map(o => o.id);
  const purchasedItems = orderIds.length ? await fetchAllByIds(orderIds, c => supabase.from('order_items').select('order_id, product_id').in('order_id', c).order('id'), 'wishlistAnalytics:items') : [];
  const purchasedPairs = new Set(purchasedItems.map(i => `${userByOrderId[i.order_id]}:${i.product_id}`));

  const byProduct = new Map();
  wishlistRows.forEach(w => {
    const key = w.product_id;
    if (!byProduct.has(key)) byProduct.set(key, { users: new Set(), purchasers: new Set() });
    const entry = byProduct.get(key);
    entry.users.add(w.user_id);
    if (purchasedPairs.has(`${w.user_id}:${w.product_id}`)) entry.purchasers.add(w.user_id);
  });

  const rows = Array.from(byProduct.entries())
    .map(([productId, entry]) => ({
      productId, name: productById[productId]?.name || '', fabric: productById[productId]?.fabric || '',
      wishlistCount: entry.users.size, purchaseCount: entry.purchasers.size
    }))
    .sort((a, b) => b.wishlistCount - a.wishlistCount);

  res.json({ products: rows, totalWishlistAdds: wishlistRows.length });
}));

// ---- Search analytics ----
router.get('/analytics/search', asyncRoute(async (req, res) => {
  const rows = must(await supabase.from('search_queries').select('query, result_count'), 'searchAnalytics:rows');
  const byQuery = new Map();
  rows.forEach(r => {
    const entry = byQuery.get(r.query) || { searches: 0, lastResultCount: r.result_count };
    entry.searches++;
    entry.lastResultCount = Math.max(entry.lastResultCount, r.result_count);
    byQuery.set(r.query, entry);
  });
  const topSearches = Array.from(byQuery.entries())
    .map(([query, v]) => ({ query, searches: v.searches, lastResultCount: v.lastResultCount }))
    .sort((a, b) => b.searches - a.searches).slice(0, 25);
  const noResults = rows.filter(r => r.result_count === 0).reduce((map, r) => {
    map.set(r.query, (map.get(r.query) || 0) + 1);
    return map;
  }, new Map());
  const noResultsList = Array.from(noResults.entries()).map(([query, searches]) => ({ query, searches })).sort((a, b) => b.searches - a.searches).slice(0, 25);

  res.json({ topSearches, noResults: noResultsList, totalSearches: rows.length });
}));

// ---- Admin Users (Super Admin only — enforced via PATH_SCOPES) ----
function publicAdminUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: !!row.active, createdAt: row.created_at };
}

router.get('/admin-users', asyncRoute(async (req, res) => {
  const rows = must(await supabase.from('admin_users').select('*').order('created_at'), 'listAdminUsers');
  res.json({ adminUsers: rows.map(publicAdminUser), roles: ADMIN_ROLES });
}));

router.post('/admin-users', asyncRoute(async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ message: 'Name, email, password and role are all required.' });
  if (!ADMIN_ROLES.includes(role)) return res.status(400).json({ message: 'Unknown role.' });
  if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });

  const exists = must(await supabase.from('admin_users').select('id').ilike('email', email).maybeSingle(), 'addAdminUser:lookup');
  if (exists) return res.status(409).json({ message: 'An admin account with this email already exists.' });

  const id = 'adm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const hashed = await bcrypt.hash(password, 10);
  must(await supabase.from('admin_users').insert({ id, name, email, password: hashed, role, active: true, created_at: new Date().toISOString() }), 'addAdminUser:insert');
  await record(req, 'created', 'admin_user', id, null, { name, email, role });

  const created = must(await supabase.from('admin_users').select('*').eq('id', id).single(), 'addAdminUser:reread');
  res.status(201).json({ adminUser: publicAdminUser(created) });
}));

router.put('/admin-users/:id', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('admin_users').select('*').eq('id', req.params.id).maybeSingle(), 'updateAdminUser:lookup');
  if (!existing) return res.status(404).json({ message: 'Admin user not found.' });
  if (existing.id === req.adminId && req.body.active === false) {
    return res.status(400).json({ message: "You can't deactivate your own account." });
  }
  const { role, active } = req.body;
  if (role && !ADMIN_ROLES.includes(role)) return res.status(400).json({ message: 'Unknown role.' });

  must(await supabase.from('admin_users').update({
    role: role ?? existing.role, active: active !== undefined ? !!active : existing.active
  }).eq('id', existing.id), 'updateAdminUser:update');
  await record(req, 'updated', 'admin_user', existing.id, { role: existing.role, active: !!existing.active }, { role, active });

  const updated = must(await supabase.from('admin_users').select('*').eq('id', existing.id).single(), 'updateAdminUser:reread');
  res.json({ adminUser: publicAdminUser(updated) });
}));

// ---- Activity Log (read-only, visible to every admin role) ----
router.get('/activity-log', asyncRoute(async (req, res) => {
  // Newest first. The page asks for up to 3000 so older days (for example last month) can be searched and filtered too.
  const limit = Math.min(3000, Math.max(1, Number(req.query.limit) || 200));
  // The database hands back at most 1000 rows per request, so a long log is fetched in pages.
  const rows = [];
  for (let from = 0; from < limit; from += 1000) {
    const to = Math.min(from + 999, limit - 1);
    const chunk = must(await supabase.from('admin_activity_log').select('*').order('created_at', { ascending: false }).range(from, to), 'activityLog');
    rows.push(...chunk);
    if (chunk.length < to - from + 1) break;
  }
  res.json({
    log: rows.map(r => ({
      id: r.id, adminName: r.admin_name, action: r.action, entity: r.entity, entityId: r.entity_id,
      before: r.before_value ? JSON.parse(r.before_value) : null,
      after: r.after_value ? JSON.parse(r.after_value) : null,
      createdAt: r.created_at
    }))
  });
}));

module.exports = router;
