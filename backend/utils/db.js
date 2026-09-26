// Postgres via Supabase (async, service_role — bypasses Row Level Security by
// design, mirroring the full local access better-sqlite3 always had). The
// schema, indexes and RLS-enable-with-zero-policies setup already live in
// Supabase as migrations; this module only talks to the tables, it does not
// create them. Every function below is async now — every caller must await
// it (route files are being converted alongside this file).
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

// Defensive — server.js already loads backend/.env before requiring any
// route file, but any script that requires this module directly (a one-off
// migration/backup script, for instance) still gets the right env vars.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PRODUCTS_SEED_PATH = path.join(__dirname, '..', 'data', 'products.json');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing from backend/.env — see backend/.env.example.');
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// PostgREST returns { data, error } instead of throwing — this centralizes
// "throw on error, hand back data" so every call site below stays terse.
function must(result, context) {
  if (result.error) {
    const err = new Error(`[db:${context}] ${result.error.message}`);
    err.cause = result.error;
    throw err;
  }
  return result.data;
}

function groupBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row[key];
    (out[k] || (out[k] = [])).push(row);
  }
  return out;
}

async function tableCount(table) {
  const result = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (result.error) throw new Error(`[db:tableCount:${table}] ${result.error.message}`);
  return result.count || 0;
}

// ---- Variants (Phase 1) ----
async function getVariantMedia(variantId) {
  return must(await supabase.from('variant_media').select('*').eq('variant_id', variantId).order('sort_order').order('id'), 'getVariantMedia');
}

async function getVariants(productId) {
  const variants = must(
    await supabase.from('product_variants').select('*').eq('product_id', productId).eq('archived', false).order('sort_order').order('id'),
    'getVariants'
  );
  return Promise.all(variants.map(async v => ({ ...v, media: await getVariantMedia(v.id) })));
}

async function getVariantById(id) {
  const v = must(await supabase.from('product_variants').select('*').eq('id', id).maybeSingle(), 'getVariantById');
  if (!v) return null;
  return { ...v, media: await getVariantMedia(v.id) };
}

async function getDefaultVariant(productId) {
  const rows = must(
    await supabase.from('product_variants').select('*').eq('product_id', productId).eq('archived', false)
      .order('is_default', { ascending: false }).order('sort_order').order('id').limit(1),
    'getDefaultVariant'
  );
  return rows[0] || null;
}

// Keeps products.price/mrp/stock/swatch (the aggregate fields the rest of the
// app already reads for cards/filters/sort) in sync whenever the *default*
// variant changes. Delegated to the sync_product_mirror() Postgres function
// so every code path (this JS call, and the place_order/return RPCs below)
// shares one implementation.
async function syncProductMirrorFromDefaultVariant(productId) {
  const result = await supabase.rpc('sync_product_mirror', { p_product_id: productId });
  if (result.error) throw new Error(`[db:syncProductMirrorFromDefaultVariant] ${result.error.message}`);
}

// Blends each product's seed rating/review-count with any real reviews
// submitted since, using a weighted average — computed in the products_blended
// Postgres view (see the product_view_and_order_functions migration) instead
// of a JS-side join.
function shapeBlended(row) {
  return { ...row, rating: row.blended_rating, reviews_count: row.blended_count };
}

async function attachVariants(products) {
  const ids = products.map(p => p.id);
  if (!ids.length) return products;
  const variants = must(
    await supabase.from('product_variants').select('*').in('product_id', ids).eq('archived', false).order('sort_order').order('id'),
    'attachVariants:variants'
  );
  const variantIds = variants.map(v => v.id);
  const media = variantIds.length
    ? must(await supabase.from('variant_media').select('*').in('variant_id', variantIds).order('sort_order').order('id'), 'attachVariants:media')
    : [];
  const mediaByVariant = groupBy(media, 'variant_id');
  const variantsByProduct = groupBy(variants.map(v => ({ ...v, media: mediaByVariant[v.id] || [] })), 'product_id');
  return products.map(p => ({ ...p, variants: variantsByProduct[p.id] || [] }));
}

