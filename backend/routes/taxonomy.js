const express = require('express');
const { getFabrics, getOccasions, getCollections, getCollectionBySlug, getProductById } = require('../utils/db');
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

function collectionShape(c) {
  return {
    id: c.id, name: c.name, slug: c.slug, description: c.description, bannerImage: c.banner_image,
    thumbnail: c.thumbnail, displayOrder: c.display_order, startDate: c.start_date, endDate: c.end_date,
    productCount: c.productIds.length
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

router.get('/collections', async (req, res) => {
  try {
    res.json({ collections: (await getCollections()).map(collectionShape) });
  } catch (err) {
    console.error('GET /collections failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/collections/:slug', async (req, res) => {
  try {
    const c = await getCollectionBySlug(req.params.slug);
    if (!c) return res.status(404).json({ message: 'Collection not found.' });
    const products = (await Promise.all(c.productIds.map(id => getProductById(id))))
      .filter(Boolean).filter(p => p.status !== 'archived').map(toProductApiShape);
    res.json({ collection: collectionShape(c), products });
  } catch (err) {
    console.error('GET /collections/:slug failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
