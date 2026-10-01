const express = require('express');
const { supabase, must, getProducts, getProductById, getVariantById, getReelProducts, logSearchQuery, getCollectionBySlug } = require('../utils/db');
const { toProductApiShape } = require('../utils/shape');
const { getUserIdIfPresent } = require('../middleware/auth');

const router = express.Router();

// Classic edit-distance — small strings only (search words, catalog words),
// so the O(len1*len2) cost here is trivial.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1]);
      prevDiag = temp;
    }
  }
  return dp[n];
}

// How many typos we'll forgive scales with word length — too short a word
// (≤3 chars) fuzzes into everything and stops meaning anything, so those stay
// exact-match-only.
function fuzzyThreshold(len) {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

// Exact substring match first (cheap, precise, unchanged behavior) — only
// falls back to edit-distance against individual catalog words when that
// finds nothing, so "maheshwari" still means exactly "maheshwari" and isn't
// quietly loosened; it's specifically "maheshwary"/"maheshwri" that this catches.
function wordMatches(searchWord, haystackText, haystackWords) {
  if (haystackText.includes(searchWord)) return true;
  const threshold = fuzzyThreshold(searchWord.length);
  if (!threshold) return false;
  return haystackWords.some(hw => Math.abs(hw.length - searchWord.length) <= threshold && levenshtein(searchWord, hw) <= threshold);
}

// Registered before '/:id' — otherwise Express would match "reels" as an :id.
router.get('/reels', async (req, res) => {
  try {
    const reels = await getReelProducts();
    res.json({ products: reels.filter(p => p.status !== 'archived').map(toProductApiShape) });
  } catch (err) {
    console.error('GET /products/reels failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/', async (req, res) => {
  try {
    let products = (await getProducts()).filter(p => p.status !== 'archived').map(toProductApiShape);
    const { fabric, occasion, color, maxPrice, search, sort, badge, collection } = req.query;

    // Sale-badged sarees live on their own page (see routes GET /?badge=sale
    // and frontend/sale.html) — excluded from every general listing (shop
    // grid, home bestsellers, instant search, the Saree Finder quiz) unless
    // explicitly asked for, since all four call this same endpoint.
    if (badge) {
      products = products.filter(p => p.badge === badge);
    } else {
      products = products.filter(p => p.badge !== 'sale');
    }

    // Collections page: a weave tile under a collection links here with
    // ?collection=<slug>&fabric=<name> — narrows to that collection's own
    // curated product list first. An unknown/inactive slug intersects to
    // nothing rather than erroring, same as any other filter that matches
    // zero products.
    if (collection) {
      const coll = await getCollectionBySlug(collection);
      const ids = new Set(coll ? coll.productIds : []);
      products = products.filter(p => ids.has(p.id));
    }

    if (fabric) {
      const fabrics = fabric.split(',');
      products = products.filter(p => fabrics.includes(p.fabric));
    }
    if (occasion) {
      const occasions = occasion.split(',');
      products = products.filter(p => occasions.includes(p.occasion));
    }
    if (color) {
      const colors = color.split(',');
      products = products.filter(p => colors.includes(p.swatch));
    }
    if (maxPrice) {
      products = products.filter(p => p.price <= Number(maxPrice));
    }
    if (search) {
      // Word-by-word OR match against name/fabric/occasion — forgiving on purpose
      // so instant-search-as-you-type doesn't dead-end on a partially typed query
      // (e.g. "red saree" still matches on "red" even though no product is named "saree").
      // Each word also gets a typo-tolerant fallback (edit-distance against the
      // catalog's own words) so "maheshwary" or "ajark" still finds real results
      // instead of a dead-end "no results" page.
      const words = search.toLowerCase().split(/\s+/).filter(Boolean);
      products = products.filter(p => {
        const haystack = `${p.name} ${p.fabric} ${p.occasion}`.toLowerCase();
        const haystackWords = haystack.split(/\s+/);
        return words.some(w => wordMatches(w, haystack, haystackWords));
      });
      await logSearchQuery(search, products.length);
    }

    if (sort === 'low') products = [...products].sort((a, b) => a.price - b.price);
    else if (sort === 'high') products = [...products].sort((a, b) => b.price - a.price);
    else if (sort === 'rating') products = [...products].sort((a, b) => b.rating - a.rating);
    else {
      // "Popularity" with no real sales data yet: the admin's own manual
      // bestseller tag is the primary, most intentional signal available —
      // kept first — with rating x review-count as a secondary tie-break so
      // the rest of the catalog still has a sensible order instead of
      // whatever the database happens to return.
      products = [...products].sort((a, b) => {
        const bestsellerDiff = (b.badge === 'bestseller') - (a.badge === 'bestseller');
        if (bestsellerDiff) return bestsellerDiff;
        return (b.rating * b.reviews) - (a.rating * a.reviews);
      });
    }

    res.json({ products });
  } catch (err) {
    console.error('GET /products failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    // A non-numeric id (a typo'd link, a stray query string, someone poking
    // at the URL) used to reach the database as NaN and blow up as a 500 —
    // it's just a "not found" like any other bad id.
    if (!Number.isInteger(id)) return res.status(404).json({ message: 'Saree not found.' });
    const row = await getProductById(id);
    if (!row) return res.status(404).json({ message: 'Saree not found.' });
    const shaped = toProductApiShape(row);

    // Logged-in customers who already pre-booked a sold-out colour should see
    // that reflected on the button itself, not just re-discover it by
    // re-opening the dialog. No account, no way to know without their email —
    // the frontend covers that case itself with a per-browser memory instead.
    const userId = await getUserIdIfPresent(req);
    if (userId && shaped.variants.length) {
      const user = must(await supabase.from('users').select('email').eq('id', userId).maybeSingle(), 'getProduct:user');
      if (user) {
        const variantIds = shaped.variants.map(v => v.id).filter(Boolean);
        const existing = variantIds.length
          ? must(await supabase.from('prebook_requests').select('variant_id').in('variant_id', variantIds).eq('email', user.email.toLowerCase()), 'getProduct:prebooks')
          : [];
        const bookedVariantIds = new Set(existing.map(r => r.variant_id));
        shaped.variants.forEach(v => { v.alreadyPreBooked = bookedVariantIds.has(v.id); });
      }
    }

    res.json({ product: shaped });
  } catch (err) {
    console.error('GET /products/:id failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// "Pre Book" a sold-out variant — no account required, just an email. Real
// demand data for admin (Inventory → Pre-Book Requests) and a real email the
// moment backend/utils/prebookAlerts.js sees that variant's stock go above 0.
router.post('/:id/prebook', async (req, res) => {
  try {
    const { variantId, email, name } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }
    const product = await getProductById(Number(req.params.id));
    if (!product) return res.status(404).json({ message: 'Saree not found.' });
    const variant = variantId ? await getVariantById(Number(variantId)) : null;
    if (!variant || variant.product_id !== product.id) {
      return res.status(400).json({ message: 'Choose a colour first.' });
    }
    if (variant.stock > 0) {
      return res.status(400).json({ message: 'This colour is already in stock — no need to pre-book.' });
    }

    must(await supabase.from('prebook_requests').upsert({
      product_id: product.id, variant_id: variant.id, email: email.toLowerCase().trim(), name: name || null,
      created_at: new Date().toISOString()
    }, { onConflict: 'variant_id,email', ignoreDuplicates: true }), 'prebook:insert');

    res.status(201).json({ message: "You're on the list — we'll email you the moment it's back." });
  } catch (err) {
    console.error('POST /products/:id/prebook failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