async function getProducts() {
  const rows = must(await supabase.from('products_blended').select('*').order('id'), 'getProducts');
  return attachVariants(rows.map(shapeBlended));
}

async function getProductById(id) {
  const row = must(await supabase.from('products_blended').select('*').eq('id', id).maybeSingle(), 'getProductById');
  if (!row) return null;
  const [withVariants] = await attachVariants([shapeBlended(row)]);
  return withVariants;
}

// Sarees in Motion — a curated, reorderable list of reel_items rows (Phase 4),
// each carrying its own uploaded video/thumbnail that overrides whatever the
// underlying product has.
async function getReelItems({ activeOnly = true } = {}) {
  let query = supabase.from('reel_items').select('*').order('sort_order').order('id');
  if (activeOnly) query = query.eq('active', true);
  const items = must(await query, 'getReelItems');
  if (!items.length) return [];
  const productIds = items.map(i => i.product_id);
  const products = must(
    await supabase.from('products').select('id, name, fabric, price, mrp, swatch, status').in('id', productIds),
    'getReelItems:products'
  );
  const productById = Object.fromEntries(products.map(p => [p.id, p]));
  // Product fields spread first so the reel_item's own columns (id, active,
  // sort_order, video_url, thumbnail_url) always win — a product's own `id`
  // must never leak in and overwrite the reel_item's id (they're rows in
  // different tables and mean completely different things).
  const rows = items.map(item => ({ ...(productById[item.product_id] || {}), ...item, product_status: productById[item.product_id]?.status }));
  return activeOnly ? rows.filter(r => r.product_status !== 'archived') : rows;
}

async function getReelProducts() {
  const items = await getReelItems({ activeOnly: true });
  const products = await Promise.all(items.map(async r => {
    const product = await getProductById(r.product_id);
    if (!product) return null;
    return { ...product, reel_video: r.video_url, reel_thumbnail: r.thumbnail_url, reel_item_id: r.id };
  }));
  return products.filter(Boolean);
}

// ---- FAQ (Phase 4) ----
async function getFaqItems({ activeOnly = true } = {}) {
  let query = supabase.from('faq_items').select('*').order('display_order').order('id');
  if (activeOnly) query = query.eq('active', true);
  return must(await query, 'getFaqItems');
}

// ---- Catalog taxonomy (Phase 3) ----
async function getFabrics({ activeOnly = true } = {}) {
  let query = supabase.from('fabrics').select('*').order('display_order').order('name');
  if (activeOnly) query = query.eq('active', true);
  const rows = must(await query, 'getFabrics');
  const products = must(await supabase.from('products').select('fabric').neq('status', 'archived'), 'getFabrics:counts');
  const countMap = {};
  products.forEach(p => { countMap[p.fabric] = (countMap[p.fabric] || 0) + 1; });
  return rows.map(f => ({ ...f, productCount: countMap[f.name] || 0 }));
}

async function getOccasions({ activeOnly = true } = {}) {
  let query = supabase.from('occasions').select('*').order('display_order').order('name');
  if (activeOnly) query = query.eq('active', true);
  const rows = must(await query, 'getOccasions');
  const products = must(await supabase.from('products').select('occasion').neq('status', 'archived'), 'getOccasions:counts');
  const countMap = {};
  products.forEach(p => { countMap[p.occasion] = (countMap[p.occasion] || 0) + 1; });
  return rows.map(o => ({ ...o, productCount: countMap[o.name] || 0 }));
}

async function getBadges({ activeOnly = false } = {}) {
  let query = supabase.from('badges').select('*').order('priority').order('label');
  if (activeOnly) query = query.eq('active', true);
  return must(await query, 'getBadges');
}

