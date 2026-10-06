// Instagram orders: reading the admin's sheet, checking every row, and finding (or quietly creating) the customer.
//
// Each valid row becomes one ordinary order (id INS0001, INS0002 ... made by the import_instagram_orders() database
// function), so tracking, Order Inquiry, packing slips, bulk status and shipping all work on it unchanged.
// Nothing here touches the product catalogue or stock: these sarees are not in it.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase, must } = require('./db');
const { readTable, INSTAGRAM_COLUMNS } = require('./spreadsheet');
const { normalizePhone } = require('../routes/auth');
const profit = require('./profit');

const MAX_ROWS = 500;
const MAX_PRICE = 10000000;
const PAYMENTS = ['UPI', 'COD', 'Bank Transfer', 'Card', 'Cash', 'Other'];
const PLACEHOLDER_DOMAIN = 'instagram.padmora.invalid';

// A customer who gave no e-mail still needs a row in users (every order belongs to one); it gets an address that can
// never receive mail, so nothing is ever sent to it and the admin never sees it.
const isPlaceholderEmail = e => typeof e === 'string' && e.toLowerCase().endsWith('@' + PLACEHOLDER_DOMAIN);
const publicEmail = e => (isPlaceholderEmail(e) ? '' : (e || ''));

const HEADER_ALIASES = {
  date: ['orderdate', 'date', 'dateoforder', 'orderedon', 'orderedat'],
  name: ['customername', 'name', 'customer', 'buyername', 'buyer'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobileno', 'contact', 'contactnumber', 'whatsapp', 'whatsappnumber', 'customerphone'],
  address: ['customeraddress', 'address', 'deliveryaddress', 'shippingaddress', 'fulladdress'],
  product: ['productname', 'product', 'item', 'itemname', 'sareename', 'saree'],
  code: ['productcode', 'code', 'sku', 'itemcode', 'sareecode', 'productsku'],
  payment: ['paymentmethod', 'payment', 'paymentmode', 'paidby', 'paymenttype'],
  price: ['price', 'amount', 'total', 'priceinr', 'pricerupees', 'orderamount', 'orderprice'],
  cost: ['buyingprice', 'costprice', 'cost', 'purchaseprice', 'buyprice', 'cp', 'buyingcost'],
  email: ['email', 'emailaddress', 'emailid', 'customeremail', 'mail'],
  city: ['city', 'town', 'customercity'],
  state: ['state', 'customerstate'],
  pincode: ['pincode', 'pin', 'zip', 'zipcode', 'postalcode', 'postcode']
};

const headerKey = h => String(h || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

function mapHeaders(cells) {
  const index = {};
  cells.forEach((cell, i) => {
    const k = headerKey(cell);
    if (!k) return;
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (index[key] === undefined && aliases.includes(k)) { index[key] = i; break; }
    }
  });
  return index;
}

const clean = v => String(v == null ? '' : v).replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function ymd(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null;
}

// Excel dates arrive as a day count (46300), typed dates as text. Day-first, like everywhere in India: 05/10/2026 is 5 October.
function parseDate(raw) {
  const t = clean(raw);
  if (!t) return null;
  let m;
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const serial = Math.floor(Number(t));
    if (serial < 20000 || serial > 80000) return null;
    return new Date(Math.round((serial - 25569) * 86400000));
  }
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t))) return ymd(+m[1], +m[2] - 1, +m[3]);
  if ((m = /^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2,4})/.exec(t))) return ymd(+m[3], +m[2] - 1, +m[1]);
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[-/.\s]+([A-Za-z]{3,9})[-/.,\s]+(\d{2,4})/.exec(t)) && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) {
    return ymd(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  }
  if ((m = /^([A-Za-z]{3,9})[-/.\s]+(\d{1,2})(?:st|nd|rd|th)?[,\s]+(\d{4})/.exec(t)) && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
    return ymd(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  }
  return null;
}

function parsePrice(raw) {
  let t = clean(raw).replace(/[₹,\s]/g, '').replace(/^(rs\.?|inr)/i, '').replace(/\/-$/, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Math.round(Number(t));
  return n >= 1 && n <= MAX_PRICE ? n : null;
}

const PAYMENT_ALIASES = {
  upi: 'UPI', gpay: 'UPI', googlepay: 'UPI', phonepe: 'UPI', paytm: 'UPI', bhim: 'UPI',
  cod: 'COD', cashondelivery: 'COD',
  banktransfer: 'Bank Transfer', bank: 'Bank Transfer', neft: 'Bank Transfer', imps: 'Bank Transfer', rtgs: 'Bank Transfer', accounttransfer: 'Bank Transfer', netbanking: 'Bank Transfer',
  card: 'Card', creditcard: 'Card', debitcard: 'Card',
  cash: 'Cash', other: 'Other'
};
function parsePayment(raw) { return PAYMENT_ALIASES[clean(raw).toLowerCase().replace(/[^a-z]/g, '')] || null; }

function pincodeFrom(address) {
  const all = address.match(/(?<!\d)[1-9]\d{5}(?!\d)/g);
  return all ? all[all.length - 1] : '';
}

// The same order must never be created twice if a file is uploaded again: a row's fingerprint is its customer phone,
// saree code, price, date and name. Two identical rows inside ONE file are kept (the second gets "#2").
function fingerprint(d) {
  const base = [d.phone, d.code.toLowerCase(), d.price, d.date, d.name.toLowerCase()].join('|');
  return crypto.createHash('sha1').update(base).digest('hex');
}

// rows: readTable() output. Returns { entries, error } - entries: [{ row, errors: [], data }] in file order.
function parseSheet(rows, { now = Date.now(), profitSettings = null } = {}) {
  if (!rows.length) return { error: 'The sheet is empty. Fill in the template and upload it again.' };
  const index = mapHeaders(rows[0].cells);
  const missing = INSTAGRAM_COLUMNS.filter(c => c.required && index[c.key] === undefined).map(c => c.header);
  if (missing.length) {
    return { error: `The first row must have these column headings: ${missing.join(', ')}. Download the template and keep its first row as it is.` };
  }
  const dataRows = rows.slice(1);
  if (!dataRows.length) return { error: 'There are no orders in this sheet yet - add one saree per row under the headings.' };
  if (dataRows.length > MAX_ROWS) return { error: `That sheet has ${dataRows.length} orders - please upload at most ${MAX_ROWS} at a time.` };

  const todayUtc = Math.floor(now / 86400000) * 86400000;
  const seen = new Map();
  const entries = dataRows.map(r => {
    const get = k => (index[k] === undefined ? '' : clean(r.cells[index[k]]));
    const errors = [];
    const d = {};

    const dt = parseDate(r.cells[index.date]);
    if (!get('date')) errors.push('Order Date is empty.');
    else if (!dt) errors.push(`Order Date "${get('date')}" is not a date - write it like 05/10/2026.`);
    else if (dt.getTime() > todayUtc + 86400000) errors.push('Order Date is in the future.');
    else if (dt.getTime() < Date.UTC(2020, 0, 1)) errors.push('Order Date looks too old - check the year.');
    else {
      d.date = dt.toISOString().slice(0, 10);
      // 12 noon in India (06:30 UTC), but never later than right now.
      d.placedAt = new Date(Math.min(dt.getTime() + 6.5 * 3600000, now)).toISOString();
    }

    d.name = get('name');
    if (!d.name) errors.push('Customer Name is empty.');
    else if (d.name.length > 100) errors.push('Customer Name is too long.');

    const phoneRaw = get('phone');
    if (!phoneRaw) errors.push('Phone is empty - the customer needs it to track the order.');
    else {
      // a number typed as 9.8765E9 or as a plain number is already digits; "+44 ..." keeps its country code
      const digits = /^\d+(\.\d+)?[eE]\+?\d+$/.test(phoneRaw) ? Number(phoneRaw).toFixed(0) : phoneRaw;
      const phone = normalizePhone(digits, '91');
      if (!phone) errors.push(`Phone "${phoneRaw}" is not a valid mobile number (Indian: 10 digits; other countries: start with +country code).`);
      else d.phone = phone;
    }

    d.address = get('address');
    if (!d.address) errors.push('Customer Address is empty.');
    else if (d.address.length > 400) errors.push('Customer Address is too long (400 characters at most).');

    d.product = get('product');
    if (!d.product) errors.push('Product Name is empty.');
    else if (d.product.length > 200) errors.push('Product Name is too long.');

    d.code = get('code');
    if (!d.code) errors.push('Product Code is empty.');
    else if (d.code.length > 60) errors.push('Product Code is too long.');

    const pay = parsePayment(r.cells[index.payment]);
    if (!get('payment')) errors.push('Payment Method is empty.');
    else if (!pay) errors.push(`Payment Method "${get('payment')}" is not one of: ${PAYMENTS.join(', ')}.`);
    else d.payment = pay;

    const price = parsePrice(r.cells[index.price]);
    if (!get('price')) errors.push('Price is empty.');
    else if (price === null) errors.push(`Price "${get('price')}" must be a whole number of rupees, like 4500.`);
    else d.price = price;

    // optional buying price -> the saree's Final CP (buying + shipping + GST from Settings) is saved on the order for the profit figures
    const buying = profit.parseBuyingPrice(index.cost === undefined ? '' : r.cells[index.cost]);
    if (buying.error) errors.push(`Buying Price "${get('cost')}" must be a number above 0, like 3000.`);
    else if (!buying.empty && profitSettings) { const pr = profit.computePricing(buying.cost, profitSettings); d.buyingPrice = buying.cost; d.unitCost = pr.finalCp; }

    const email = get('email').toLowerCase();
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 160)) errors.push(`Email "${get('email')}" is not a valid e-mail address.`);
    else d.email = email;
    if (d.email && isPlaceholderEmail(d.email)) errors.push('Email is not a real address.');

    d.city = get('city').slice(0, 80);
    d.state = get('state').slice(0, 80);
    const pin = get('pincode').replace(/\s/g, '');
    if (pin && !/^[A-Za-z0-9-]{3,10}$/.test(pin)) errors.push(`Pincode "${get('pincode')}" does not look right.`);
    d.pincode = pin || pincodeFrom(d.address || '');

    if (!errors.length) {
      const base = fingerprint(d);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      d.importKey = n === 1 ? base : base + '#' + n;
    }
    return { row: r.row, errors, data: errors.length ? null : d };
  });
  return { entries };
}

