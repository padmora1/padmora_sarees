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

// productCount is passed in explicitly rather than read off the row — a
// collection's product list is derived from its own weaves (every active
// product whose fabric matches one of them), not a stored id list, so each
// caller computes it against whatever product set it already has in hand.
function collectionShape(c, productCount) {
  return {
    id: c.id, name: c.name, slug: c.slug, description: c.description, tagline: c.tagline, weaves: c.weaves || [],
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

// Sale-badged sarees are sale-page-only (see GET /products in products.js) —
// excluded here too so a collection's tile/count always matches what a
// shopper actually sees after clicking through, rather than counting a
// saree that's really only reachable from /sale.
router.get('/collections', async (req, res) => {
  try {
    const [collections, products] = await Promise.all([getCollections(), getProducts()]);
    const visible = products.filter(p => p.status !== 'archived' && p.badge !== 'sale');
    res.json({
      collections: collections.map(c => {
        const weaves = c.weaves || [];
        return collectionShape(c, visible.filter(p => weaves.includes(p.fabric)).length);
      })
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
    const weaves = c.weaves || [];
    const products = (await getProducts()).filter(p => p.status !== 'archived' && p.badge !== 'sale' && weaves.includes(p.fabric)).map(toProductApiShape);
    res.json({ collection: collectionShape(c, products.length), products });
  } catch (err) {
    console.error('GET /collections/:slug failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
