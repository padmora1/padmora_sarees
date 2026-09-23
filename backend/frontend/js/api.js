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

const SWATCHES = {
  maroon:['#7A1F2B','#C9A227'], emerald:['#0F5132','#C9A227'], ivory:['#EDE3D0','#B08968'],
  teal:['#1F4B4A','#8FBFB6'], blush:['#E7C6C0','#B75D5D'], sand:['#C9B183','#7A6A4E'],
  mustard:['#C98A1F','#5C1620'], powder:['#A9C8D6','#5C1620'], wine:['#4A1220','#C9A227'],
  indigo:['#2C3E63','#C9A227'], fuchsia:['#9C2B6B','#F4D35E'], peacock:['#0E5C5C','#C9A227']
};
function swatchBg(key) {
  const c = SWATCHES[key] || SWATCHES.maroon;
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
      } : product
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
  let shippingFee = 0, taxAmount = 0, taxRate = 0, taxLabel = 'GST';
  try {
    const [{ shipping }, { tax }] = await Promise.all([apiFetch('/settings/shipping'), apiFetch('/settings/tax')]);
    shippingFee = taxableAmount >= (shipping.freeShippingThreshold || 0) ? 0 : (shipping.fee || 0);
    taxRate = tax.enabled ? (tax.gstRate || 0) : 0;
    taxAmount = Math.round(taxableAmount * (taxRate / 100));
    taxLabel = tax.label || 'GST';
  } catch { /* settings unreachable — fall back to no shipping/tax rather than blocking the cart */ }

  const total = taxableAmount + shippingFee + taxAmount;
  return { items: withDetails, subtotal, discount, shippingFee, taxAmount, taxRate, taxLabel, total, coupon: appliedCode };
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
