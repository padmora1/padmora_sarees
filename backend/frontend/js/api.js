// ---------------------------------------------------------------------------------------------------------
// Safe HTML. Pages build a lot of HTML from data — and some of that data is typed by customers (names,
// addresses, reviews, messages) or by lower-privilege admins. Without this, a name like <img onerror=...> would
// RUN inside an admin's browser (where the admin login token is stored). This file is the first script on every
// page, so everything assigned through innerHTML / outerHTML / insertAdjacentHTML is cleaned first: scripts,
// frames, event-handler attributes and javascript:/data: links are removed. The only inline handlers kept are the
// exact product-card buttons this site ships (their arguments are ids and numbers we generate).
// escHTML() is the other half: use it for any text dropped into a template.
// ---------------------------------------------------------------------------------------------------------
// How much stock to tell a shopper about. Nothing is shown while a saree is comfortably in stock; the note only
// appears when exactly 2 or 3 are left, and "out of stock" is always said. Returns { text, level } or null.
const STOCK_NOTE_FROM = 2, STOCK_NOTE_TO = 3;
function stockNote(stock, colorName) {
  const n = Number(stock);
  if (n <= 0) return { text: 'Out of stock in this colour.', level: 'low' };
  if (n >= STOCK_NOTE_FROM && n <= STOCK_NOTE_TO) return { text: 'Only ' + n + ' left' + (colorName ? ' in ' + colorName : '') + ' — this piece is not mass-produced.', level: 'low' };
  return null;
}
function escHTML(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
(function () {
  if (window.__safeHtmlInstalled || typeof Element === 'undefined') return;
  window.__safeHtmlInstalled = true;
  const DROP = new Set(['SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'META', 'BASE', 'STYLE', 'NOSCRIPT', 'FOREIGNOBJECT', 'PORTAL']);
  const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'xlink:href', 'data', 'poster', 'background', 'ping', 'cite', 'longdesc', 'manifest']);
  const ARG = "(?:[-\\w]+|this|'(?:[^'\"\\\\<>\\r\\n]|\\\\')*')";
  const OWN_HANDLER = new RegExp('^\\s*(?:event\\.preventDefault\\(\\);\\s*(?:quickWish|cardChangeQty|quickAddToCart|openQuickView|removeWish|moveToCart)\\(\\s*' + ARG + '(?:\\s*,\\s*' + ARG + ')*\\s*\\);?|window\\.print\\(\\);?)\\s*$');
  const BAD_URL = /^(?:javascript|vbscript|data):/i;
  const SAFE_IMG = /^data:image\/(?:png|jpe?g|gif|webp);/i;
  function clean(root) {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (DROP.has(el.localName.toUpperCase())) { el.remove(); continue; }
      if (el.localName === 'use') { const h = el.getAttribute('href') || el.getAttribute('xlink:href') || ''; if (h[0] !== '#') { el.remove(); continue; } }
      for (const a of Array.from(el.attributes)) {
        const n = a.name.toLowerCase(), v = a.value;
        if (n.startsWith('on')) { if (!(n === 'onclick' && OWN_HANDLER.test(v))) el.removeAttribute(a.name); }
        else if (n === 'srcdoc' || n === 'formaction') el.removeAttribute(a.name);
        else if (URL_ATTRS.has(n)) {
          const flat = v.replace(/[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g, '');
          if (BAD_URL.test(flat) && !(n === 'src' && el.localName === 'img' && SAFE_IMG.test(flat))) el.removeAttribute(a.name);
        } else if (n === 'style' && /expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(v)) el.removeAttribute(a.name);
      }
    }
  }
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  const outer = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
  function sanitize(html) {
    const s = String(html);
    if (s.indexOf('<') === -1) return s;
    const t = document.createElement('template');
    desc.set.call(t, s);
    clean(t.content);
    return desc.get.call(t);
  }
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: true, enumerable: desc.enumerable, get: desc.get,
    set(v) { const tag = this.localName; return desc.set.call(this, (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'title') ? v : sanitize(v)); }
  });
  if (outer) Object.defineProperty(Element.prototype, 'outerHTML', { configurable: true, enumerable: outer.enumerable, get: outer.get, set(v) { return outer.set.call(this, sanitize(v)); } });
  const adjacent = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (position, html) { return adjacent.call(this, position, sanitize(html)); };
  const fragment = Range.prototype.createContextualFragment;
  Range.prototype.createContextualFragment = function (html) { return fragment.call(this, sanitize(html)); };
})();

