// Public side of "Upcoming Sarees" — a teaser listing for sarees that
// haven't launched yet, no account required. Deliberately a separate table
// from prebook_requests (which is for an existing product's variant going
// out of stock): these entries have no real product/variant row to key off,
// and "going live" here is an admin action (Notify Now), not a stock signal.
const express = require('express');
const { supabase, must } = require('../utils/db');

const router = express.Router();

function shapeUpcoming(row) {
  return {
    id: row.id, name: row.name, fabric: row.fabric, imageUrl: row.image_url,
    description: row.description, expectedLabel: row.expected_label
  };
}

router.get('/', async (req, res) => {
  try {
    const rows = must(
      await supabase.from('upcoming_sarees').select('*').eq('active', true).order('sort_order').order('id'),
      'listUpcoming'
    );
    res.json({ upcomingSarees: rows.map(shapeUpcoming) });
  } catch (err) {
    console.error('GET /upcoming-sarees failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/:id/notify-me', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { email, name } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }
    const entry = must(await supabase.from('upcoming_sarees').select('id, active').eq('id', id).maybeSingle(), 'notifyMe:lookup');
    if (!entry || !entry.active) return res.status(404).json({ message: 'This saree is no longer listed.' });

    must(await supabase.from('upcoming_saree_notify_requests').upsert({
      upcoming_saree_id: id, email: String(email).toLowerCase().trim(), name: name || null, created_at: new Date().toISOString()
    }, { onConflict: 'upcoming_saree_id,email', ignoreDuplicates: true }), 'notifyMe:insert');

    res.status(201).json({ message: "You're on the list — we'll email you the moment it launches." });
  } catch (err) {
    console.error('POST /upcoming-sarees/:id/notify-me failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
