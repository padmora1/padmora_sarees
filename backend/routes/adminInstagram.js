// Admin -> Instagram Orders. Mounted by routes/admin.js at /api/admin/instagram-orders, so it is already behind the
// admin login and the Orders permission.
//
//   GET  /template.xlsx | /template.csv   the sheet to fill in
//   POST /preview                         reads the uploaded sheet, checks every row, changes nothing
//   POST /import                          reads the same sheet again (never trusts the browser's copy) and creates the orders
//   GET  /                                every Instagram order, newest first
//
// The orders themselves are ordinary orders (source = 'instagram'), so the main Orders list, status changes, bulk
// status upload, packing slips, tracking, Order Inquiry and cancellations all work on them without special cases.
const express = require('express');
const { supabase, must, fetchAllRows, fetchAllByIds } = require('../utils/db');
const { computeStatus } = require('../utils/orderStatus');
const { buildInstagramTemplateXlsx, buildInstagramTemplateCsv } = require('../utils/spreadsheet');
const { parseSheet, findAlreadyImported, findOrCreateCustomer, readTable, publicEmail, PAYMENTS } = require('../utils/instagramOrders');
const { sendOrderConfirmation, smsConfigured } = require('../utils/notify');
const { shapeOrder } = require('./orders');
const { getProfitSettings } = require('../utils/profit');