// Small fetch wrapper shared by every page. Talks to the Express API
// running on the same origin (see backend/server.js).
const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('zaree_token');
}
function setToken(token) {
  localStorage.setItem('zaree_token', token);
}
function clearToken() {
  localStorage.removeItem('zaree_token');
}
function getStoredUser() {
  try { return JSON.parse(localStorage.getItem('zaree_user')); } catch { return null; }
}
function setStoredUser(user) {
  localStorage.setItem('zaree_user', JSON.stringify(user));
}
function isLoggedIn() {
  return !!getToken();
}
async function logout() {
  const ok = await showConfirmDialog(
    'You\'ll need to log in again to view your bag, wishlist, and orders.',
    { title: 'Log out of Padmora?', confirmLabel: 'Log Out', danger: true }
  );
  if (!ok) return;
  clearToken();
  localStorage.removeItem('zaree_user');
  window.location.href = '/login';
}

// A thin gold "loom weave" bar that runs across the top of every page while
// any API request is in flight — one shared buffer animation, site-wide.
let _activeRequests = 0;
function _loaderBarEl() {
  let bar = document.getElementById('loaderBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'loaderBar';
    bar.className = 'loader-bar';
    bar.innerHTML = '<span></span>';
    document.body.appendChild(bar);
  }
  return bar;
}
function _startLoading() {
  _activeRequests++;
  if (document.body) _loaderBarEl().classList.add('active');
}
function _endLoading() {
  _activeRequests = Math.max(0, _activeRequests - 1);
  if (_activeRequests === 0 && document.body) _loaderBarEl().classList.remove('active');
}

async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  _startLoading();
  try {
    const res = await fetch(API_BASE + path, { ...options, headers });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }

    if (!res.ok) {
      if (res.status === 401) { clearToken(); }
      const err = new Error(data.message || 'Something went wrong. Please try again.');
      err.status = res.status; err.data = data;   // so a page can react to more than the message (e.g. "account already exists")
      throw err;
    }
    return data;
  } finally {
    _endLoading();
  }
}

// One shared formatter: building a new Intl formatter on every call (toLocaleString) is slow, and a listing formats a price per card.
let _inr = null;
function money(n) {
  try { if (!_inr) _inr = new Intl.NumberFormat('en-IN'); return '₹' + _inr.format(Number(n)); }
  catch (e) { return '₹' + Number(n).toLocaleString('en-IN'); }
}

// What a customer sees about the money for a CANCELLED order (empty for any other order): whether a refund is pending, has been
// processed (with the amount and date), or is not needed because nothing was charged (Cash on Delivery).
function refundBoxHTML(o) {
  if (!o || o.status !== 'Cancelled') return '';
  const day = d => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const amount = money(o.refundAmount != null ? o.refundAmount : o.total);
  let tone, pill, title, text;
  if (o.refundStatus === 'Not Applicable' || (o.payment === 'COD' && o.refundStatus !== 'Processed')) {
    tone = 'na'; pill = 'No refund needed'; title = 'No refund needed';
    text = 'You chose Cash on Delivery, so nothing was charged for this order.';
  } else if (o.refundStatus === 'Processed') {
    tone = 'done'; pill = 'Refund processed'; title = amount + ' refunded';
    text = 'Sent back to your original payment method' + (o.refundProcessedAt ? ' on ' + day(o.refundProcessedAt) : '') + '. It usually reaches your account within 5–7 working days.';
  } else {
    tone = 'wait'; pill = 'Refund pending'; title = amount + ' to be refunded';
    text = 'We will send this back to your original payment method. The status here changes to “Refund processed” once it has been sent.';
  }
  return `<div class="refund-box refund-${tone}" data-refund-status="${tone}">
    <div class="refund-box-head"><span class="refund-pill">${pill}</span>${o.cancelledAt ? `<span class="refund-when">Order cancelled ${day(o.cancelledAt)}</span>` : ''}</div>
    <strong>${title}</strong>
    <p>${text}</p>
  </div>`;
}

// What a customer sees about an order whose RETURN was refunded: that the order is returned & refunded, how much, when and how
// the money went back (empty for any other order). The order's status is final from then on.
function returnedBoxHTML(o) {
  const rr = o && o.returnRefund;
  if (!rr) return '';
  const day = d => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const on = rr.refundedAt ? ' on ' + day(rr.refundedAt) : '';
  const how = rr.method === 'store_credit'
    ? 'Issued as store credit' + on + (rr.couponCode ? ' — use code <strong>' + escHTML(rr.couponCode) + '</strong> at checkout.' : '.')
    : rr.method === 'bank_transfer'
      ? 'Transferred to the bank / UPI details you gave us' + on + '. It can take a few working days to show.'
      : 'Sent back to your original payment method' + on + '. It usually reaches your account within 5–7 working days.';
  return `<div class="refund-box refund-done" data-refund-status="returned">
    <div class="refund-box-head"><span class="refund-pill">${rr.full ? 'Returned &amp; refunded' : 'Part returned &amp; refunded'}</span></div>
    <strong>${money(rr.amount)} refunded</strong>
    <p>${how}</p>
  </div>`;
}

