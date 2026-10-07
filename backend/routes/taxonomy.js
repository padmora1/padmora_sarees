const express = require('express');
const pub = require('../utils/publicData');

const router = express.Router();

router.get('/fabrics', async (req, res) => {
  try {
    res.json({ fabrics: await pub.fabrics() });
  } catch (err) {
    console.error('GET /fabrics failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/occasions', async (req, res) => {
  try {
    res.json({ occasions: await pub.occasions() });
  } catch (err) {
    console.error('GET /occasions failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// Collections with nothing a shopper can see yet are left out of the public
// list (and so the nav menu) rather than linking to an empty page.
router.get('/collections', async (req, res) => {
  try {
    res.json({ collections: await pub.collections() });
  } catch (err) {
    console.error('GET /collections failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/collections/:slug', async (req, res) => {
  try {
    const page = await pub.collectionPage(req.params.slug);
    if (!page) return res.status(404).json({ message: 'Collection not found.' });
    res.json(page);
  } catch (err) {
    console.error('GET /collections/:slug failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
