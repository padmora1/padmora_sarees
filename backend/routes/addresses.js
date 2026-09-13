const express = require('express');
const { supabase, must } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function listAddresses(userId) {
  return must(
    await supabase.from('addresses').select('*').eq('user_id', userId).order('is_default', { ascending: false }).order('id', { ascending: true }),
    'listAddresses'
  );
}

router.get('/', async (req, res) => {
  try {
    res.json({ addresses: await listAddresses(req.userId) });
  } catch (err) {
    console.error('GET /addresses failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { label, name, line1, city, state, pincode, phone, isDefault } = req.body;
    if (!line1 || !city || !pincode) {
      return res.status(400).json({ message: 'Address line, city and pincode are required.' });
    }

    const count = (await supabase.from('addresses').select('*', { count: 'exact', head: true }).eq('user_id', req.userId)).count || 0;
    if (count >= 5) {
      return res.status(400).json({ message: 'You can save up to 5 addresses. Delete one to add another.' });
    }

    const makeDefault = isDefault || count === 0;
    if (makeDefault) must(await supabase.from('addresses').update({ is_default: false }).eq('user_id', req.userId), 'postAddress:clearDefault');

    const inserted = must(await supabase.from('addresses').insert({
      user_id: req.userId, label: label || 'Home', name: name || '', line1, city, state: state || '',
      pincode, phone: phone || '', is_default: makeDefault
    }).select().single(), 'postAddress:insert');

    const addresses = await listAddresses(req.userId);
    res.status(201).json({ addresses, id: inserted.id });
  } catch (err) {
    console.error('POST /addresses failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    must(await supabase.from('addresses').delete().eq('id', Number(req.params.id)).eq('user_id', req.userId), 'deleteAddress');
    res.json({ addresses: await listAddresses(req.userId) });
  } catch (err) {
    console.error('DELETE /addresses/:id failed:', err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  }
});

module.exports = router;