// Escapes text that came from another customer (a review, a name, anything
// user-submitted) before it's dropped into an HTML template string. Without
// this, a review body like "<img src=x onerror=...>" runs as real HTML for
// every visitor who views that page — this turns it back into inert text.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// Every state and union territory the store can ship to — the address forms used to
// hard-code five, which locked out most of India (Madhya Pradesh, Gujarat, Rajasthan...).
const INDIAN_STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand',
  'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
function fillStateSelects() {
  document.querySelectorAll('select[data-states]').forEach(sel => {
    if (sel.options.length) return; // already filled
    sel.innerHTML = INDIAN_STATES.map(s => `<option>${s}</option>`).join('');
    sel.value = 'Maharashtra';
  });
}
fillStateSelects();
document.addEventListener('DOMContentLoaded', fillStateSelects);

const SWATCHES = {
  maroon:['#7A1F2B','#C9A227'], emerald:['#0F5132','#C9A227'], ivory:['#EDE3D0','#B08968'],
  teal:['#1F4B4A','#8FBFB6'], blush:['#E7C6C0','#B75D5D'], sand:['#C9B183','#7A6A4E'],
  mustard:['#C98A1F','#5C1620'], powder:['#A9C8D6','#5C1620'], wine:['#4A1220','#C9A227'],
  indigo:['#2C3E63','#C9A227'], fuchsia:['#9C2B6B','#F4D35E'], peacock:['#0E5C5C','#C9A227'],
  // Plain colour words an admin is likely to type for a new colour variant —
  // without these they silently rendered as the maroon fallback.
  green:['#2E7D4F','#C9A227'], blue:['#2C5AA0','#C9A227'], yellow:['#E3B505','#7A4B00'], red:['#B3202A','#C9A227'],
  pink:['#E58BA6','#B03A5C'], orange:['#D9792B','#7A3A12'], purple:['#6B2D84','#C9A227'], black:['#1B1B1D','#6B5B2A'],
  white:['#F6F1E8','#CDBFA6'], gold:['#C9A227','#7A5C10'], cream:['#F2E6C8','#C9A227'], grey:['#8C8C90','#4A4A4D'], brown:['#6B4226','#C9A227']
};
// Real photos, with the colour swatch as the fallback — so a saree that has pictures shows them
// in every grid, bag and search result, and one that doesn't still shows its colour.
function primaryPhotoOf(media) {
  const imgs = (media || []).filter(m => m.type === 'image');
  const m = imgs.find(x => x.isPrimary) || imgs[0];
  return m ? m.url : '';
}
// A colour's media in the order customers see it: 1st the main photo, 2nd the product video (if there is one), then the
// other photos. Whatever order the admin uploaded them in, a video is never first and never lands among the photos.
function orderedMedia(media) {
  const list = media || [];
  const images = list.filter(m => m.type === 'image');
  const main = images.find(m => m.isPrimary) || images[0] || null;
  if (!main) return [];
  const video = list.find(m => m.type === 'video') || null;
  return [main, video, ...images.filter(m => m !== main)].filter(Boolean);
}
// The product video of the colour a card shows (its default colour), or ''. Only used when the colour also has a photo.
function productVideoUrl(p) {
  const vs = (p && p.variants) || [];
  const def = vs.find(v => v.isDefault) || vs[0];
  const m = def ? orderedMedia(def.media).find(x => x.type === 'video') : null;
  return m ? m.url : '';
}
function productPhotoUrl(p) {
  const vs = (p && p.variants) || [];
  const def = vs.find(v => v.isDefault) || vs[0];
  let url = def ? primaryPhotoOf(def.media) : '';
  for (let i = 0; !url && i < vs.length; i++) url = primaryPhotoOf(vs[i].media);
  return url;
}
// Smaller copy of a photo for cards, thumbnails and banners. The photos live in Supabase Storage, which can hand out a
// resized version of any of them (a phone does not need a 2000px picture for a 300px card). The wanted width is
// passed in; anything that is not one of our storage photos (or if resizing is ever switched off) is used as it is.
// A card whose small copy fails to load still shows its colour swatch behind it.
const IMG_RESIZE_OFF_KEY = 'padmora_img_resize_off';
let _lastResizedPhoto = '';
let _resizeOk = null;   // read from storage once per page, not once per photo
function imgResizeAllowed() {
  if (_resizeOk !== null) return _resizeOk;
  try { const t = Number(localStorage.getItem(IMG_RESIZE_OFF_KEY) || 0); _resizeOk = !(t && Date.now() - t < 24 * 3600 * 1000); } catch (e) { _resizeOk = true; }
  return _resizeOk;
}
function sizedPhoto(url, width, quality) {
  const u = String(url || '');
  if (!width || !imgResizeAllowed() || u.indexOf('/storage/v1/object/public/') === -1) return u;
  _lastResizedPhoto = u.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') + '?width=' + Math.round(width) + '&quality=' + (quality || 72) + '&resize=contain';
  return _lastResizedPhoto;
}
// Quietly checks, at most once a day, that a resized photo really loads; if it does not, every page goes back to the originals.
(function probeImageResize() {
  try {
    const last = Number(localStorage.getItem('padmora_img_resize_checked') || 0);
    if (last && Date.now() - last < 24 * 3600 * 1000) return;
    window.addEventListener('load', () => setTimeout(() => {
      if (!_lastResizedPhoto) return;
      try { localStorage.setItem('padmora_img_resize_checked', String(Date.now())); } catch (e) { return; }
      const t = new Image();
      t.onload = () => { try { localStorage.removeItem(IMG_RESIZE_OFF_KEY); } catch (e) {} };
      t.onerror = () => { try { localStorage.setItem(IMG_RESIZE_OFF_KEY, String(Date.now())); } catch (e) {} };
      t.src = _lastResizedPhoto;
    }, 2500));
  } catch (e) { /* ignore */ }
})();
// width = the widest this picture is shown (CSS pixels); the screen's pixel density is allowed for.
function photoBg(url, swatchKey, width) {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const u = sizedPhoto(url, (width || 360) * dpr).replace(/'/g, '%27');
  return u ? `url('${u}') center/cover no-repeat, ${swatchBg(swatchKey)}` : swatchBg(swatchKey);
}
function productBg(p, width) { return photoBg(productPhotoUrl(p), p && p.swatch, width); }

// The crossed-out original price and "% off" belong to Sale sarees only. Every other saree shows one
// price — what it actually sells for — so shoppers aren't nudged by a discount that isn't a real sale.
// `v` is the colour variant being shown (falls back to the product's own price fields).
function priceExtrasHTML(p, v) {
  const x = v || p;
  if (!p || p.badge !== 'sale' || !x || !(x.mrp > x.price)) return '';
  return `<span class="price-mrp">${money(x.mrp)}</span><span class="price-off">${Math.round((1 - x.price / x.mrp) * 100)}% off</span>`;
}

function swatchBg(key) {
  const c = SWATCHES[String(key || '').trim().toLowerCase()] || SWATCHES.maroon;
  return `linear-gradient(160deg, ${c[0]} 0%, ${c[1]} 100%)`;
}

// ---------------------------------------------------------------------
// Guest cart & wishlist — lets visitors add to bag / wishlist without an
// account. Stored in localStorage; folded into the server-side cart via
// mergeGuestDataIntoAccount() right after login/register.
// ---------------------------------------------------------------------
function getGuestCart() {
  try { return JSON.parse(localStorage.getItem('zaree_guest_cart')) || []; } catch { return []; }
}
function setGuestCart(items) {
  localStorage.setItem('zaree_guest_cart', JSON.stringify(items));
}
function getGuestWishlist() {
  try { return JSON.parse(localStorage.getItem('zaree_guest_wishlist')) || []; } catch { return []; }
}
function setGuestWishlist(ids) {
  localStorage.setItem('zaree_guest_wishlist', JSON.stringify(ids));
}
function getGuestCoupon() {
  return localStorage.getItem('zaree_guest_coupon') || null;
}
function setGuestCoupon(code) {
  if (code) localStorage.setItem('zaree_guest_coupon', code);
  else localStorage.removeItem('zaree_guest_coupon');
}

async function guestCartResponse() {
  const items = getGuestCart();
  let products = [];
  try { ({ products } = await lookupProducts(items.map(i => i.productId))); } catch { /* offline-ish; show empty */ }

  const withDetails = items.map(i => {
    const product = products.find(p => p.id === i.productId);
    if (!product) return { ...i, product: null };
    const variant = (product.variants || []).find(v => v.id === i.variantId)
      || (product.variants || []).find(v => v.isDefault)
      || (product.variants || [])[0];
    return {
      ...i,
      variantId: variant ? variant.id : i.variantId,
      color: variant ? variant.swatch : i.color,
      colorName: variant ? variant.colorName : i.color,
      product: variant ? {
        id: product.id, name: product.name, fabric: product.fabric, occasion: product.occasion,
        price: variant.price, mrp: variant.mrp, rating: product.rating, reviews: product.reviews,
        badge: product.badge, swatch: variant.swatch, desc: variant.desc || product.desc, stock: variant.stock
      } : product,
      imageUrl: variant ? primaryPhotoOf(variant.media) : ''
    };
  }).filter(i => i.product);

  const subtotal = withDetails.reduce((s, i) => s + i.product.price * i.qty, 0);
  const code = getGuestCoupon();
  let discount = 0, appliedCode = null;
  if (code) {
    try {
      const res = await apiFetch('/coupons/validate', { method: 'POST', body: JSON.stringify({ code, subtotal }) });
      discount = res.discount; appliedCode = res.code;
    } catch { setGuestCoupon(null); }
  }

  // Mirrors backend/utils/pricing.js's computeOrderTotals() exactly - a guest has no server-side cart for the
  // backend to compute this for, but the preview shown here must still match what /orders/guest actually charges.
  // Prices already include GST, so there is no tax line.
  const taxableAmount = Math.max(0, subtotal - discount);
  let shippingFee = 0;
  try {
    const { shipping } = await cachedGet('/settings/shipping', 60000);
    shippingFee = taxableAmount >= (shipping.freeShippingThreshold || 0) ? 0 : (shipping.fee || 0);
  } catch { /* settings unreachable - fall back to no shipping rather than blocking the cart */ }

  const total = taxableAmount + shippingFee;
  return { items: withDetails, subtotal, discount, shippingFee, taxAmount: 0, taxRate: 0, taxInclusive: true, total, coupon: appliedCode };
}

async function cartGet() {
  return isLoggedIn() ? apiFetch('/cart') : guestCartResponse();
}

// Guest cart lives entirely in localStorage, so there's no server to enforce
// "don't exceed stock" on it — it has to check itself. Fetches live product
// data (same /products call guestCartResponse already makes) and returns the
// matched variant's real current stock, or null if it can't be determined
// (offline-ish — in that case we don't block the add, just don't clamp).
async function guestResolveStock(productId, variantId, color) {
  let products = [];
  try { ({ products } = await lookupProducts([productId])); } catch { return null; }
  const product = products.find(p => p.id === Number(productId));
  if (!product) return null;
  const variants = product.variants || [];
  const variant = variants.find(v => v.id === Number(variantId))
    || variants.find(v => v.swatch === color || v.colorName === color)
    || variants.find(v => v.isDefault)
    || variants[0];
  return variant ? variant.stock : null;
}

async function cartAdd(productId, qty, color, variantId) {
  if (isLoggedIn()) {
    return apiFetch('/cart', { method: 'POST', body: JSON.stringify({ productId, qty, color, variantId }) });
  }
  const items = getGuestCart();
  const lineId = `${productId}:${variantId || color || 'default'}`;
  const existing = items.find(i => i.id === lineId);
  const requested = (existing ? existing.qty : 0) + (qty || 1);

  const stock = await guestResolveStock(productId, variantId, color);
  if (stock != null && stock <= 0) {
    throw new Error('This colour is out of stock.');
  }
  const finalQty = stock == null ? requested : Math.min(requested, stock);

  if (existing) existing.qty = finalQty;
  else items.push({ id: lineId, productId: Number(productId), variantId: variantId ? Number(variantId) : null, color: color || 'default', qty: finalQty });
  setGuestCart(items);
  const response = await guestCartResponse();
  if (stock != null && finalQty < requested) response.message = `Only ${stock} left in stock — added the most we have.`;
  return response;
}

async function cartUpdateQty(itemId, qty) {
  if (isLoggedIn()) return apiFetch('/cart/' + itemId, { method: 'PUT', body: JSON.stringify({ qty }) });
  const items = getGuestCart();
  const line = items.find(i => i.id === itemId);
  if (!line) return guestCartResponse();

  const requested = Math.max(1, qty);
  const stock = await guestResolveStock(line.productId, line.variantId, line.color);
  if (stock != null && stock <= 0) {
    throw new Error('This colour just sold out — remove it from your bag to check out.');
  }
  const finalQty = stock == null ? requested : Math.min(requested, stock);

  line.qty = finalQty;
  setGuestCart(items);
  const response = await guestCartResponse();
  if (stock != null && finalQty < requested) response.message = `Only ${stock} left in stock — set to the max available.`;
  return response;
}

async function cartRemoveItem(itemId) {
  if (isLoggedIn()) return apiFetch('/cart/' + itemId, { method: 'DELETE' });
  setGuestCart(getGuestCart().filter(i => i.id !== itemId));
  return guestCartResponse();
}

async function cartApplyCoupon(code) {
  if (isLoggedIn()) return apiFetch('/cart/coupon', { method: 'POST', body: JSON.stringify({ code }) });
  const { subtotal } = await guestCartResponse();
  const res = await apiFetch('/coupons/validate', { method: 'POST', body: JSON.stringify({ code, subtotal }) });
  setGuestCoupon(res.code);
  return guestCartResponse();
}

async function cartRemoveCoupon() {
  if (isLoggedIn()) return apiFetch('/cart/coupon', { method: 'DELETE' });
  setGuestCoupon(null);
  return guestCartResponse();
}

async function wishlistGet() {
  if (isLoggedIn()) return apiFetch('/wishlist');
  const ids = getGuestWishlist();
  if (!ids.length) return { products: [] };
  const { products } = await lookupProducts(ids);
  return { products: products.filter(p => ids.includes(p.id)) };
}

// Just the ids of the saved sarees (what a listing needs to light the hearts): a guest's are already on this device, so no
// request - and no download of the saved sarees' full details - is needed.
async function wishlistIdsGet() {
  if (isLoggedIn()) return ((await apiFetch('/wishlist')).products || []).map(p => p.id);
  return getGuestWishlist().map(Number);
}

async function wishlistAdd(productId) {
  if (isLoggedIn()) return apiFetch('/wishlist', { method: 'POST', body: JSON.stringify({ productId }) });
  const ids = getGuestWishlist();
  if (!ids.includes(Number(productId))) ids.push(Number(productId));
  setGuestWishlist(ids);
  return wishlistGet();
}

async function wishlistRemove(productId) {
  if (isLoggedIn()) return apiFetch('/wishlist/' + productId, { method: 'DELETE' });
  setGuestWishlist(getGuestWishlist().filter(id => id !== Number(productId)));
  return wishlistGet();
}

// ---------------------------------------------------------------------
// Speed helpers for the bag
// ---------------------------------------------------------------------
// A short-lived memory of GET answers that barely change (settings, product details for the bag), so
// the same page does not download them again for every tap on + / - / Add.
const _memo = new Map();
function cachedGet(path, ttlMs) {
  const hit = _memo.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = apiFetch(path).catch(e => { _memo.delete(path); throw e; });
  _memo.set(path, { at: Date.now(), promise });
  return promise;
}

// Just the sarees a guest's bag / wishlist mention (sale sarees included), not the whole catalogue.
function lookupProducts(ids) {
  const list = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  if (!list.length) return Promise.resolve({ products: [] });
  return cachedGet('/products/lookup?ids=' + list.join(','), 20000);
}

// ---------------------------------------------------------------------
// Buy Now: buy one saree directly, without touching the bag. The choice lives in this browser tab only
// (sessionStorage) until the order is paid for, so the bag keeps exactly what the shopper had put in it.
// ---------------------------------------------------------------------
const BUY_NOW_KEY = 'padmora_buy_now';
function setBuyNow(item) {
  try { sessionStorage.setItem(BUY_NOW_KEY, JSON.stringify({ productId: Number(item.productId), variantId: item.variantId ? Number(item.variantId) : null, qty: Math.max(1, Number(item.qty) || 1) })); } catch (e) { /* private mode */ }
}
function getBuyNow() {
  try { const v = JSON.parse(sessionStorage.getItem(BUY_NOW_KEY) || 'null'); return v && v.productId ? v : null; } catch (e) { return null; }
}
function clearBuyNow() {
  try { sessionStorage.removeItem(BUY_NOW_KEY); } catch (e) { /* ignore */ }
}
// Prices an arbitrary list of items (and an optional coupon) the same way checkout will charge them.
async function checkoutQuote(items, couponCode) {
  return apiFetch('/checkout/quote', { method: 'POST', body: JSON.stringify({ items, couponCode: couponCode || undefined }) });
}

// ---------------------------------------------------------------------
// cardCart - instant "Add" and "+ / -" on product cards and the product page.
// It keeps a local picture of the bag (variantId -> { itemId, qty }), changes it and the header badge the moment
// the shopper taps, and sends the real change to the server in the background, one at a time and in order. When
// everything has been confirmed it adopts the server's answer; if anything fails it says so and reloads the real bag.
// ---------------------------------------------------------------------
const cardCart = (() => {
  const lines = {};          // variantId -> { itemId (null until the server has confirmed), qty }   (what the screen shows)
  const serverQty = {};      // variantId -> quantity the server last confirmed
  const knownIds = {};       // variantId -> last server line id
  const meta = {};           // variantId -> { productId, color } (needed to add a line the server does not have yet)
  const listeners = [];
  let pending = 0;
  let queue = Promise.resolve();

  const emit = () => listeners.forEach(fn => { try { fn(); } catch (e) { /* a page's redraw must never break the bag */ } });
  const total = () => Object.values(lines).reduce((s, l) => s + l.qty, 0);
  const syncBadge = () => { if (typeof setCartBadge === 'function') setCartBadge(total()); };

  // Learn what the server has: quantities, line ids, and enough about each line to add it again later.
  function record(cart) {
    Object.keys(serverQty).forEach(k => delete serverQty[k]);
    (cart.items || []).forEach(i => {
      if (!i.variantId) return;
      serverQty[i.variantId] = i.qty;
      knownIds[i.variantId] = i.id;
      meta[i.variantId] = { productId: i.productId, color: i.color };
    });
  }
  function adopt(cart) {
    record(cart);
    Object.keys(lines).forEach(k => delete lines[k]);
    (cart.items || []).forEach(i => { if (i.variantId) lines[i.variantId] = { itemId: i.id, qty: i.qty }; });
    syncBadge();
    emit();
  }

  function enqueue(op) {
    pending++;
    queue = queue.then(op).then(cart => {
      pending--;
      if (cart) { record(cart); if (pending === 0) adopt(cart); }
    }).catch(async err => {
      pending--;
      if (typeof toast === 'function') toast(err && err.message ? err.message : 'Could not update your bag.', 'error');
      if (pending === 0) { try { adopt(await cartGet()); } catch (e) { emit(); } }
    });
    return queue;
  }

  // Makes the server's quantity for one colour equal what the screen shows. Taps made in quick succession all end
  // up as one request: by the time an earlier tap's turn comes the screen already shows the final number, so it
  // sends that, and the later taps find nothing left to do.
  function syncVariant(v) {
    return enqueue(async () => {
      const target = lines[v] ? lines[v].qty : 0;
      const have = serverQty[v] || 0;
      if (target === have) return null;
      let cart;
      if (target === 0) {
        if (!knownIds[v]) return cartGet();
        cart = await cartRemoveItem(knownIds[v]);
      } else if (have === 0) {
        if (!meta[v]) return cartGet();
        cart = await cartAdd(meta[v].productId, target, meta[v].color, v);
      } else {
        cart = await cartUpdateQty(knownIds[v], target);
      }
      if (cart.message && typeof toast === 'function') toast(cart.message);
      return cart;
    });
  }

  return {
    lines,
    onChange(fn) { listeners.push(fn); },
    qty(variantId) { return lines[variantId] ? lines[variantId].qty : 0; },
    async load() {
      const cart = await cartGet();
      if (pending === 0) adopt(cart); else record(cart);
      return cart;
    },
    // stock (optional) is the colour's current stock, used to stop at the maximum without a round trip
    add(productId, variantId, color, stock, by) {
      const v = Number(variantId);
      const n = Math.max(1, Number(by) || 1);
      const cur = lines[v] ? lines[v].qty : 0;
      let add = n;
      if (stock != null && cur + add > stock) add = stock - cur;
      if (add <= 0) { if (typeof toast === 'function') toast(`Only ${stock} left in stock.`); return Promise.resolve(); }
      if (!meta[v]) meta[v] = { productId: Number(productId), color };
      lines[v] = { itemId: lines[v] ? lines[v].itemId : (knownIds[v] || null), qty: cur + add };
      syncBadge(); emit();
      return syncVariant(v);
    },
    change(variantId, delta, stock) {
      const v = Number(variantId);
      const cur = lines[v] ? lines[v].qty : 0;
      const next = cur + delta;
      if (delta > 0 && stock != null && next > stock) { if (typeof toast === 'function') toast(`Only ${stock} left in stock.`); return Promise.resolve(); }
      if (next <= 0) delete lines[v]; else lines[v] = { itemId: lines[v] ? lines[v].itemId : (knownIds[v] || null), qty: next };
      syncBadge(); emit();
      return syncVariant(v);
    }
  };
})();

// Called right after a successful login/register — folds any guest cart/
// wishlist built up while signed out into the account that just signed in.
async function mergeGuestDataIntoAccount() {
  const items = getGuestCart();
  const wishIds = getGuestWishlist();
  try {
    if (items.length) { await apiFetch('/cart/merge', { method: 'POST', body: JSON.stringify({ items }) }); setGuestCart([]); }
    if (wishIds.length) { await apiFetch('/wishlist/merge', { method: 'POST', body: JSON.stringify({ productIds: wishIds }) }); setGuestWishlist([]); }
    const code = getGuestCoupon();
    if (code) { try { await apiFetch('/cart/coupon', { method: 'POST', body: JSON.stringify({ code }) }); } catch {} setGuestCoupon(null); }
  } catch { /* best-effort — user can re-add manually if this fails */ }
}

// ---------------------------------------------------------------------
// Post-delivery returns & refunds — logged-in only, same as order history
// (a guest tracks by order ID + email/phone instead; if a guest needs a
// return they reach us via Contact Us, same as any other guest exception).
// ---------------------------------------------------------------------
async function returnEligibility(orderId) {
  return apiFetch('/returns/eligibility/' + encodeURIComponent(orderId));
}
async function returnsGet() {
  return apiFetch('/returns');
}
async function returnCreate(payload, signal) {
  return apiFetch('/returns', { method: 'POST', body: JSON.stringify(payload), signal });
}
// Customer photos (return requests). Phone cameras produce 3-12 MB pictures; sending those over a mobile
// connection is slow, can hit the 8 MB limit, and used to leave the page waiting forever. So every photo is
// first shrunk on the phone (longest side 1600px, JPEG) to a few hundred KB, then uploaded one at a time with
// a progress callback and a hard timeout, so the customer always sees progress or a clear error.
function _withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

function _loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

// Returns a smaller JPEG File made from a camera picture (or canvas). Throws a customer-readable Error.
async function shrinkPhoto(file, maxSide, quality) {
  maxSide = maxSide || 1600; quality = quality || 0.82;
  const cantRead = 'We could not read that photo. Please try taking it again.';
  try {
    let source;
    try {
      source = await _withTimeout(createImageBitmap(file, { imageOrientation: 'from-image' }), 20000, cantRead);
    } catch (e) {
      source = await _withTimeout(_loadImageElement(file), 20000, cantRead);
    }
    const sw = source.width || source.naturalWidth, sh = source.height || source.naturalHeight;
    if (!sw || !sh) throw new Error(cantRead);
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    if (source.close) source.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error(cantRead);
    return new File([blob], 'photo-' + Date.now() + '.jpg', { type: 'image/jpeg' });
  } catch (e) {
    throw new Error(e && e.message && e.message !== 'decode' ? e.message : cantRead);
  }
}

// One photo -> the server, with upload progress (0-100) and a 60 second limit.
function _postReturnPhoto(file, onPercent, path) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE + (path || '/returns/photos'));
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.timeout = 60000;
    xhr.upload.onprogress = e => { if (e.lengthComputable && onPercent) onPercent(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* no body */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.urls && data.urls[0]) return resolve(data.urls[0]);
      if (xhr.status === 401) return reject(new Error('Your session has expired. Please log in again.'));
      reject(new Error(data.message || 'The photo could not be uploaded. Please try again.'));
    };
    xhr.onerror = () => reject(new Error('Network problem while uploading. Check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('The upload is taking too long. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('The upload was cancelled.'));
    const form = new FormData();
    form.append('photos', file, file.name || 'photo.jpg');
    xhr.send(form);
  });
}