module.exports = function instagramRoutes({ asyncRoute, record }) {
  const router = express.Router();
  const rawSheet = express.raw({ type: () => true, limit: '3mb' });

  router.get('/template.xlsx', (req, res) => {
    res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.header('Content-Disposition', 'attachment; filename="padmora-instagram-orders-template.xlsx"');
    res.send(buildInstagramTemplateXlsx());
  });
  router.get('/template.csv', (req, res) => {
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename="padmora-instagram-orders-template.csv"');
    res.send(buildInstagramTemplateCsv());
  });

  // The number the next imported order will get, e.g. 7 -> INS0007 (shown in the preview).
  async function nextNumber() {
    const rows = await fetchAllRows(() => supabase.from('orders').select('id').like('id', 'INS%').order('id'), 'instagram:ids');
    return rows.reduce((max, r) => { const m = /^INS(\d{1,8})$/.exec(r.id); return m ? Math.max(max, Number(m[1])) : max; }, 0) + 1;
  }
  const idFor = n => 'INS' + String(n).padStart(4, '0');

  async function read(buf) {
    try { return { entries: null, ...parseSheet(readTable(buf, { maxRows: 600 }), { profitSettings: await getProfitSettings() }) }; }
    catch (err) { return { error: err.message }; }
  }

  router.post('/preview', rawSheet, asyncRoute(async (req, res) => {
    const parsed = await read(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const already = await findAlreadyImported(parsed.entries);
    const next = await nextNumber();
    let n = next;
    const rows = parsed.entries.map(e => {
      const d = e.data;
      const dup = d ? already.get(d.importKey) || null : null;
      const row = {
        row: e.row, errors: e.errors, alreadyImported: dup,
        summary: d ? { date: d.date, name: d.name, phone: d.phone, email: d.email, address: d.address, product: d.product, code: d.code, payment: d.payment, price: d.price, buyingPrice: d.buyingPrice || null, finalCp: d.unitCost || null } : null,
        willGetId: null
      };
      if (d && !dup) row.willGetId = idFor(n++);
      return row;
    });
    res.json({
      rows,
      counts: {
        total: rows.length,
        ready: rows.filter(r => r.willGetId).length,
        errors: rows.filter(r => r.errors.length).length,
        alreadyImported: rows.filter(r => r.alreadyImported).length
      },
      nextId: idFor(next)
    });
  }));

  router.post('/import', rawSheet, asyncRoute(async (req, res) => {
    const parsed = await read(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const bad = parsed.entries.filter(e => e.errors.length);
    if (bad.length) {
      return res.status(400).json({ message: `${bad.length} row${bad.length === 1 ? ' has' : 's have'} a problem (row ${bad.slice(0, 5).map(e => e.row).join(', ')}${bad.length > 5 ? '…' : ''}). Nothing was imported - fix the sheet and upload it again.` });
    }
    const already = await findAlreadyImported(parsed.entries);
    const fresh = parsed.entries.filter(e => !already.has(e.data.importKey));
    if (!fresh.length) return res.status(400).json({ message: 'Every order in this sheet was already imported earlier, so nothing was added.' });

    // one customer per e-mail (or phone, when there is no e-mail)
    const customers = new Map();
    const distinct = [...new Map(fresh.map(e => [e.data.email || e.data.phone, e.data])).entries()];
    for (let i = 0; i < distinct.length; i += 8) {   // a few at a time: a big sheet has many customers, and a remote database is slow one by one
      await Promise.all(distinct.slice(i, i + 8).map(async ([key, d]) => customers.set(key, await findOrCreateCustomer({ name: d.name, email: d.email, phone: d.phone }))));
    }
    const payload = [];
    for (let i = 0; i < fresh.length; i++) {
      const d = fresh[i].data;
      const key = d.email || d.phone;
      payload.push({
        idx: i, user_id: customers.get(key).id, name: d.name, phone: d.phone, address: d.address, city: d.city, state: d.state, pincode: d.pincode,
        payment: d.payment, price: d.price, placed_at: d.placedAt, product_name: d.product, product_code: d.code, import_key: d.importKey, unit_cost: d.unitCost == null ? null : d.unitCost
      });
    }

    const rpc = await supabase.rpc('import_instagram_orders', { p_rows: payload, p_imported_by: req.adminName || 'admin' });
    if (rpc.error) {
      if (rpc.error.code === '23505') return res.status(409).json({ message: 'These orders were just imported by someone else. Refresh this page and check the list below.' });
      throw new Error(rpc.error.message);
    }
    const created = rpc.data.map(r => {
      const d = fresh[r.idx].data;
      const customer = customers.get(d.email || d.phone);
      return { id: r.id, row: fresh[r.idx].row, name: d.name, phone: d.phone, email: d.email, product: d.product, code: d.code, price: d.price, payment: d.payment, userId: customer.id };
    });
    await record(req, 'imported instagram orders', 'order', 'instagram', null, { count: created.length, first: created[0].id, last: created[created.length - 1].id, skippedAlreadyImported: parsed.entries.length - fresh.length });

    // Order e-mail / text go out after the reply (a slow mail server must not hold up the upload). Only customers who
    // can actually receive one: an e-mail address was given, or text messages are set up.
    const notify = req.query.notify !== '0';
    let notified = 0;
    if (notify) {
      const targets = created.filter(c => c.email || smsConfigured());
      notified = targets.length;
      setImmediate(async () => {
        for (const c of targets) {
          try {
            const order = must(await supabase.from('orders').select('*').eq('id', c.id).single(), 'instagram:notifyOrder');
            sendOrderConfirmation(await shapeOrder(order), { id: c.userId, name: c.name, email: c.email || null });
          } catch (err) { console.error('Instagram order confirmation failed for', c.id, err.message); }
        }
      });
    }

    res.json({ created, skippedAlreadyImported: parsed.entries.length - fresh.length, notified });
  }));

  router.get('/', asyncRoute(async (req, res) => {
    const orders = await fetchAllRows(() => supabase.from('orders').select('*').eq('source', 'instagram').order('placed_at', { ascending: false }).order('id', { ascending: false }), 'instagram:list');
    const ids = orders.map(o => o.id);
    const items = ids.length ? await fetchAllByIds(ids, c => supabase.from('order_items').select('order_id, name, product_code, price, qty').in('order_id', c).order('id'), 'instagram:items') : [];
    const itemsByOrder = {};
    items.forEach(it => (itemsByOrder[it.order_id] || (itemsByOrder[it.order_id] = [])).push(it));
    const userIds = [...new Set(orders.map(o => o.user_id))];
    const users = userIds.length ? await fetchAllByIds(userIds, c => supabase.from('users').select('id, email').in('id', c).order('id'), 'instagram:users') : [];
    const emailByUser = Object.fromEntries(users.map(u => [u.id, publicEmail(u.email)]));

    const shaped = [];
    for (const o of orders) {
      const status = await computeStatus(o);
      const its = itemsByOrder[o.id] || [];
      shaped.push({
        id: o.id, placedAt: o.placed_at, importedAt: o.imported_at, importedBy: o.imported_by,
        customerName: o.address_name, phone: o.address_phone, email: emailByUser[o.user_id] || '',
        address: { line1: o.address_line1, city: o.address_city, state: o.address_state, pincode: o.address_pincode },
        items: its.map(i => ({ name: i.name, code: i.product_code, qty: i.qty, price: i.price })),
        payment: o.payment, total: o.total, status, manualStatus: o.manual_status, viewedAt: o.admin_viewed_at,
        cancelRequestStatus: o.cancel_request_status
      });
    }
    res.json({ orders: shaped, payments: PAYMENTS });
  }));

  return router;
};
