// What the public storefront pages ask for, kept in memory (see cache.js) so a page view costs no database round trips.
// The shaping used to live inside the route files; the routes and the one-call "bootstrap" / "home" bundles below now share it.
const { swr } = require('./cache');
const { getSetting, getProducts, getFabrics, getOccasions, getCollections, getCollectionBySlug, getReelProducts, getProductByIdFast } = require('./db');
const { toListShape } = require('./shape');
const { DEFAULT_FOOTER } = require('./footerConfig');
const { DEFAULT_ANNOUNCEMENT, DEFAULT_WEAVE_SECTION } = require('./homeSections');

function fabricShape(f) {
  return {
    id: f.id, name: f.name, slug: f.slug, shortDesc: f.short_description, fullDesc: f.full_description,
    region: f.region, state: f.state, craftType: f.craft_type, heroImage: f.hero_image, thumbnail: f.thumbnail,
    swatch: f.swatch, story: f.story, productCount: f.productCount, displayOrder: f.display_order
  };
}
function occasionShape(o) {
  return {
    id: o.id, name: o.name, slug: o.slug, description: o.description, image: o.image,
    featuredOnHome: !!o.featured_on_home, homeCardTitle: o.home_card_title, productCount: o.productCount, displayOrder: o.display_order
  };
}
// productCount is the number of tagged products a shopper can actually see (active, and not sale-badged - sale sarees are
// sale-page-only, same rule as GET /products), so the number on a collection card always matches what its page shows.
function collectionShape(c, productCount) {
  return {
    id: c.id, name: c.name, slug: c.slug, description: c.description, tagline: c.tagline,
    bannerImage: c.banner_image, thumbnail: c.thumbnail, displayOrder: c.display_order, startDate: c.start_date, endDate: c.end_date,
    productCount
  };
}
const visibleProducts = products => products.filter(p => p.status !== 'archived' && p.badge !== 'sale');

const fabrics = swr(async () => (await getFabrics()).map(fabricShape));
const occasions = swr(async () => (await getOccasions()).map(occasionShape));

// Collections with nothing a shopper can see yet are left out of the public list (and so the nav menu).
const collections = swr(async () => {
  const [list, products] = await Promise.all([getCollections(), getProducts()]);
  const visibleIds = new Set(visibleProducts(products).map(p => p.id));
  return list.map(c => collectionShape(c, c.productIds.filter(id => visibleIds.has(id)).length)).filter(c => c.productCount > 0);
});

// One collection and its sarees; null when the slug is unknown or inactive.
const collectionPage = swr(async slug => {
  const c = await getCollectionBySlug(slug);
  if (!c) return null;
  const tagged = new Set(c.productIds);
  const products = visibleProducts(await getProducts()).filter(p => tagged.has(p.id)).map(toListShape);
  return { collection: collectionShape(c, products.length), products };
}, { maxKeys: 100 });

// The three sarees in the homepage "Shop all sarees" band. Admin-picked when set; otherwise the popularity order the shop uses.
const shopAll = swr(async () => {
  const cfg = await getSetting('shop_all_showcase', {});
  const ids = (Array.isArray(cfg.productIds) ? cfg.productIds : []).slice(0, 3);
  let products = [];
  if (ids.length) {
    // A stored id that no longer resolves must never take the whole homepage band down.
    const rows = await Promise.all(ids.map(id => getProductByIdFast(id).catch(() => null)));
    products = rows.filter(r => r && r.status !== 'archived').map(toListShape);
  }
  if (!products.length) {
    products = (await getProducts()).filter(p => p.status !== 'archived').map(toListShape)
      .filter(p => p.badge !== 'sale')
      .sort((a, b) => ((b.badge === 'bestseller') - (a.badge === 'bestseller')) || ((b.rating * b.reviews) - (a.rating * a.reviews)))
      .slice(0, 3);
  }
  return products;
});

// What the shop's filter panel needs - the colours on sale, the weaves present and the price range - computed here instead of
// the page downloading the entire catalogue just to work them out. `slug` scopes it to a collection ('' = the whole shop).
const facets = swr(async slug => {
  let list;
  if (slug) { const page = await collectionPage(slug); if (!page) return null; list = page.products; }
  else list = visibleProducts(await getProducts());
  const colors = new Set(), fabricNames = new Set();
  let top = 0, bottom = Infinity;
  list.forEach(p => {
    const c = String(p.swatch || '').trim().toLowerCase(); if (c) colors.add(c);
    if (p.fabric) fabricNames.add(p.fabric);
    [p.price].concat((p.variants || []).map(v => v.price)).forEach(x => { if (x > top) top = x; if (x > 0 && x < bottom) bottom = x; });
  });
  return { colors: [...colors].sort(), fabrics: [...fabricNames], priceTop: top, priceBottom: isFinite(bottom) ? bottom : 0 };
}, { maxKeys: 100 });

const reels = swr(async () => (await getReelProducts()).filter(p => p.status !== 'archived').map(toListShape));

// shipperAddress is for the packing slip only (admin endpoint); it is not public storefront info.
async function publicStore() { const { shipperAddress, ...rest } = await getSetting('store_info', {}); return rest; }

// Everything the header and footer of EVERY page need, in one response instead of five requests.
const bootstrap = swr(async () => {
  const [coll, announcement, shipping, footer, store] = await Promise.all([
    collections(), getSetting('announcement_bar', DEFAULT_ANNOUNCEMENT), getSetting('shipping_settings', {}),
    getSetting('footer_config', DEFAULT_FOOTER), publicStore()
  ]);
  return { collections: coll, announcement, shipping, footer, store };
});

// Everything the home page needs, in one response instead of five requests.
const home = swr(async () => {
  const [hero, fab, weaveSection, shopAllProducts, reelProducts] = await Promise.all([
    getSetting('hero_banner', {}), fabrics(), getSetting('weave_section', DEFAULT_WEAVE_SECTION), shopAll(), reels()
  ]);
  return { hero, fabrics: fab, weaveSection, shopAll: shopAllProducts, reels: reelProducts };
});

module.exports = { facets, fabrics, occasions, collections, collectionPage, shopAll, reels, bootstrap, home, publicStore };
