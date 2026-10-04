// ---------------------------------------------------------------------------------------------------------
// Safe HTML. Pages build a lot of HTML from data — and some of that data is typed by customers (names,
// addresses, reviews, messages) or by lower-privilege admins. Without this, a name like <img onerror=...> would
// RUN inside an admin's browser (where the admin login token is stored). This file is the first script on every
// page, so everything assigned through innerHTML / outerHTML / insertAdjacentHTML is cleaned first: scripts,
// frames, event-handler attributes and javascript:/data: links are removed. The only inline handlers kept are the
// exact product-card buttons this site ships (their arguments are ids and numbers we generate).
// escHTML() is the other half: use it for any text dropped into a template.
// ---------------------------------------------------------------------------------------------------------
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
      throw new Error(data.message || 'Something went wrong. Please try again.');
    }
    return data;
  } finally {
    _endLoading();
  }
}

function money(n) {
  return '₹' + Number(n).toLocaleString('en-IN');
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
function productPhotoUrl(p) {
  const vs = (p && p.variants) || [];
  const def = vs.find(v => v.isDefault) || vs[0];
  let url = def ? primaryPhotoOf(def.media) : '';
  for (let i = 0; !url && i < vs.length; i++) url = primaryPhotoOf(vs[i].media);
  return url;
}
function photoBg(url, swatchKey) {
  const u = String(url || '').replace(/'/g, '%27');
  return u ? `url('${u}') center/cover no-repeat, ${swatchBg(swatchKey)}` : swatchBg(swatchKey);
}
function productBg(p) { return photoBg(productPhotoUrl(p), p && p.swatch); }

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
  try { ({ products } = await apiFetch('/products')); } catch { /* offline-ish; show empty */ }

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

  // Mirrors backend/utils/pricing.js's computeOrderTotals() exactly — a guest
  // has no server-side cart for the backend to compute this for, but the
  // preview shown here must still match what /orders/guest actually charges,
  // or "Total Payable" at checkout would silently understate the real total.
  const taxableAmount = Math.max(0, subtotal - discount);
  let shippingFee = 0, taxAmount = 0, taxRate = 0, taxLabel = 'GST', taxInclusive = true;
  try {
    const [{ shipping }, { tax }] = await Promise.all([apiFetch('/settings/shipping'), apiFetch('/settings/tax')]);
    shippingFee = taxableAmount >= (shipping.freeShippingThreshold || 0) ? 0 : (shipping.fee || 0);
    taxRate = tax.enabled ? (tax.gstRate || 0) : 0;
    taxInclusive = tax.inclusive !== false; // defaults true when unset, same as the backend
    taxAmount = taxInclusive
      ? Math.round(taxableAmount * (taxRate / (100 + taxRate)) || 0)
      : Math.round(taxableAmount * (taxRate / 100));
    taxLabel = tax.label || 'GST';
  } catch { /* settings unreachable — fall back to no shipping/tax rather than blocking the cart */ }

  const total = taxInclusive ? (taxableAmount + shippingFee) : (taxableAmount + shippingFee + taxAmount);
  return { items: withDetails, subtotal, discount, shippingFee, taxAmount, taxRate, taxLabel, taxInclusive, total, coupon: appliedCode };
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
  try { ({ products } = await apiFetch('/products')); } catch { return null; }
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
  const { products } = await apiFetch('/products');
  return { products: products.filter(p => ids.includes(p.id)) };
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
async function returnCreate(payload) {
  return apiFetch('/returns', { method: 'POST', body: JSON.stringify(payload) });
}
// Multipart, not JSON — bypasses apiFetch's JSON.stringify/Content-Type
// handling since the browser needs to set its own multipart boundary.
async function returnUploadPhotos(files) {
  const form = new FormData();
  Array.from(files).forEach(f => form.append('photos', f));
  const token = getToken();
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  _startLoading();
  try {
    const res = await fetch(API_BASE + '/returns/photos', { method: 'POST', headers, body: form });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error(data.message || 'Photo upload failed. Please try again.');
    return data;
  } finally {
    _endLoading();
  }
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