// Marks rows whose fingerprint is already on an Instagram order (an earlier upload of the same sheet).
async function findAlreadyImported(entries) {
  const keys = entries.filter(e => e.data).map(e => e.data.importKey);
  const found = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const rows = must(await supabase.from('orders').select('id, import_key').in('import_key', keys.slice(i, i + 100)), 'instagram:existingKeys');
    rows.forEach(r => found.set(r.import_key, r.id));
  }
  return found;
}

// The customer behind a row. An existing account with that e-mail (guest or registered) is reused, so the order shows in
// their account; otherwise a guest row is made - keyed by e-mail, or by phone when there is none, so one person's several
// Instagram orders share one customer.
async function findOrCreateCustomer({ name, email, phone }) {
  const key = email || `ig.${phone.replace(/\D/g, '')}@${PLACEHOLDER_DOMAIN}`;
  const existing = must(await supabase.from('users').select('id, name, email, phone, is_guest').ilike('email', key).maybeSingle(), 'instagram:customerLookup');
  if (existing) return existing;
  const id = 'u_guest_' + crypto.randomBytes(8).toString('hex');
  return must(await supabase.from('users').insert({
    id, name, email: key.toLowerCase(), password: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10), phone,
    created_at: new Date().toISOString(), is_guest: true
  }).select('id, name, email, phone, is_guest').single(), 'instagram:customerInsert');
}

module.exports = { parseSheet, findAlreadyImported, findOrCreateCustomer, readTable, isPlaceholderEmail, publicEmail, parseDate, parsePrice, parsePayment, PAYMENTS, MAX_ROWS };
