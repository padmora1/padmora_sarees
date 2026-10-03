const express = require('express');
const { getFabrics, getOccasions, getCollections, getCollectionBySlug, getProducts } = require('../utils/db');
const { toProductApiShape } = require('../utils/shape');

const router = express.Router();

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

// productCount is passed in rather than read off the row: it's the number of
// tagged products a shopper can actually see (active, and not sale-badged —
// sale sarees are sale-page-only, same rule as GET /products), so the number
// on a collection card always matches what its page shows.
function collectionShape(c, productCount) {
  return {
    id: c.id, name: c.name, slug: c.slug, description: c.description, tagline: c.tagline,
    bannerImage: c.banner_image, thumbnail: c.thumbnail, displayOrder: c.display_order, startDate: c.start_date, endDate: c.end_date,
    productCount
  };
}

router.get('/fabrics', async (req, res) => {
  try {
    res.json({ fabrics: (await getFabrics()).map(fabricShape) });
  } catch (err) {
    console.error('GET /fabrics failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/occasions', async (req, res) => {
  try {
    res.json({ occasions: (await getOccasions()).map(occasionShape) });
  } catch (err) {
    console.error('GET /occasions failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

function visibleProducts(products) {
  return products.filter(p => p.status !== 'archived' && p.badge !== 'sale');
}

// Collections with nothing a shopper can see yet are left out of the public
// list (and so the nav menu) rather than linking to an empty page.
router.get('/collections', async (req, res) => {
  try {
    const [collections, products] = await Promise.all([getCollections(), getProducts()]);
    const visibleIds = new Set(visibleProducts(products).map(p => p.id));
    res.json({
      collections: collections
        .map(c => collectionShape(c, c.productIds.filter(id => visibleIds.has(id)).length))
        .filter(c => c.productCount > 0)
    });
  } catch (err) {
    console.error('GET /collections failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/collections/:slug', async (req, res) => {
  try {
    const c = await getCollectionBySlug(req.params.slug);
    if (!c) return res.status(404).json({ message: 'Collection not found.' });
    const tagged = new Set(c.productIds);
    const products = visibleProducts(await getProducts()).filter(p => tagged.has(p.id)).map(toProductApiShape);
    res.json({ collection: collectionShape(c, products.length), products });
  } catch (err) {
    console.error('GET /collections/:slug failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
