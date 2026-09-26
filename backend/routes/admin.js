const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const {
  supabase, must, getProducts, getVariantById, syncProductMirrorFromDefaultVariant, getSetting, setSetting,
  getFabrics, getOccasions, getBadges, getCollections, getCollectionProductIds, getReelItems, getFaqItems,
  ADMIN_ROLES, logActivity
} = require('../utils/db');
const { requireAdminAuth, requirePermission } = require('../middleware/adminAuth');
const { computeStatus, buildTimeline, isCancellable, STAGE_NAMES, CANCEL_REASONS } = require('../utils/orderStatus');
const { upload, UPLOAD_DIR } = require('../middleware/upload');
const { toProductApiShape } = require('../utils/shape');
const { runBackup, listBackups, BACKUP_DIR } = require('../utils/backup');
const { RETURN_REASONS } = require('../utils/returns');
const { sendEmail, emailConfigured, smsConfigured } = require('../utils/notify');
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

// A Postgres unique_violation (23505) surfaces through must()'s wrapped
// error as err.cause.code — used everywhere the old SQLite code checked
// `e.message.includes('UNIQUE')`.
function isUniqueViolation(err) {
  return !!(err && err.cause && err.cause.code === '23505');
}

// Turns a multer failure (bad file type, file too large) into a clean 400
// with the real reason, instead of falling through to the generic 500 handler.
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
    next();
  });
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
  const revenue = activeOrders.reduce((s, o) => s + o.total, 0);
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
  const todayRevenue = todayOrders.reduce((s, o) => s + o.total, 0);
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
  const products = (await getProducts()).map(toProductApiShape).map(p => ({
    ...p,
    variantCount: p.variants.length,
    totalStock: p.variants.reduce((s, v) => s + v.stock, 0)
  }));
  res.json({ products });
}));

router.get('/products/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const product = (await getProducts()).map(toProductApiShape).find(p => p.id === id);
  if (!product) return res.status(404).json({ message: 'Product not found.' });
  res.json({ product });
}));

router.post('/products', asyncRoute(async (req, res) => {
  const { name, fabric, occasion, price, mrp, badge, swatch, desc, stock, weaverName, weaverRegion, loomType } = req.body;
  if (!name || !fabric || !occasion || !price || !mrp) {
    return res.status(400).json({ message: 'Name, fabric, occasion, price and MRP are required.' });
  }
  const maxRow = must(await supabase.from('products').select('id').order('id', { ascending: false }).limit(1), 'createProduct:maxId');
  const id = (maxRow[0]?.id || 0) + 1;
  const rpc = await supabase.rpc('create_product_with_default_variant', {
    p_id: id, p_name: name, p_fabric: fabric, p_occasion: occasion, p_price: Number(price), p_mrp: Number(mrp),
    p_badge: badge || null, p_swatch: swatch || 'maroon', p_description: desc || '', p_stock: Number(stock) || 20,
    p_weaver_name: weaverName || '', p_weaver_region: weaverRegion || '', p_loom_type: loomType || 'Handloom',
    p_color_name: (swatch || 'maroon').replace(/^\w/, c => c.toUpperCase()), p_sku: `PDM-${id}-DEF`
  });
  if (rpc.error) throw new Error(rpc.error.message);
  await record(req, 'created', 'product', id, null, { name, fabric, price, mrp, stock });

  res.status(201).json({ product: (await getProducts()).map(toProductApiShape).find(p => p.id === id) });
}));

router.put('/products/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = must(await supabase.from('products').select('*').eq('id', id).maybeSingle(), 'updateProduct:lookup');
  if (!existing) return res.status(404).json({ message: 'Product not found.' });

  const { name, fabric, occasion, badge, desc, weaverName, weaverRegion, loomType, status } = req.body;
  must(await supabase.from('products').update({
    name: name ?? existing.name, fabric: fabric ?? existing.fabric, occasion: occasion ?? existing.occasion,
    badge: badge !== undefined ? badge : existing.badge, description: desc ?? existing.description,
    weaver_name: weaverName ?? existing.weaver_name, weaver_region: weaverRegion ?? existing.weaver_region,
    loom_type: loomType ?? existing.loom_type, status: status ?? existing.status ?? 'active'
  }).eq('id', id), 'updateProduct:update');
  await record(req, 'updated', 'product', id, { name: existing.name, status: existing.status }, { name, status });

  res.json({ product: (await getProducts()).map(toProductApiShape).find(p => p.id === id) });
}));

