const express = require('express');
const { supabase, must, getProducts } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function toApiShape(row) {
  return {
    id: row.id, name: row.name, fabric: row.fabric, occasion: row.occasion,
    price: row.price, mrp: row.mrp, rating: row.rating, reviews: row.reviews_count,
    badge: row.badge, swatch: row.swatch, desc: row.description, stock: row.stock
  };
}

// Joins in price_at_add so the wishlist page can show a real "price dropped"
// badge — price_at_add is set once, the moment an item is first wishlisted,
// and never silently updated afterward (that would erase the very thing
// being compared against).
async function shapedWishlist(userId) {
  const rows = must(await supabase.from('wishlist_items').select('*').eq('user_id', userId), 'shapedWishlist');
  const products = await getProducts();
  return rows
    .map(row => {
      const product = products.find(p => p.id === row.product_id);
      if (!product) return null;
      const shaped = toApiShape(product);
      const priceAtAdd = row.price_at_add != null ? row.price_at_add : shaped.price;
      return { ...shaped, priceAtAdd, priceDropped: priceAtAdd > shaped.price };
    })
    .filter(Boolean);
}

router.get('/', async (req, res) => {
  try {
    res.json({ products: await shapedWishlist(req.userId) });
  } catch (err) {
    console.error('GET /wishlist failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ message: 'productId is required.' });

    const product = (await getProducts()).find(p => p.id === Number(productId));
    must(await supabase.from('wishlist_items').upsert({
      user_id: req.userId, product_id: Number(productId),
      price_at_add: product ? product.price : null, last_known_stock: product ? product.stock : null
    }, { onConflict: 'user_id,product_id', ignoreDuplicates: true }), 'wishlist:add');

    res.status(201).json({ products: await shapedWishlist(req.userId) });
  } catch (err) {
    console.error('POST /wishlist failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

// Folds a guest's localStorage wishlist into the now-logged-in user's account.
router.post('/merge', async (req, res) => {
  try {
    const { productIds } = req.body;
    if (Array.isArray(productIds)) {
      const products = await getProducts();
      const rows = productIds.map(id => {
        const product = products.find(p => p.id === Number(id));
        return { user_id: req.userId, product_id: Number(id), price_at_add: product ? product.price : null, last_known_stock: product ? product.stock : null };
      });
      if (rows.length) must(await supabase.from('wishlist_items').upsert(rows, { onConflict: 'user_id,product_id', ignoreDuplicates: true }), 'wishlist:merge');
    }
    res.json({ products: await shapedWishlist(req.userId) });
  } catch (err) {
    console.error('POST /wishlist/merge failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.delete('/:productId', async (req, res) => {
  try {
    must(await supabase.from('wishlist_items').delete().eq('user_id', req.userId).eq('product_id', Number(req.params.productId)), 'wishlist:delete');
    res.json({ products: await shapedWishlist(req.userId) });
  } catch (err) {
    console.error('DELETE /wishlist/:productId failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