async function getCollectionProductIds(collectionId) {
  const rows = must(await supabase.from('collection_products').select('product_id').eq('collection_id', collectionId), 'getCollectionProductIds');
  return rows.map(r => r.product_id);
}

async function getCollections({ activeOnly = true } = {}) {
  let query = supabase.from('collections').select('*').order('display_order').order('name');
  if (activeOnly) query = query.eq('active', true);
  const rows = must(await query, 'getCollections');
  return Promise.all(rows.map(async c => ({ ...c, productIds: await getCollectionProductIds(c.id) })));
}

async function getCollectionBySlug(slug) {
  const row = must(await supabase.from('collections').select('*').eq('slug', slug).eq('active', true).maybeSingle(), 'getCollectionBySlug');
  if (!row) return null;
  return { ...row, productIds: await getCollectionProductIds(row.id) };
}

// ---- Settings (generic key/value store) ----
async function getSetting(key, fallback) {
  const row = must(await supabase.from('settings').select('value').eq('key', key).maybeSingle(), 'getSetting');
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

async function setSetting(key, value) {
  must(await supabase.from('settings').upsert({ key, value: JSON.stringify(value) }, { onConflict: 'key' }), 'setSetting');
}

// ---- Phase 5 (search analytics) ----
async function logSearchQuery(query, resultCount) {
  const trimmed = (query || '').trim();
  if (!trimmed) return;
  must(
    await supabase.from('search_queries').insert({ query: trimmed.toLowerCase(), result_count: resultCount, created_at: new Date().toISOString() }),
    'logSearchQuery'
  );
}

// ---- Phase 6 (admin auth & governance) ----
const ADMIN_ROLES = ['Super Admin', 'Catalog Manager', 'Order Manager', 'Customer Support', 'Content Manager'];

async function logActivity({ adminId, adminName, action, entity, entityId, before, after }) {
  must(await supabase.from('admin_activity_log').insert({
    admin_id: adminId, admin_name: adminName, action, entity,
    entity_id: entityId != null ? String(entityId) : null,
    before_value: before !== undefined ? JSON.stringify(before) : null,
    after_value: after !== undefined ? JSON.stringify(after) : null,
    created_at: new Date().toISOString()
  }), 'logActivity');
}

async function logNotification({ orderId, userId, channel, recipient, subject, status, detail }) {
  must(await supabase.from('notifications_log').insert({
    order_id: orderId || null, user_id: userId || null, channel, recipient: recipient || null,
    subject: subject || null, status, detail: detail || null, created_at: new Date().toISOString()
  }), 'logNotification');
}

// ==== One-time / every-boot seed & backfill (ported from the SQLite version,
// same guards — a truly fresh Supabase project self-seeds exactly once; this
// project's real data was already migrated in directly, so `demo_data_seeded`
// is already true and none of this fires again). ====

const DEFAULT_TRACKING_TIMING = { Confirmed: 0, Packed: 1, Shipped: 24, 'Out for Delivery': 72, Delivered: 120 };
const DEFAULT_STORE_INFO = {
  brandName: 'Padmora by Yashi', logoUrl: '', faviconUrl: '',
  contactEmail: 'hello@padmorasarees.com', contactPhone: '+91 98765 43210', whatsapp: '+91 98765 43210',
  instagram: '', youtube: ''
};
const DEFAULT_SHIPPING_SETTINGS = { fee: 79, freeShippingThreshold: 1999, regions: ['All India'], estimatedDays: '5–7 business days' };
const DEFAULT_TAX_SETTINGS = { enabled: true, gstRate: 5, label: 'GST' };
const DEFAULT_RETURN_POLICY = { enabled: true, windowDays: 7 };

const WEAVER_INFO = {
  'Maheshwari': { weaver_name: 'Maheshwar Handloom Cooperative', weaver_region: 'Maheshwar, Madhya Pradesh', loom_type: 'Handloom' },
  'Ajrakh': { weaver_name: 'Ajrakhpur Block Printers', weaver_region: 'Ajrakhpur, Kutch, Gujarat', loom_type: 'Handcrafted (block-printed)' },
  'Paithani': { weaver_name: 'Paithan Silk Weavers Guild', weaver_region: 'Paithan, Maharashtra', loom_type: 'Handloom' },
  'Narayanpeth': { weaver_name: 'Narayanpet Weavers Cooperative', weaver_region: 'Narayanpet, Telangana', loom_type: 'Handloom' }
};
const STOCK_BY_ID = { 1: 22, 2: 34, 3: 19, 4: 27, 5: 16, 6: 9, 7: 4, 8: 6, 9: 11, 10: 38, 11: 24, 12: 30 };
const LEGACY_REEL_PRODUCT_IDS = [7, 4, 10, 3, 8, 1, 11, 9];

const SEED_REVIEWS = [
  [1, 'Priya Deshmukh', 5, 'Perfect for office', 'Lightweight and the reversible border is such a smart touch — I can wear it two ways. True to the photos.', true, 40],
  [1, 'Anjali Rao', 4, 'Lovely fabric, runs slightly sheer', 'Beautiful sandstone shade, drapes well. Just a bit sheer so I wore a matching underskirt.', true, 22],
  [2, 'Meenal Joshi', 4, 'Soft and comfortable', 'The check pattern is subtle and elegant, great for daily wear. Colour is slightly lighter than the photo but still lovely.', true, 33],
  [2, 'Sneha Kulkarni', 5, 'Exceeded expectations', 'Wore this to work all week, so breathable. The gold-edged pallu adds just the right festive touch.', false, 15],
  [3, 'Radhika Iyer', 5, 'Gorgeous zari border', 'The five-stripe pallu is stunning in person. Got so many compliments at the Diwali puja.', true, 50],
  [3, 'Kavita Nair', 5, 'Authentic weave', 'You can tell this is genuine handloom — the texture and weight feel just right. Loved it.', true, 12],
  [4, 'Farah Sheikh', 5, 'Absolutely stunning print', 'Every motif is crisp and the indigo is deep and rich. Proud to own a real Ajrakh piece.', true, 45],
  [4, 'Nikita Shah', 4, 'Beautiful but needs care', 'Gorgeous saree, just make sure to dry clean the first time — colour held up well after that.', true, 19],
  [5, 'Pooja Malhotra', 5, 'Rich colour, authentic craft', 'The madder-red is even richer in person. You can see the hand-block imperfections that make it special.', true, 37],
  [5, 'Divya Menon', 4, 'Great quality cotton', 'Comfortable all-day wear, the print is intricate. Slightly stiff on first wear but softens after a wash.', false, 9],
  [6, 'Ritu Bhatia', 5, 'Elegant and unique', 'Loved the deep charcoal base — very versatile, easy to dress up or down.', true, 28],
  [6, 'Ananya Ghosh', 4, 'Nice everyday piece', 'Good quality fabric, geometric pattern looks classy. Wish the border was slightly wider.', true, 6],
  [7, 'Shreya Kapoor', 5, 'Heirloom quality', 'This is the real deal — the peacock pallu is breathtaking. Wore it for my sister’s wedding, felt like royalty.', true, 55],
  [7, 'Isha Agarwal', 5, 'Worth every rupee', 'Heavy, rich silk with real zari. Took my mother’s breath away when she saw it.', true, 30],
  [8, 'Neha Reddy', 5, 'Stunning bridal choice', 'The asawali border and peacock pallu are pure art. Perfect for my reception.', true, 41],
  [8, 'Swati Verma', 4, 'Beautiful but heavy', 'Gorgeous saree, quite heavy so pair with a sturdy petticoat. Colour is richer than the photos.', true, 17],
  [9, 'Alisha Pillai', 5, 'Loved the lotus border', 'The kadiyal weave technique really shows — colours are vivid and the border is intricate.', true, 25],
  [9, 'Tanvi Choudhary', 4, 'Elegant festive pick', 'Beautiful emerald shade, wore it for Diwali and got endless compliments.', false, 8],
  [10, 'Lakshmi Subramaniam', 5, 'Classic and elegant', 'The temple border is beautifully woven, feels premium for the price. Perfect for pujas.', true, 48],
  [10, 'Geeta Krishnan', 4, 'Great daily-festive wear', 'Good quality cotton-silk, colours are vibrant. Slightly stiff initially but drapes beautifully after a wash.', true, 20],
  [11, 'Priyanka Bose', 5, 'Vibrant and fun', 'Loved the fuchsia shade and the checks give it a modern twist on tradition.', true, 34],
  [11, 'Ruchika Desai', 4, 'Great party saree', 'Wore this to a friend’s sangeet, very comfortable and the zari border catches light beautifully.', false, 11],
  [12, 'Vidya Menon', 4, 'Simple and graceful', 'Perfect for everyday grace like the description says. Ivory shade is soft and elegant.', true, 26],
  [12, 'Sarita Pillai', 4, 'Good value', 'Nice contrast border, comfortable cotton. Great for casual family functions.', true, 4]
];

async function seedIfEmpty() {
  if (await tableCount('products') === 0) {
    const raw = fs.readFileSync(PRODUCTS_SEED_PATH, 'utf-8');
    const products = JSON.parse(raw);
    const rows = products.map(p => {
      const w = WEAVER_INFO[p.fabric] || { weaver_name: 'Independent Weaver Partner', weaver_region: 'India', loom_type: 'Handloom' };
      return {
        id: p.id, name: p.name, fabric: p.fabric, occasion: p.occasion, price: p.price, mrp: p.mrp,
        rating: p.rating, reviews_count: p.reviews, badge: p.badge, swatch: p.swatch, description: p.desc,
        stock: STOCK_BY_ID[p.id] ?? 20, weaver_name: w.weaver_name, weaver_region: w.weaver_region, loom_type: w.loom_type
      };
    });
    must(await supabase.from('products').insert(rows), 'seedIfEmpty:products');
  }

  if (await tableCount('coupons') === 0) {
    must(await supabase.from('coupons').insert([
      { code: 'WELCOME10', type: 'percent', value: 10, min_subtotal: 0, max_discount: 1000, active: true },
      { code: 'PADMORA40', type: 'percent', value: 40, min_subtotal: 5000, max_discount: 3000, active: true },
      { code: 'FEST500', type: 'flat', value: 500, min_subtotal: 2500, max_discount: 500, active: true }
    ]), 'seedIfEmpty:coupons');
  }
}

async function seedTaxonomy() {
  if (await tableCount('fabrics') === 0) {
    must(await supabase.from('fabrics').insert([
      { name: 'Maheshwari', slug: 'maheshwari', region: 'Maheshwar', state: 'Madhya Pradesh', craft_type: 'Handloom', swatch: 'mustard', display_order: 0, active: true,
        short_description: 'Lightweight cotton-silk with a signature reversible border.',
        full_description: 'Lightweight cotton-silk with a signature reversible border, woven on pit looms since Rani Ahilyabai Holkar’s court in the 18th century.',
        story: 'Woven on pit looms in Maheshwar on the banks of the Narmada, a tradition dating back to Rani Ahilyabai Holkar’s 18th-century court.' },
      { name: 'Ajrakh', slug: 'ajrakh', region: 'Ajrakhpur, Kutch', state: 'Gujarat', craft_type: 'Handcrafted', swatch: 'indigo', display_order: 1, active: true,
        short_description: 'Hand block-printed with natural indigo and madder dyes.',
        full_description: 'Hand block-printed with natural indigo and madder dyes through a multi-day resist-printing process — a craft, not a print.',
        story: 'Each length passes through a multi-day natural-dye resist-printing process perfected over generations in Ajrakhpur, Kutch.' },
      { name: 'Paithani', slug: 'paithani', region: 'Paithan', state: 'Maharashtra', craft_type: 'Handloom', swatch: 'wine', display_order: 2, active: true,
        short_description: 'Pure silk with a hand-woven peacock-motif pallu.',
        full_description: 'Pure silk woven with real zari, famous for its hand-woven peacock-motif pallu — once reserved for Maratha royalty and still taking over a month per piece.',
        story: 'Once reserved for Maratha royalty, a single Paithani pallu can take over a month to hand-weave with real zari.' },
      { name: 'Narayanpeth', slug: 'narayanpeth', region: 'Narayanpet', state: 'Telangana', craft_type: 'Handloom', swatch: 'maroon', display_order: 3, active: true,
        short_description: 'Checked cotton-silk body with a bold temple border.',
        full_description: 'Cotton-silk with a checked body and a bold contrast temple border, woven in handloom clusters on the Telangana-Karnataka border.',
        story: 'Woven in handloom clusters straddling the Telangana-Karnataka border, known for its bold contrast temple borders.' }
    ]), 'seedTaxonomy:fabrics');
  }

  if (await tableCount('occasions') === 0) {
    must(await supabase.from('occasions').insert([
      { name: 'Wedding', slug: 'wedding', description: 'Bridal and trousseau-worthy silks.', featured_on_home: true, home_card_title: 'Wedding Silks', active: true, display_order: 0 },
      { name: 'Festive', slug: 'festive', description: 'Zari-rich weaves for Diwali, pujas and celebrations.', featured_on_home: true, home_card_title: 'Festive Edit', active: true, display_order: 1 },
      { name: 'Casual', slug: 'casual', description: 'Everyday cottons that are easy to drape and wear.', featured_on_home: true, home_card_title: 'Everyday Cottons', active: true, display_order: 2 },
      { name: 'Party', slug: 'party', description: 'Statement pieces for evenings out.', featured_on_home: false, home_card_title: '', active: true, display_order: 3 },
      { name: 'Office', slug: 'office', description: 'Lightweight weaves built for a full workday.', featured_on_home: false, home_card_title: '', active: true, display_order: 4 }
    ]), 'seedTaxonomy:occasions');
  }

  if (await tableCount('badges') === 0) {
    must(await supabase.from('badges').insert([
      { key: 'new', label: 'New Arrival', active: true, priority: 0 },
      { key: 'bestseller', label: 'Bestseller', active: true, priority: 1 },
      { key: 'sale', label: 'Sale', active: true, priority: 2 }
    ]), 'seedTaxonomy:badges');
  }

  if (await tableCount('collections') === 0) {
    const collection = must(
      await supabase.from('collections').insert({ name: 'Festive Edit', slug: 'festive-edit', description: 'Zari-rich picks curated for the festive season.', active: true, display_order: 0 }).select().single(),
      'seedTaxonomy:collection'
    );
    const festive = must(await supabase.from('products').select('id').eq('occasion', 'Festive').limit(4), 'seedTaxonomy:festiveProducts');
    if (festive.length) {
      must(await supabase.from('collection_products').upsert(festive.map(p => ({ collection_id: collection.id, product_id: p.id })), { onConflict: 'collection_id,product_id' }), 'seedTaxonomy:collectionProducts');
    }
  }
}

async function seedStorefrontContent() {
  if (await tableCount('reel_items') === 0) {
    const rows = [];
    for (let i = 0; i < LEGACY_REEL_PRODUCT_IDS.length; i++) {
      const product = must(await supabase.from('products').select('reel_video').eq('id', LEGACY_REEL_PRODUCT_IDS[i]).maybeSingle(), 'seedStorefrontContent:product');
      if (product) rows.push({ product_id: LEGACY_REEL_PRODUCT_IDS[i], video_url: product.reel_video || null, active: true, sort_order: i });
    }
    if (rows.length) must(await supabase.from('reel_items').insert(rows), 'seedStorefrontContent:reelItems');
  }

  if (await tableCount('faq_items') === 0) {
    const rows = [
      ['How do I know a saree is genuinely handloom and not powerloom?', 'Every product page has a "Loom-to-You" card that names the weaver or weaving house, their region, and states plainly whether the piece is Handloom, Powerloom, or Handcrafted. We disclose powerloom pieces honestly instead of marketing them as handloom — see our Our Weaves page for more.', 'Product'],
      ['Does the saree come with a stitched blouse?', 'Every saree ships with an unstitched matching blouse piece (0.8m), as is traditional. We don’t currently offer blouse stitching services — we recommend a trusted local tailor for the perfect fit.', 'Product'],
      ['What if the color looks different from the photo?', 'We photograph every saree in natural daylight to keep colors as true as possible, but screens vary. If the saree you receive doesn’t match reasonably, it qualifies for our 7-day return/exchange window, no questions asked.', 'Shipping'],
      ['What are my delivery options and timelines?', 'Standard delivery takes 4-7 business days across India. Free shipping applies on orders above ₹2,999. We currently ship only within India.', 'Shipping'],
      ['What payment methods do you accept?', 'We accept UPI (Google Pay, PhonePe, Paytm) and major debit/credit cards at checkout. We don’t currently offer Cash on Delivery.', 'Payment'],
      ['What is your return and exchange policy?', 'Unused sarees with tags intact can be returned or exchanged within 7 days of delivery. See our Shipping & Returns page for the full policy.', 'Shipping'],
      ['Can I order in bulk?', 'Yes — message us via Contact Us and mention "Bulk Order" in the subject. Our team will follow up with a bundle discount for 5+ sarees.', 'Orders'],
      ['How should I care for my saree?', 'Paithani, being pure silk, should be dry-cleaned only. Maheshwari, Ajrakh, and Narayanpet are cotton-silk or cotton weaves that can be gently hand-washed in cold water and dried in shade — Ajrakh especially benefits from a cold, separate first wash to set the natural dyes.', 'Care']
    ].map((r, i) => ({ question: r[0], answer: r[1], category: r[2], active: true, display_order: i }));
    must(await supabase.from('faq_items').insert(rows), 'seedStorefrontContent:faqItems');
  }

  if (await getSetting('hero_banner', null) === null) {
    await setSetting('hero_banner', {
      eyebrow: 'Handwoven · Since Generations',
      headingPre: 'Drape a story', headingEm: 'woven', headingPost: 'in silk and gold',
      subheading: 'From the looms of Maheshwar, Paithan and Narayanpet to the hand block-printers of Kutch — discover sarees curated for weddings, festivals, and everyday elegance.',
      ctaText: 'Shop The Edit', ctaLink: '/shop',
      badgeLabel: 'Featured Weave', badgeValue: 'Paithani Silk',
      desktopImage: null, active: true
    });
  }

  if (await getSetting('promo_band', null) === null) {
    await setSetting('promo_band', {
      eyebrow: 'Limited Time', heading: 'The Festive Sale — Up to 40% Off',
      message: 'Use code {CODE} at checkout on select Paithani & Ajrakh sarees',
      couponCode: 'PADMORA40', ctaText: 'Shop The Sale', ctaLink: '/shop',
      startDate: null, endDate: null, active: true
    });
  }
}

// Every product needs at least one variant to be purchasable. Any product
// with zero rows in product_variants gets a single "default" variant
// backfilled from its own price/mrp/stock/swatch/description — runs on every
// boot, no-op once a product has variants.
async function backfillDefaultVariants() {
  const products = must(await supabase.from('products').select('*'), 'backfillDefaultVariants:products');
  const variants = must(await supabase.from('product_variants').select('product_id'), 'backfillDefaultVariants:variants');
  const hasVariant = new Set(variants.map(v => v.product_id));
  const rows = products.filter(p => !hasVariant.has(p.id)).map(p => ({
    product_id: p.id,
    color_name: (p.swatch || 'maroon').replace(/^\w/, c => c.toUpperCase()),
    swatch: p.swatch || 'maroon',
    sku: `PDM-${p.id}-DEF`,
    price: p.price, mrp: p.mrp, stock: p.stock, description: p.description || '',
    is_default: true, sort_order: 0
  }));
  if (rows.length) must(await supabase.from('product_variants').insert(rows), 'backfillDefaultVariants:insert');
}

async function seedReviews() {
  if (await tableCount('reviews') > 0) return;
  const rows = SEED_REVIEWS.map((r, i) => {
    const [productId, userName, rating, title, body, verified, daysAgo] = r;
    return {
      product_id: productId, user_id: `seed_u${i + 1}`, user_name: userName, rating, title, body,
      verified, created_at: new Date(Date.now() - daysAgo * 86400000).toISOString()
    };
  });
  must(await supabase.from('reviews').insert(rows), 'seedReviews');
}

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@padmora.store';
  const existing = must(await supabase.from('users').select('id').ilike('email', email).maybeSingle(), 'seedAdmin:lookup');
  if (existing) {
    must(await supabase.from('users').update({ is_admin: true }).eq('id', existing.id), 'seedAdmin:update');
    return;
  }
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const id = 'admin_' + Date.now().toString(36);
  must(await supabase.from('users').insert({
    id, name: 'Padmora Admin', email, password: bcrypt.hashSync(password, 10),
    phone: '', address_line1: '', address_city: '', address_state: '', address_pincode: '',
    created_at: new Date().toISOString(), is_admin: true
  }), 'seedAdmin:insert');
}