// Archive rather than hard-delete once a product has ever been ordered —
// historical order_items must keep referring to something real.
router.delete('/products/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const wasOrdered = ((await supabase.from('order_items').select('*', { count: 'exact', head: true }).eq('product_id', id)).count || 0) > 0;
  if (wasOrdered) {
    must(await supabase.from('products').update({ status: 'archived' }).eq('id', id), 'deleteProduct:archive');
    await record(req, 'archived', 'product', id);
    return res.json({ message: 'Product archived (it has past orders, so it can’t be deleted outright).', archived: true });
  }
  must(await supabase.from('product_variants').delete().eq('product_id', id), 'deleteProduct:variants');
  must(await supabase.from('products').delete().eq('id', id), 'deleteProduct:product');
  await record(req, 'deleted', 'product', id);
  res.json({ message: 'Product deleted.', archived: false });
}));

// ---- Variants ----
router.post('/products/:id/variants', asyncRoute(async (req, res) => {
  const productId = Number(req.params.id);
  const product = must(await supabase.from('products').select('id').eq('id', productId).maybeSingle(), 'addVariant:product');
  if (!product) return res.status(404).json({ message: 'Product not found.' });

  const { colorName, swatch, sku, price, mrp, stock, description, lowStockThreshold } = req.body;
  if (!colorName || !price || !mrp) {
    return res.status(400).json({ message: 'Color name, price and MRP are required.' });
  }
  const maxSort = must(await supabase.from('product_variants').select('sort_order').eq('product_id', productId).order('sort_order', { ascending: false }).limit(1), 'addVariant:maxSort');
  const sortOrder = (maxSort[0]?.sort_order ?? -1) + 1;
  const inserted = must(await supabase.from('product_variants').insert({
    product_id: productId, color_name: colorName, swatch: swatch || 'maroon', sku: sku || null,
    price: Number(price), mrp: Number(mrp), stock: Number(stock) || 0, low_stock_threshold: Number(lowStockThreshold) || 10,
    description: description || '', is_default: false, sort_order: sortOrder
  }).select().single(), 'addVariant:insert');

  res.status(201).json({ variant: await getVariantById(inserted.id) });
}));

router.put('/variants/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = must(await supabase.from('product_variants').select('*').eq('id', id).maybeSingle(), 'updateVariant:lookup');
  if (!existing) return res.status(404).json({ message: 'Variant not found.' });

  const { colorName, swatch, sku, price, mrp, stock, description, lowStockThreshold, isDefault } = req.body;

  if (isDefault) {
    must(await supabase.from('product_variants').update({ is_default: false }).eq('product_id', existing.product_id), 'updateVariant:clearDefault');
  }

  must(await supabase.from('product_variants').update({
    color_name: colorName ?? existing.color_name, swatch: swatch ?? existing.swatch,
    sku: sku !== undefined ? sku : existing.sku,
    price: price !== undefined ? Number(price) : existing.price, mrp: mrp !== undefined ? Number(mrp) : existing.mrp,
    stock: stock !== undefined ? Number(stock) : existing.stock,
    low_stock_threshold: lowStockThreshold !== undefined ? Number(lowStockThreshold) : existing.low_stock_threshold,
    description: description ?? existing.description,
    is_default: isDefault !== undefined ? !!isDefault : existing.is_default
  }).eq('id', id), 'updateVariant:update');

  await syncProductMirrorFromDefaultVariant(existing.product_id);
  await record(req, 'updated', 'variant', id,
    { price: existing.price, mrp: existing.mrp, stock: existing.stock },
    { price: price ?? existing.price, mrp: mrp ?? existing.mrp, stock: stock ?? existing.stock });
  res.json({ variant: await getVariantById(id) });
}));

