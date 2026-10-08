const express = require('express');
const { supabase, must } = require('../utils/db');
const { normalizeOrderId } = require('../utils/spreadsheet');
const { isBlocked, recordFailure, clientIp } = require('../utils/attemptLimiter');

const router = express.Router();

// Same shape used for a guest's checkout email (routes/payments.js) — kept
// consistent everywhere an email is taken from a customer.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// These two subjects are always about one particular order, so the order ID is required (the admin Messages screen links to it).
const ORDER_SUBJECTS = ['Order Support', 'Returns & Exchange'];

router.post('/', async (req, res) => {
  try {
    const { name, email, subject, message, orderId } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ message: 'Name, email and a message are required.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Enter a valid email address so we can reply to you.' });
    }

    const needsOrder = ORDER_SUBJECTS.includes(subject);
    const typed = normalizeOrderId(orderId);
    let order_id = null;
    if (needsOrder && !typed) {
      return res.status(400).json({ message: 'Enter the order ID this message is about.', field: 'orderId' });
    }
    if (typed) {
      // an order ID that does not exist is refused (a typo is no use to the team); guesses are limited so this cannot be used to list orders
      const key = 'contact-order:' + clientIp(req);
      if (typed.length > 40 || isBlocked(key, 15)) return res.status(429).json({ message: 'Too many attempts. Please wait a few minutes and try again.', field: 'orderId' });
      const found = must(await supabase.from('orders').select('id').eq('id', typed).maybeSingle(), 'postContact:order');
      if (!found) {
        recordFailure(key);
        if (needsOrder) return res.status(400).json({ message: 'We could not find that order ID. Please check it and try again.', field: 'orderId' });
      } else order_id = found.id;
    }

    must(await supabase.from('contact_messages').insert({
      name, email, subject: subject || 'General enquiry', message, order_id, created_at: new Date().toISOString()
    }), 'postContact');

    res.status(201).json({ message: 'Thanks for reaching out — our team will get back to you within 24 hours.' });
  } catch (err) {
    console.error('POST /contact failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