async function seedAdminUsers() {
  if (await tableCount('admin_users') > 0) return;
  const email = process.env.ADMIN_EMAIL || 'admin@padmora.store';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const id = 'adm_' + Date.now().toString(36);
  must(await supabase.from('admin_users').insert({
    id, name: 'Yashi (Founder)', email, password: bcrypt.hashSync(password, 10),
    role: 'Super Admin', active: true, created_at: new Date().toISOString()
  }), 'seedAdminUsers');
}

// Runs once at module load, awaited by server.js before app.listen(). Demo
// catalog/taxonomy/review/coupon seed data only ever populates a truly fresh
// database — guarded by the same `demo_data_seeded` settings flag migrated
// over from SQLite (already true for this project, so none of it re-fires;
// it only matters if this schema is ever stood up fresh again).
const ready = (async () => {
  if (!(await getSetting('demo_data_seeded', false))) {
    await seedIfEmpty();
    await seedReviews();
    await seedTaxonomy();
    await seedStorefrontContent();
    await setSetting('demo_data_seeded', true);
  }
  if (await getSetting('tracking_timing', null) === null) await setSetting('tracking_timing', DEFAULT_TRACKING_TIMING);
  if (await getSetting('store_info', null) === null) await setSetting('store_info', DEFAULT_STORE_INFO);
  if (await getSetting('shipping_settings', null) === null) await setSetting('shipping_settings', DEFAULT_SHIPPING_SETTINGS);
  if (await getSetting('tax_settings', null) === null) await setSetting('tax_settings', DEFAULT_TAX_SETTINGS);
  if (await getSetting('return_policy', null) === null) await setSetting('return_policy', DEFAULT_RETURN_POLICY);
  await backfillDefaultVariants();
  await seedAdmin();
  await seedAdminUsers();
})();

module.exports = {
  supabase, ready,
  getProducts, getProductById, getReelProducts,
  getVariants, getVariantById, getVariantMedia, getDefaultVariant, syncProductMirrorFromDefaultVariant,
  getSetting, setSetting,
  getFabrics, getOccasions, getBadges, getCollections, getCollectionBySlug, getCollectionProductIds,
  getReelItems, getFaqItems, logSearchQuery,
  ADMIN_ROLES, logActivity,
  logNotification,
  must, tableCount
};