// Uploads every photo that is not on the server yet and returns { urls } in order. A photo that already
// uploaded is remembered on the File (_url), so pressing Submit again after a failure only re-sends the rest.
// onProgress(doneCount, total, percentOfCurrent)
async function returnUploadPhotos(files, onProgress, path) {
  const list = Array.from(files);
  _startLoading();
  try {
    for (let i = 0; i < list.length; i++) {
      if (list[i]._url) continue;
      if (onProgress) onProgress(i, list.length, 0);
      list[i]._url = await _postReturnPhoto(list[i], pct => onProgress && onProgress(i, list.length, pct), path);
    }
    if (onProgress) onProgress(list.length, list.length, 100);
    return { urls: list.map(f => f._url) };
  } finally {
    _endLoading();
  }
}

// Review photos use the same uploader, pointed at the review endpoint of that saree.
function reviewUploadPhotos(productId, files, onProgress) {
  return returnUploadPhotos(files, onProgress, '/products/' + productId + '/reviews/photos');
}

const TOAST_ICONS = {
  success: '<path d="M5 13l4 4L19 7"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>'
};

// Animated top-of-screen toast — type is 'success' (default), 'error', or 'info'.
function toast(msg, type) {
  type = TOAST_ICONS[type] ? type : 'success';
  let wrap = document.getElementById('toastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toastWrap';
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <span class="toast-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2">${TOAST_ICONS[type]}</svg></span>
    <span class="toast-msg">${msg}</span>
    <span class="toast-progress"></span>`;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 350);
  }, 3200);
}
