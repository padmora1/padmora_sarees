const express = require('express');
const { supabase, must, getProductById } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { computeStatus } = require('../utils/orderStatus');

// Mounted at /api/products/:productId/reviews with mergeParams so req.params.productId is available.
const router = express.Router({ mergeParams: true });

function shapeReview(r) {
  return {
    id: r.id, userName: r.user_name, rating: r.rating, title: r.title, body: r.body,
    verified: !!r.verified, featured: !!r.featured, createdAt: r.created_at,
    adminReply: r.admin_reply || null, repliedAt: r.replied_at || null
  };
}

async function publishedReviews(productId) {
  // Rejected reviews never show publicly; featured ones surface first.
  return must(
    await supabase.from('reviews').select('*').eq('product_id', productId).eq('status', 'published')
      .order('featured', { ascending: false }).order('created_at', { ascending: false }),
    'publishedReviews'
  );
}

router.get('/', async (req, res) => {
  try {
    const rows = await publishedReviews(Number(req.params.productId));
    res.json({ reviews: rows.map(shapeReview) });
  } catch (err) {
    console.error('GET /reviews failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const product = await getProductById(productId);
    if (!product) return res.status(404).json({ message: 'Saree not found.' });

    const rating = Number(req.body.rating);
    const { title, body } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Please choose a star rating from 1 to 5.' });
    }
    if (!body || !body.trim()) {
      return res.status(400).json({ message: 'Please write a short review.' });
    }

    const user = must(await supabase.from('users').select('*').eq('id', req.userId).maybeSingle(), 'postReview:user');

    // Reviews come only from customers whose own order containing this saree has been DELIVERED.
    // order_items has no direct user_id, so this goes through the customer's orders in two steps.
    const myOrders = must(await supabase.from('orders').select('*').eq('user_id', req.userId).is('cancelled_at', null), 'postReview:orders');
    let delivered = false;
    if (myOrders.length) {
      const matching = must(
        await supabase.from('order_items').select('order_id').eq('product_id', productId).in('order_id', myOrders.map(o => o.id)),
        'postReview:orderItems'
      );
      const orderIds = new Set(matching.map(m => m.order_id));
      for (const o of myOrders.filter(o => orderIds.has(o.id))) {
        if ((await computeStatus(o)) === 'Delivered') { delivered = true; break; }
      }
    }
    if (!delivered) {
      return res.status(403).json({ message: 'You can review a saree after your order with it has been delivered. Find it under Account → Order History.' });
    }
    // one review per customer per saree
    const already = must(await supabase.from('reviews').select('id').eq('user_id', req.userId).eq('product_id', productId).limit(1), 'postReview:existing');
    if (already.length) return res.status(409).json({ message: 'You have already reviewed this saree. Thank you!' });

    must(await supabase.from('reviews').insert({
      product_id: productId, user_id: req.userId, user_name: user.name, rating, title: (title || '').toString().trim().slice(0, 120),
      body: body.trim().slice(0, 2000), verified: true, created_at: new Date().toISOString()
    }), 'postReview:insert');

    const updatedProduct = await getProductById(productId);
    const rows = await publishedReviews(productId);
    res.status(201).json({
      reviews: rows.map(shapeReview),
      rating: updatedProduct.rating,
      reviewsCount: updatedProduct.reviews_count
    });
  } catch (err) {
    console.error('POST /reviews failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
