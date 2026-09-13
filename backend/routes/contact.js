const express = require('express');
const { supabase, must } = require('../utils/db');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ message: 'Name, email and a message are required.' });
    }

    must(await supabase.from('contact_messages').insert({
      name, email, subject: subject || 'General enquiry', message, created_at: new Date().toISOString()
    }), 'postContact');

    res.status(201).json({ message: 'Thanks for reaching out — our team will get back to you within 24 hours.' });
  } catch (err) {
    console.error('POST /contact failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