router.delete('/variants/:id', asyncRoute(async (req, res) => {
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
router.post('/variants/:id/media', uploadSingle, asyncRoute(async (req, res) => {
  const variantId = Number(req.params.id);
  const variant = must(await supabase.from('product_variants').select('*').eq('id', variantId).maybeSingle(), 'addMedia:variant');
  if (!variant) return res.status(404).json({ message: 'Variant not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

  const type = req.file.mimetype.startsWith('video') ? 'video' : 'image';
  const url = `/uploads/${req.file.filename}`;
  const hasAny = ((await supabase.from('variant_media').select('*', { count: 'exact', head: true }).eq('variant_id', variantId)).count || 0) > 0;
  const maxSort = must(await supabase.from('variant_media').select('sort_order').eq('variant_id', variantId).order('sort_order', { ascending: false }).limit(1), 'addMedia:maxSort');
  const sortOrder = (maxSort[0]?.sort_order ?? -1) + 1;

  const inserted = must(await supabase.from('variant_media').insert({
    variant_id: variantId, type, url, alt_text: req.body.alt || '', is_primary: !hasAny, sort_order: sortOrder
  }).select().single(), 'addMedia:insert');

  res.status(201).json({ media: inserted });
}));

router.delete('/media/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const media = must(await supabase.from('variant_media').select('*').eq('id', id).maybeSingle(), 'deleteMedia:lookup');
  if (!media) return res.status(404).json({ message: 'Media not found.' });

  must(await supabase.from('variant_media').delete().eq('id', id), 'deleteMedia:delete');
  if (media.is_primary) {
    const next = must(await supabase.from('variant_media').select('id').eq('variant_id', media.variant_id).order('sort_order').order('id').limit(1), 'deleteMedia:next');
    if (next[0]) must(await supabase.from('variant_media').update({ is_primary: true }).eq('id', next[0].id), 'deleteMedia:promote');
  }
  // Best-effort local cleanup — never let a missing file block the API response.
  try {
    const filePath = path.join(UPLOAD_DIR, path.basename(media.url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) { /* ignore */ }

  res.json({ message: 'Media removed.' });
}));

router.put('/media/:id/primary', asyncRoute(async (req, res) => {
  const media = must(await supabase.from('variant_media').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'primaryMedia:lookup');
  if (!media) return res.status(404).json({ message: 'Media not found.' });
  must(await supabase.from('variant_media').update({ is_primary: false }).eq('variant_id', media.variant_id), 'primaryMedia:clear');
  must(await supabase.from('variant_media').update({ is_primary: true }).eq('id', media.id), 'primaryMedia:set');
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
  const variant = must(await supabase.from('product_variants').select('*').eq('id', id).maybeSingle(), 'adjustInventory:lookup');
  if (!variant) return res.status(404).json({ message: 'Variant not found.' });
  const delta = Number(change);
  if (!delta) return res.status(400).json({ message: 'Enter a non-zero quantity change.' });

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

router.get('/inventory/:variantId/history', asyncRoute(async (req, res) => {
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

    const price = idx.price > -1 && cols[idx.price] !== '' ? Number(cols[idx.price]) : variant.price;
    const mrp = idx.mrp > -1 && cols[idx.mrp] !== '' ? Number(cols[idx.mrp]) : variant.mrp;
    const stock = idx.stock > -1 && cols[idx.stock] !== '' ? Number(cols[idx.stock]) : variant.stock;
    if (!Number.isFinite(price) || price <= 0) { errors.push({ row: rowNum, reason: 'Invalid price' }); continue; }
    if (!Number.isFinite(mrp) || mrp <= 0) { errors.push({ row: rowNum, reason: 'Invalid MRP' }); continue; }
    if (!Number.isInteger(stock) || stock < 0) { errors.push({ row: rowNum, reason: 'Invalid stock' }); continue; }

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
  const users = userIds.length ? must(await supabase.from('users').select('id, name, email').in('id', userIds), 'attachOrderExtras:users') : [];
  const userById = Object.fromEntries(users.map(u => [u.id, u]));
  return orders.map(o => ({ ...o, customer_name: userById[o.user_id]?.name, customer_email: userById[o.user_id]?.email }));
}

async function shapeAdminOrder(o, { full } = {}) {
  const items = must(await supabase.from('order_items').select('*').eq('order_id', o.id), 'shapeAdminOrder:items');
  const status = await computeStatus(o);
  const base = {
    id: o.id,
    customerName: o.customer_name,
    customerEmail: o.customer_email,
    items: items.map(li => ({ productId: li.product_id, variantId: li.variant_id, name: li.name, color: li.color, qty: li.qty, price: li.price })),
    subtotal: o.subtotal,
    discount: o.discount,
    shippingFee: o.shipping_fee,
    taxAmount: o.tax_amount,
    couponCode: o.coupon_code,
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
    address: { name: o.address_name, city: o.address_city, state: o.address_state, pincode: o.address_pincode },
    placedAt: o.placed_at
  };
  if (!full) return base;
  const notifications = must(
    await supabase.from('notifications_log').select('channel, recipient, status, detail, created_at').eq('order_id', o.id).order('created_at', { ascending: false }),
    'shapeAdminOrder:notifications'
  );
  return {
    ...base,
    customerPhone: o.address_phone,
    address: {
      name: o.address_name, line1: o.address_line1, city: o.address_city,
      state: o.address_state, pincode: o.address_pincode, phone: o.address_phone
    },
    giftNote: o.gift_note,
    payment: o.payment,
    cancelledAt: o.cancelled_at,
    timeline: await buildTimeline(o),
    notifications
  };
}

router.get('/orders', asyncRoute(async (req, res) => {
  const orders = await attachOrderExtras(must(await supabase.from('orders').select('*').order('placed_at', { ascending: false }), 'listOrders'));

  let shaped = await Promise.all(orders.map(o => shapeAdminOrder(o)));
  const { status } = req.query;
  if (status && status !== 'all') {
    shaped = shaped.filter(o => o.status.toLowerCase() === String(status).toLowerCase());
  }

  res.json({ orders: shaped, stageNames: STAGE_NAMES });
}));

// Registered ahead of /orders/:id below — otherwise Express would match this
// path as an :id lookup for an order literally named "export.csv" and 404.
router.get('/orders/export.csv', asyncRoute(async (req, res) => {
  const orders = await attachOrderExtras(must(await supabase.from('orders').select('*').order('placed_at', { ascending: false }), 'exportOrders'));
  const orderIds = orders.map(o => o.id);
  const allItems = orderIds.length ? must(await supabase.from('order_items').select('order_id, name, color, qty').in('order_id', orderIds), 'exportOrders:items') : [];
  const itemsByOrder = {};
  allItems.forEach(i => (itemsByOrder[i.order_id] || (itemsByOrder[i.order_id] = [])).push(i));

  const header = ['orderId', 'placedAt', 'customerName', 'customerEmail', 'status', 'payment', 'items', 'subtotal', 'discount', 'shippingFee', 'taxAmount', 'total'];
  const rows = [];
  for (const o of orders) {
    const items = itemsByOrder[o.id] || [];
    const itemsSummary = items.map(i => `${i.name}${i.color ? ' (' + i.color + ')' : ''} x${i.qty}`).join('; ');
    rows.push([
      o.id, o.placed_at, o.customer_name, o.customer_email, await computeStatus(o), o.payment,
      itemsSummary, o.subtotal, o.discount, o.shipping_fee, o.tax_amount, o.total
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

router.get('/orders/:id', asyncRoute(async (req, res) => {
  const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle(), 'getAdminOrder');
  if (!order) return res.status(404).json({ message: 'Order not found.' });
  const [o] = await attachOrderExtras([order]);
  res.json({ order: await shapeAdminOrder(o, { full: true }) });
}));

router.put('/orders/:id/status', asyncRoute(async (req, res) => {
  const { status } = req.body; // one of STAGE_NAMES, or null/'auto' to revert to time-based
  const order = must(await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle(), 'setOrderStatus:lookup');
  if (!order) return res.status(404).json({ message: 'Order not found.' });

  const manualStatus = (!status || status === 'auto') ? null : status;
  if (manualStatus && !STAGE_NAMES.includes(manualStatus)) {
    return res.status(400).json({ message: 'Invalid status.' });
  }

  must(await supabase.from('orders').update({ manual_status: manualStatus }).eq('id', order.id), 'setOrderStatus:update');
  await record(req, 'status changed', 'order', order.id, { manualStatus: order.manual_status }, { manualStatus });
  const updated = must(await supabase.from('orders').select('*').eq('id', order.id).single(), 'setOrderStatus:reread');
  res.json({ status: await computeStatus(updated), timeline: await buildTimeline(updated) });
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
    smsConfigured: smsConfigured()
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

// Deciding a pending cancellation request: approving here is the only place
// that actually cancels + restocks the order now (see routes/orders.js,
// which only ever writes a pending request, never cancels directly).
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
async function shapeAdminReturn(r) {
  const order = must(await supabase.from('orders').select('*').eq('id', r.order_id).maybeSingle(), 'shapeAdminReturn:order');
  const customer = must(await supabase.from('users').select('name, email, phone').eq('id', r.user_id).maybeSingle(), 'shapeAdminReturn:customer');
  const returnItems = must(await supabase.from('return_request_items').select('id, qty, order_item_id').eq('return_id', r.id), 'shapeAdminReturn:items');
  const orderItemIds = returnItems.map(i => i.order_item_id);
  const orderItems = orderItemIds.length
    ? must(await supabase.from('order_items').select('id, name, color, price, variant_id').in('id', orderItemIds), 'shapeAdminReturn:orderItems')
    : [];
  const orderItemById = Object.fromEntries(orderItems.map(oi => [oi.id, oi]));
  const photos = must(await supabase.from('return_request_photos').select('id, url').eq('return_id', r.id).order('id'), 'shapeAdminReturn:photos');
  return {
    id: r.id,
    orderId: r.order_id,
    orderTotal: order ? order.total : null,
    orderPayment: order ? order.payment : null,
    customerName: customer ? customer.name : null,
    customerEmail: customer ? customer.email : null,
    customerPhone: customer ? customer.phone : null,
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
      return { returnItemId: i.id, orderItemId: i.order_item_id, name: oi.name, color: oi.color, price: oi.price, qty: i.qty, variantId: oi.variant_id };
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
  res.json({ returns: await Promise.all(rows.map(shapeAdminReturn)) });
}));

router.get('/returns/:id', asyncRoute(async (req, res) => {
  const row = must(await supabase.from('return_requests').select('*').eq('id', req.params.id).maybeSingle(), 'getAdminReturn');
  if (!row) return res.status(404).json({ message: 'Return request not found.' });
  res.json({ return: await shapeAdminReturn(row) });
}));

router.put('/returns/:id/decision', asyncRoute(async (req, res) => {
  const { approve, adminNote } = req.body || {};
  const existing = must(await supabase.from('return_requests').select('*').eq('id', req.params.id).maybeSingle(), 'decideReturn:lookup');
  if (!existing) return res.status(404).json({ message: 'Return request not found.' });
  if (existing.status !== 'Requested') return res.status(400).json({ message: 'This request has already been decided.' });
  if (!approve && !(adminNote || '').trim()) {
    return res.status(400).json({ message: "Add a note explaining why — the customer will see it." });
  }

  const nextStatus = approve ? 'Approved' : 'Rejected';
  must(await supabase.from('return_requests').update({
    status: nextStatus, admin_note: (adminNote || '').trim() || null, decided_at: new Date().toISOString()
  }).eq('id', existing.id), 'decideReturn:update');
  await record(req, approve ? 'approved' : 'rejected', 'return_request', existing.id, { status: existing.status }, { status: nextStatus, adminNote });

  const customer = must(await supabase.from('users').select('name, email').eq('id', existing.user_id).maybeSingle(), 'decideReturn:customer');
  if (customer && customer.email) {
    await sendEmail({
      to: customer.email,
      subject: approve ? `Your return for order ${existing.order_id} was approved` : `Update on your return for order ${existing.order_id}`,
      html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A1F2B;">${approve ? 'Return approved' : 'Return request update'}</h2>
        <p>Hi ${customer.name || 'there'},</p>
        <p>${approve
          ? `Your return request for order <strong>${existing.order_id}</strong> has been approved. Please ship the item(s) back to us — we'll email you again once we've received and inspected them.`
          : `We're not able to approve your return request for order <strong>${existing.order_id}</strong>.`}</p>
        ${adminNote ? `<p style="color:#6f5a5c;">Note from our team: ${adminNote}</p>` : ''}
      </div>`,
      userId: existing.user_id
    });
  }

  const updated = must(await supabase.from('return_requests').select('*').eq('id', existing.id).single(), 'decideReturn:reread');
  res.json({ return: await shapeAdminReturn(updated) });
}));

router.put('/returns/:id/receive', asyncRoute(async (req, res) => {
  const { itemRestock } = req.body || {}; // { [returnItemId]: true/false }
  const existing = must(await supabase.from('return_requests').select('*').eq('id', req.params.id).maybeSingle(), 'receiveReturn:lookup');
  if (!existing) return res.status(404).json({ message: 'Return request not found.' });
  if (existing.status !== 'Approved') return res.status(400).json({ message: 'Only an approved return can be marked received.' });

  const rpc = await supabase.rpc('return_mark_received', {
    p_return_id: existing.id, p_item_restock: itemRestock || {}, p_changed_by: req.adminName
  });
  if (rpc.error) throw new Error(rpc.error.message);

  await record(req, 'marked received', 'return_request', existing.id, { status: existing.status }, { status: 'Received', restocked: rpc.data });
  const updated = must(await supabase.from('return_requests').select('*').eq('id', existing.id).single(), 'receiveReturn:reread');
  res.json({ return: await shapeAdminReturn(updated) });
}));

router.put('/returns/:id/refund', asyncRoute(async (req, res) => {
  const { refundMethod, finalAmount } = req.body || {};
  const existing = must(await supabase.from('return_requests').select('*').eq('id', req.params.id).maybeSingle(), 'refundReturn:lookup');
  if (!existing) return res.status(404).json({ message: 'Return request not found.' });
  if (existing.status !== 'Received') return res.status(400).json({ message: 'Only a received return can be refunded.' });

  const method = refundMethod || existing.refund_method;
  if (!['original', 'bank_transfer', 'store_credit'].includes(method)) {
    return res.status(400).json({ message: 'Invalid refund method.' });
  }
  const amount = finalAmount != null ? Number(finalAmount) : existing.computed_refund_amount;
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ message: 'Enter a valid refund amount.' });
  }

  let couponCode;
  try {
    const rpc = await supabase.rpc('process_return_refund', {
      p_return_id: existing.id, p_order_id: existing.order_id, p_method: method, p_amount: amount
    });
    if (rpc.error) throw new Error(rpc.error.message);
    couponCode = rpc.data;
  } catch (e) {
    return res.status(500).json({ message: 'Could not process refund: ' + e.message });
  }

  await record(req, 'refunded', 'return_request', existing.id, { status: existing.status }, { status: 'Refunded', method, amount, couponCode });

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
      userId: existing.user_id
    });
  }

  const updated = must(await supabase.from('return_requests').select('*').eq('id', existing.id).single(), 'refundReturn:reread');
  res.json({ return: await shapeAdminReturn(updated) });
}));

// ---- Tracking settings ----
router.get('/settings/tracking', asyncRoute(async (req, res) => {
  res.json({ timing: await getSetting('tracking_timing', {}) });
}));

router.put('/settings/tracking', asyncRoute(async (req, res) => {
  const { timing } = req.body;
  if (!timing || typeof timing !== 'object') return res.status(400).json({ message: 'A timing object is required.' });
  for (const stage of STAGE_NAMES) {
    if (timing[stage] === undefined || isNaN(Number(timing[stage])) || Number(timing[stage]) < 0) {
      return res.status(400).json({ message: `Enter a valid hour count for "${stage}".` });
    }
  }
  await setSetting('tracking_timing', STAGE_NAMES.reduce((acc, s) => ({ ...acc, [s]: Number(timing[s]) }), {}));
  res.json({ timing: await getSetting('tracking_timing', {}) });
}));

// ---- Store / Shipping / Tax settings (Phase 7) ----
router.get('/settings/store', asyncRoute(async (req, res) => {
  res.json({ store: await getSetting('store_info', {}) });
}));

router.put('/settings/store', asyncRoute(async (req, res) => {
  const { brandName, logoUrl, faviconUrl, contactEmail, contactPhone, whatsapp, instagram, youtube } = req.body || {};
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
    whatsapp: whatsapp || '', instagram: instagram || '', youtube: youtube || ''
  };
  await setSetting('store_info', next);
  await record(req, 'settings updated', 'store_info', null, before, next);
  res.json({ store: next });
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

router.get('/settings/tax', asyncRoute(async (req, res) => {
  res.json({ tax: await getSetting('tax_settings', {}) });
}));

router.put('/settings/tax', asyncRoute(async (req, res) => {
  const { enabled, gstRate, label } = req.body || {};
  if (isNaN(Number(gstRate)) || Number(gstRate) < 0 || Number(gstRate) > 100) {
    return res.status(400).json({ message: 'GST rate must be a number between 0 and 100.' });
  }
  const before = await getSetting('tax_settings', {});
  const next = { enabled: !!enabled, gstRate: Number(gstRate), label: label || 'GST' };
  await setSetting('tax_settings', next);
  await record(req, 'settings updated', 'tax_settings', null, before, next);
  res.json({ tax: next });
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

router.put('/contact/:id/read', asyncRoute(async (req, res) => {
  must(await supabase.from('contact_messages').update({ read: true }).eq('id', Number(req.params.id)), 'markContactRead');
  res.json({ message: 'Marked as read.' });
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
      craft_type: craftType || 'Handloom', swatch: swatch || 'maroon', story: story || '', active: true,
      display_order: (maxOrder[0]?.display_order ?? -1) + 1
    }).select().single(), 'addFabric:insert');
    res.status(201).json({ fabric: inserted });
  } catch (e) {
    res.status(400).json({ message: isUniqueViolation(e) ? 'That name or slug is already in use.' : e.message });
  }
}));

router.put('/fabrics/:id', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('fabrics').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateFabric:lookup');
  if (!existing) return res.status(404).json({ message: 'Fabric not found.' });
  const { name, slug, shortDesc, fullDesc, region, state, craftType, swatch, story, active, displayOrder, heroImage, thumbnail } = req.body;
  const updated = must(await supabase.from('fabrics').update({
    name: name ?? existing.name, slug: slug ?? existing.slug, short_description: shortDesc ?? existing.short_description,
    full_description: fullDesc ?? existing.full_description, region: region ?? existing.region, state: state ?? existing.state,
    craft_type: craftType ?? existing.craft_type, swatch: swatch ?? existing.swatch, story: story ?? existing.story,
    active: active !== undefined ? !!active : existing.active,
    display_order: displayOrder !== undefined ? Number(displayOrder) : existing.display_order,
    hero_image: heroImage !== undefined ? heroImage : existing.hero_image, thumbnail: thumbnail !== undefined ? thumbnail : existing.thumbnail
  }).eq('id', existing.id).select().single(), 'updateFabric:update');
  res.json({ fabric: updated });
}));

router.delete('/fabrics/:id', asyncRoute(async (req, res) => {
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
router.post('/fabrics/:id/image', uploadSingle, asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('fabrics').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'fabricImage:lookup');
  if (!existing) return res.status(404).json({ message: 'Fabric not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const slot = req.body.slot === 'thumbnail' ? 'thumbnail' : 'hero_image';
  const updated = must(await supabase.from('fabrics').update({ [slot]: `/uploads/${req.file.filename}` }).eq('id', existing.id).select().single(), 'fabricImage:update');
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

router.put('/occasions/:id', asyncRoute(async (req, res) => {
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

router.delete('/occasions/:id', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('occasions').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'deleteOccasion:lookup');
  if (!existing) return res.status(404).json({ message: 'Occasion not found.' });
  const inUse = (await supabase.from('products').select('*', { count: 'exact', head: true }).eq('occasion', existing.name)).count || 0;
  if (inUse > 0) {
    must(await supabase.from('occasions').update({ active: false }).eq('id', existing.id), 'deleteOccasion:deactivate');
    return res.json({ message: `${inUse} product(s) still use "${existing.name}" — deactivated instead of deleted.`, deactivated: true });
  }
  must(await supabase.from('occasions').delete().eq('id', existing.id), 'deleteOccasion:delete');
  res.json({ message: 'Occasion deleted.', deactivated: false });
}));

router.post('/occasions/:id/image', uploadSingle, asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('occasions').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'occasionImage:lookup');
  if (!existing) return res.status(404).json({ message: 'Occasion not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const updated = must(await supabase.from('occasions').update({ image: `/uploads/${req.file.filename}` }).eq('id', existing.id).select().single(), 'occasionImage:update');
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

router.put('/badges/:id', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('badges').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateBadge:lookup');
  if (!existing) return res.status(404).json({ message: 'Badge not found.' });
  const { key, label, active, priority } = req.body;
  const updated = must(await supabase.from('badges').update({
    key: key ?? existing.key, label: label ?? existing.label, active: active !== undefined ? !!active : existing.active,
    priority: priority !== undefined ? Number(priority) : existing.priority
  }).eq('id', existing.id).select().single(), 'updateBadge:update');
  res.json({ badge: updated });
}));

router.delete('/badges/:id', asyncRoute(async (req, res) => {
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
router.get('/collections', asyncRoute(async (req, res) => {
  res.json({ collections: await getCollections({ activeOnly: false }) });
}));

router.post('/collections', asyncRoute(async (req, res) => {
  const { name, slug, description, startDate, endDate } = req.body;
  if (!name || !slug) return res.status(400).json({ message: 'Name and slug are required.' });
  try {
    const maxOrder = must(await supabase.from('collections').select('display_order').order('display_order', { ascending: false }).limit(1), 'addCollection:maxOrder');
    const inserted = must(await supabase.from('collections').insert({
      name, slug, description: description || '', active: true, display_order: (maxOrder[0]?.display_order ?? -1) + 1,
      start_date: startDate || null, end_date: endDate || null
    }).select().single(), 'addCollection:insert');
    res.status(201).json({ collection: { ...inserted, productIds: [] } });
  } catch (e) {
    res.status(400).json({ message: isUniqueViolation(e) ? 'That slug is already in use.' : e.message });
  }
}));

router.put('/collections/:id', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('collections').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateCollection:lookup');
  if (!existing) return res.status(404).json({ message: 'Collection not found.' });
  const { name, slug, description, active, displayOrder, startDate, endDate, bannerImage, thumbnail } = req.body;
  const updated = must(await supabase.from('collections').update({
    name: name ?? existing.name, slug: slug ?? existing.slug, description: description ?? existing.description,
    active: active !== undefined ? !!active : existing.active,
    display_order: displayOrder !== undefined ? Number(displayOrder) : existing.display_order,
    start_date: startDate !== undefined ? startDate : existing.start_date, end_date: endDate !== undefined ? endDate : existing.end_date,
    banner_image: bannerImage !== undefined ? bannerImage : existing.banner_image, thumbnail: thumbnail !== undefined ? thumbnail : existing.thumbnail
  }).eq('id', existing.id).select().single(), 'updateCollection:update');
  res.json({ collection: { ...updated, productIds: await getCollectionProductIds(existing.id) } });
}));

router.delete('/collections/:id', asyncRoute(async (req, res) => {
  must(await supabase.from('collection_products').delete().eq('collection_id', Number(req.params.id)), 'deleteCollection:products');
  must(await supabase.from('collections').delete().eq('id', Number(req.params.id)), 'deleteCollection:collection');
  res.json({ message: 'Collection deleted.' });
}));

// slot is 'banner' or 'thumbnail'
router.post('/collections/:id/image', uploadSingle, asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('collections').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'collectionImage:lookup');
  if (!existing) return res.status(404).json({ message: 'Collection not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const slot = req.body.slot === 'thumbnail' ? 'thumbnail' : 'banner_image';
  const updated = must(await supabase.from('collections').update({ [slot]: `/uploads/${req.file.filename}` }).eq('id', existing.id).select().single(), 'collectionImage:update');
  res.json({ collection: { ...updated, productIds: await getCollectionProductIds(existing.id) } });
}));

// Replaces the full product list for a collection in one call — simpler for
// an admin picker UI than diffing individual add/remove requests. Done via
// the replace_collection_products() Postgres function so the collection is
// never transiently empty to a concurrent reader.
router.put('/collections/:id/products', asyncRoute(async (req, res) => {
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
  const next = { ...current, ...req.body };
  await setSetting('hero_banner', next);
  res.json({ hero: next });
}));

router.post('/content/hero/image', uploadSingle, asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const current = await getSetting('hero_banner', {});
  const next = { ...current, desktopImage: `/uploads/${req.file.filename}` };
  await setSetting('hero_banner', next);
  res.json({ hero: next });
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

router.put('/reels/:id', asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('reel_items').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'updateReel:lookup');
  if (!existing) return res.status(404).json({ message: 'Reel item not found.' });
  const { active, sortOrder, clearVideo, clearThumbnail } = req.body;
  const updated = must(await supabase.from('reel_items').update({
    active: active !== undefined ? !!active : existing.active,
    sort_order: sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
    video_url: clearVideo ? null : existing.video_url,
    thumbnail_url: clearThumbnail ? null : existing.thumbnail_url
  }).eq('id', existing.id).select().single(), 'updateReel:update');
  res.json({ reelItem: updated });
}));

router.delete('/reels/:id', asyncRoute(async (req, res) => {
  must(await supabase.from('reel_items').delete().eq('id', Number(req.params.id)), 'deleteReel');
  res.json({ message: 'Removed from Sarees in Motion.' });
}));

router.post('/reels/:id/video', uploadSingle, asyncRoute(async (req, res) => {
  const existing = must(await supabase.from('reel_items').select('*').eq('id', Number(req.params.id)).maybeSingle(), 'reelVideo:lookup');
  if (!existing) return res.status(404).json({ message: 'Reel item not found.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const isVideo = req.file.mimetype.startsWith('video');
  const field = isVideo ? 'video_url' : 'thumbnail_url';
  const updated = must(await supabase.from('reel_items').update({ [field]: `/uploads/${req.file.filename}` }).eq('id', existing.id).select().single(), 'reelVideo:update');
  res.json({ reelItem: updated });
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

router.put('/faq/:id', asyncRoute(async (req, res) => {
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

router.delete('/faq/:id', asyncRoute(async (req, res) => {
  must(await supabase.from('faq_items').delete().eq('id', Number(req.params.id)), 'deleteFaq');
  res.json({ message: 'FAQ item deleted.' });
}));

// ---- Customers ----
router.get('/customers', asyncRoute(async (req, res) => {
  const users = must(await supabase.from('users').select('*').eq('is_admin', false).order('created_at', { ascending: false }), 'listCustomers');
  const userIds = users.map(u => u.id);
  const orders = userIds.length ? must(await supabase.from('orders').select('user_id, total, cancelled_at, placed_at').in('user_id', userIds), 'listCustomers:orders') : [];
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
        id: c.id, name: c.name, email: c.email, phone: c.phone, status: c.status || 'active',
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
      status: r.status, createdAt: r.created_at
    }))
  });
}));

router.put('/reviews/:id', asyncRoute(async (req, res) => {
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

router.delete('/reviews/:id', asyncRoute(async (req, res) => {
  must(await supabase.from('reviews').delete().eq('id', Number(req.params.id)), 'deleteReview');
  await record(req, 'deleted', 'review', req.params.id);
  res.json({ message: 'Review deleted.' });
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
  const purchasedItems = orderIds.length ? must(await supabase.from('order_items').select('order_id, product_id').in('order_id', orderIds), 'wishlistAnalytics:items') : [];
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
  const rows = must(await supabase.from('admin_activity_log').select('*').order('created_at', { ascending: false }).limit(200), 'activityLog');
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
