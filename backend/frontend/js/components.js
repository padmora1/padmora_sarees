// Shared header + footer + global widgets (mini-cart, bottom nav, saree
// finder, back-to-top), injected into every page.

// `page` is the internal identifier matched against each page's own
// `data-page="…"` attribute (still real filenames — used for nav
// active-state, admin-context detection, etc., never shown to a visitor).
// `href` is the actual clean URL a click navigates to. The two only look
// alike; keep them separate so a page name is never mistaken for a route.
const NAV_LINKS = [
  { href: '/', page: 'index.html', label: 'Home' },
  { href: '/collections', page: 'collections.html', label: 'Collections', dropdown: true },
  { href: '/shop', page: 'shop.html', label: 'All Sarees' },
  { href: '/sale', page: 'sale.html', label: 'Sale' },
  { href: '/upcoming-sarees', page: 'upcoming-sarees.html', label: 'Upcoming' }
];

// General rule: a link is active when its page matches AND, among links that
// share a page (e.g. two different links to shop.html distinguished only by
// query string), its own query string is the one that actually matches the
// current URL — a plain link with no query wins whenever no more specific
// sibling does. collection.html shares its data-page with collections.html
// on purpose so viewing a single collection still highlights "Collections".
function isNavLinkActive(link, activeHref) {
  if (link.page !== activeHref) return false;
  const query = link.href.includes('?') ? link.href.slice(link.href.indexOf('?')) : '';
  if (query) return query === location.search;
  const moreSpecificSiblingMatches = NAV_LINKS.some(other =>
    other !== link && other.page === link.page && other.href.includes('?') &&
    other.href.slice(other.href.indexOf('?')) === location.search
  );
  return !moreSpecificSiblingMatches;
}

// Small five-petal lotus glyph, used as a legible inline mark (footer divider).
const LOTUS_GLYPH_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20 C10 15 9.3 10 12 5 C14.7 10 14 15 12 20 Z"/><path d="M12 19 C8 16.5 6 13 6.6 9 C10 11 11.6 15 12 19 Z"/><path d="M12 19 C16 16.5 18 13 17.4 9 C14 11 12.4 15 12 19 Z"/><path d="M11.5 18 C7.8 16 5.3 13.3 5.7 10.3 C8.7 11.8 10.7 14.6 11.5 18 Z"/><path d="M12.5 18 C16.2 16 18.7 13.3 18.3 10.3 C15.3 11.8 13.3 14.6 12.5 18 Z"/></svg>`;

// Looser, outline-only lotus used for the ambient footer watermarks.
const LOTUS_ABSTRACT_SVG = `<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="0.8" aria-hidden="true"><path d="M20 34 C16 26 15 17 20 6 C25 17 24 26 20 34 Z"/><path d="M20 32 C12 27 8 20 10 12 C17 15 20 22 20 32 Z"/><path d="M20 32 C28 27 32 20 30 12 C23 15 20 22 20 32 Z"/><path d="M20 30 C8 27 3 19 6 10 C14 14 19 21 20 30 Z" opacity="0.6"/><path d="M20 30 C32 27 37 19 34 10 C26 14 21 21 20 30 Z" opacity="0.6"/></svg>`;

function headerIconsHTML() {
  const user = getStoredUser();
  const accountHref = isLoggedIn() ? '/account' : '/login';
  const accountInner = isLoggedIn()
    ? `<span class="account-chip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>${(user && user.name) ? user.name.split(' ')[0] : 'Account'}</span>`
    : `<button class="icon-btn" aria-label="Account"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg></button>`;

  return `
    <button class="icon-btn" id="searchTrigger" aria-label="Search">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    </button>
    <a href="${accountHref}" style="display:flex;">${accountInner}</a>
    <a href="/wishlist" class="icon-btn" aria-label="Wishlist">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M12 21s-7.5-4.7-10-9.3C.3 8 2 4.5 5.6 4.1c2-.2 3.8.8 4.4 2.5.6-1.7 2.4-2.7 4.4-2.5C18 4.5 19.7 8 22 11.7 19.5 16.3 12 21 12 21z"/></svg>
      <span class="badge-count" id="wishlistCount">0</span>
    </a>
    <a href="/cart" class="icon-btn" id="cartTrigger" aria-label="Cart">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6L4.5 3H2"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg>
      <span class="badge-count" id="cartCount">0</span>
    </a>`;
}

// admin.html reuses this same shared header (so its layout/behavior never
// drifts from the rest of the site) — but it's the one page where the
// customer-facing chrome (Home/Menu/Sale nav, search, wishlist, cart, and
// the logo linking out to index.html with no way back) is actively wrong:
// an admin doing dashboard work has no use for a shopping cart icon, and
// clicking the brand logo used to strand them on the public homepage with
// no link back to the dashboard. In admin context the header collapses to
// just the logo (linking back to admin.html) and an explicit, deliberate
// link out to the storefront.
function isAdminRealm() {
  return document.body.getAttribute('data-page') === 'admin.html';
}

// Populates the "Collections" nav item's hover panel (desktop) and
// accordion sublist (mobile) from the same fetch — admin-managed, so a new
// collection shows up here with no frontend changes. If this fails or comes
// back empty, both dropdown/caret just stay unpopulated and the "Collections"
// link itself still works as a plain link to /collections either way.
// The menu, announcement bar, shipping threshold and footer used to be five separate requests on every page; one
// /api/bootstrap response carries them all. If it ever fails (an older server), each piece falls back to its own request.
let bootstrapRequest = null;
function siteData(key, legacyPath, pick) {
  if (!bootstrapRequest) bootstrapRequest = window.__BOOT__ ? Promise.resolve(window.__BOOT__) : apiFetch('/bootstrap').catch(() => null);
  return bootstrapRequest.then(b => (b && b[key] !== undefined) ? b[key] : apiFetch(legacyPath).then(pick));
}

async function loadNavCollectionsDropdown() {
  const desktopPanel = document.getElementById('navDropdown-collections.html');
  const mobilePanel = document.getElementById('mobileNavDropdown-collections.html');
  if (!desktopPanel && !mobilePanel) return;
  try {
    const collections = await siteData('collections', '/collections', r => r.collections);
    if (!collections.length) return;
    const rows = collections.map(c => `
      <a href="/collection?slug=${encodeURIComponent(c.slug)}">
        <strong>${c.name}</strong>${c.tagline ? `<span>${c.tagline}</span>` : ''}
      </a>`).join('');
    if (desktopPanel) desktopPanel.innerHTML = rows;
    if (mobilePanel) mobilePanel.innerHTML = rows;
  } catch (e) { /* nav still works as a plain link */ }
}

function initHeader(activeHref) {
  const mount = document.getElementById('site-header');
  if (!mount) return;

  if (isAdminRealm()) {
    mount.innerHTML = `
      <header class="site-header">
        <div class="header-inner">
          <a href="/admin" class="logo"><img src="images/padmora-lotus-sm.webp" alt="" class="logo-mark" width="40" height="28">Padmora</a>
          <a href="/" class="admin-view-store" target="_blank" rel="noopener noreferrer">View Store ↗</a>
        </div>
      </header>`;
    return;
  }

  mount.innerHTML = `
    <div class="topbar" id="siteTopbar"></div>
    <header class="site-header">
      <div class="header-inner">
        <button class="hamburger" id="hamburgerBtn" aria-label="Open menu">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        </button>
        <a href="/" class="logo" aria-label="Padmora — home"><img src="images/padmora-lotus-sm.webp" alt="" class="logo-mark" width="40" height="28"><span class="logo-text-stage" aria-hidden="true"><span class="logo-text-el active" id="logoTextEn">Padmora</span><span class="logo-text-el lang-mr" id="logoTextMr">पद्मोरा</span></span></a>
        <nav class="main-nav">
          ${NAV_LINKS.map(l => l.dropdown ? `
            <div class="nav-item">
              <a href="${l.href}" class="${isNavLinkActive(l, activeHref) ? 'active' : ''}">${l.label}</a>
              <div class="nav-dropdown" id="navDropdown-${l.page}"></div>
            </div>` : `<a href="${l.href}" class="${isNavLinkActive(l, activeHref) ? 'active' : ''}">${l.label}</a>`).join('')}
        </nav>
        <div class="header-actions">${headerIconsHTML()}</div>
      </div>
      <nav class="mobile-nav" id="mobileNav">
        ${NAV_LINKS.map(l => l.dropdown ? `
          <div class="mobile-nav-item">
            <a href="${l.href}">${l.label}</a>
            <button type="button" class="mobile-nav-caret" id="mobileNavCaret-${l.page}" aria-label="Show ${l.label}" aria-expanded="false">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="mobile-nav-dropdown-panel" id="mobileNavDropdown-${l.page}"></div>
          </div>` : `<a href="${l.href}">${l.label}</a>`).join('')}
        <a href="${isLoggedIn() ? '/account' : '/login'}">${isLoggedIn() ? 'My Account' : 'Log In'}</a>
      </nav>
    </header>`;

  document.getElementById('hamburgerBtn').addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the same click immediately re-close it via the outside-tap handler below
    const nav = document.getElementById('mobileNav');
    nav.style.display = (nav.style.display === 'flex') ? 'none' : 'flex';
  });

  // Tapping anywhere outside the open mobile menu closes it — previously only
  // the ☰ button itself could, so the menu stayed open until deliberately
  // toggled shut, even after tapping elsewhere on the page.
  document.addEventListener('click', (e) => {
    const nav = document.getElementById('mobileNav');
    if (nav && nav.style.display === 'flex' && !nav.contains(e.target)) {
      nav.style.display = 'none';
    }
  });

  // Mobile caret(s) next to a dropdown nav item expand/collapse an inline
  // sublist without navigating — the link text beside it still navigates
  // normally to that section's own listing page.
  NAV_LINKS.filter(l => l.dropdown).forEach(l => {
    const caret = document.getElementById(`mobileNavCaret-${l.page}`);
    if (!caret) return;
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = document.getElementById(`mobileNavDropdown-${l.page}`);
      const open = panel.classList.toggle('open');
      caret.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  loadNavCollectionsDropdown();

  const cartTrigger = document.getElementById('cartTrigger');
  if (cartTrigger) {
    cartTrigger.addEventListener('click', (e) => {
      if (document.body.getAttribute('data-page') === 'cart.html') return; // already on the bag page
      e.preventDefault();
      openMiniCart();
    });
  }

  const searchTrigger = document.getElementById('searchTrigger');
  if (searchTrigger) searchTrigger.addEventListener('click', openSearchOverlay);

  refreshBadgeCounts();
  startLogoLanguageCycle();

  // The announcement bar at the very top is edited in Admin → Storefront → Top Banner. The last known version is
  // remembered on this device so the bar is drawn correctly straight away (no flash of old text); the live
  // version then replaces it. {freeShipping} in the text is filled with the real free-shipping amount.
  let cachedBar = null;
  try { cachedBar = JSON.parse(localStorage.getItem(ANNOUNCEMENT_CACHE_KEY) || 'null'); } catch (e) { /* private mode */ }
  renderAnnouncementBar(cachedBar || { cfg: ANNOUNCEMENT_DEFAULT, threshold: 1999 });
  Promise.all([
    siteData('announcement', '/content/announcement', r => r.announcement).catch(() => null),
    siteData('shipping', '/settings/shipping', r => r.shipping).catch(() => null)
  ]).then(([ann, ship]) => {
    const cfg = ann ? ann : (cachedBar ? cachedBar.cfg : ANNOUNCEMENT_DEFAULT);
    const threshold = ship && ship.freeShippingThreshold ? ship.freeShippingThreshold : (cachedBar ? cachedBar.threshold : 1999);
    const state = { cfg, threshold };
    renderAnnouncementBar(state);
    try { localStorage.setItem(ANNOUNCEMENT_CACHE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  });
}

const ANNOUNCEMENT_CACHE_KEY = 'padmora_announcement';
const ANNOUNCEMENT_DEFAULT = { enabled: true, text: 'Free shipping above {freeShipping} · Easy 7-day returns · Secure payments via Razorpay', link: '' };
function renderAnnouncementBar({ cfg, threshold }) {
  const bar = document.getElementById('siteTopbar');
  if (!bar) return;
  if (!cfg || cfg.enabled === false) { bar.style.display = 'none'; bar.textContent = ''; return; }
  bar.style.display = '';
  const text = String(cfg.text || ANNOUNCEMENT_DEFAULT.text).replace(/\{freeShipping\}/g, threshold ? money(threshold) : 'the minimum order value');
  const link = /^(\/(?!\/)|https?:\/\/)/i.test(cfg.link || '') ? cfg.link : '';
  if (link) {
    bar.innerHTML = `<a href="${escHTML(link)}"${/^https?:/i.test(link) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escHTML(text)}</a>`;
  } else {
    bar.textContent = text;
  }
}

// The header wordmark cycles English -> Marathi -> English every 8s, on every
// customer page. Both words are always in the DOM (see the header markup
// above) and simply crossfade via a shared "active" class — nothing is
// measured or resized here, which is what keeps Home/Menu/Sale
// from shifting: the logo's own box never changes size, only which of the
// two stacked words is visible does. Re-running initHeader (shouldn't
// normally happen, but is cheap to guard) would otherwise stack a second
// interval on top of the first, so this always clears any interval it
// previously started.
let logoLanguageTimer = null;
function startLogoLanguageCycle() {
  const en = document.getElementById('logoTextEn');
  const mr = document.getElementById('logoTextMr');
  if (!en || !mr) return;
  if (logoLanguageTimer) clearInterval(logoLanguageTimer);
  let showingMarathi = false;
  logoLanguageTimer = setInterval(() => {
    showingMarathi = !showingMarathi;
    en.classList.toggle('active', !showingMarathi);
    mr.classList.toggle('active', showingMarathi);
  }, 8000);
}

function setCartBadge(n) {
  const el = document.getElementById('cartCount');
  if (el) el.textContent = n;
  const bn = document.querySelector('[data-bn-badge="Bag"]');
  if (bn) { bn.textContent = n; bn.style.display = n ? 'flex' : 'none'; }
}
function setWishBadge(n) {
  const el = document.getElementById('wishlistCount');
  if (el) el.textContent = n;
  const bn = document.querySelector('[data-bn-badge="Wishlist"]');
  if (bn) { bn.textContent = n; bn.style.display = n ? 'flex' : 'none'; }
}

// Guests: the numbers are already in this browser, so no request at all. Logged-in customers: two tiny count
// requests (not the whole bag and wishlist).
async function refreshBadgeCounts() {
  try {
    if (!isLoggedIn()) {
      setCartBadge(getGuestCart().reduce((sum, i) => sum + (i.qty || 0), 0));
      setWishBadge(getGuestWishlist().length);
      return;
    }
    const [c, w] = await Promise.all([apiFetch('/cart/count'), apiFetch('/wishlist/count')]);
    setCartBadge(c.count);
    setWishBadge(w.count);
  } catch (e) {
    // Fail silently on the badge counts — not worth interrupting the page.
  }
}

function initFooter() {
  const mount = document.getElementById('site-footer');
  if (!mount) return;
  // The marketing footer (tagline, link columns, social icons)
  // has no place under a dashboard — leave the mount point empty there.
  if (isAdminRealm()) { mount.innerHTML = ''; return; }
  mount.innerHTML = `
    <footer>
      <div class="footer-lotus-bg" aria-hidden="true">
        <span class="fl-a">${LOTUS_GLYPH_SVG}</span>
        <span class="fl-b">${LOTUS_GLYPH_SVG}</span>
        <span class="fl-c">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-d">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-e">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-f">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-g">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-h">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-i">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-j">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-k">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-l">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-m">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-n">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-o">${LOTUS_ABSTRACT_SVG}</span>
        <span class="fl-p">${LOTUS_ABSTRACT_SVG}</span>
      </div>
      <div class="container">
        <div class="footer-grid">
          <div>
            <div class="footer-logo">Padmora</div>
            <p id="footerTagline"></p>
            <a class="footer-mail" id="footerMailLink" href="mailto:hello@padmorasarees.com">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>
              <span id="footerMailText">hello@padmorasarees.com</span>
            </a>
            <div class="footer-social">
              <a href="https://instagram.com/padmorabyyashi" id="footerInstagramLink" target="_blank" rel="noopener noreferrer" class="social-btn" aria-label="Padmora on Instagram">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>
              </a>
              <a href="https://youtube.com/@padmorabyyashi" id="footerYoutubeLink" target="_blank" rel="noopener noreferrer" class="social-btn" aria-label="Padmora on YouTube">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><rect x="2.3" y="5.5" width="19.4" height="13" rx="4"/><path d="M10.3 9v6l5.4-3-5.4-3z" fill="currentColor" stroke="none"/></svg>
              </a>
            </div>
          </div>
          <div class="footer-cols" id="footerCols" style="display:contents;"></div>
        </div>
      </div>
      <div class="footer-bottom">
        <span id="footerBottomLeft"></span>
        <span class="footer-lotus-mark">${LOTUS_GLYPH_SVG}</span>
        <span id="footerBottomRight"></span>
      </div>
    </footer>`;

  // Footer text and link columns are edited in Admin → Settings → Footer. These
  // defaults match what the admin starts with, so the footer is complete even
  // before the settings arrive (or if they can't be fetched).
  const FOOTER_DEFAULT = {
    tagline: 'Bringing handloom weavers and heritage crafts directly to your wardrobe — one drape at a time.',
    columns: [
      { title: 'Customer Care', links: [{ label: 'Track Order', url: '/track-order' }, { label: 'Order Inquiry', url: '/order-inquiry' }, { label: 'Policies', url: '/policies' }, { label: 'FAQ', url: '/faq' }, { label: 'Contact Us', url: '/contact' }] },
      { title: 'Company', links: [{ label: 'About Padmora', url: '/about' }] }
    ],
    bottomLeft: '© 2026 Padmora. All rights reserved.',
    bottomRight: 'Made with care for handloom weavers across India.'
  };
  function renderFooterContent(f) {
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text || ''; };
    set('footerTagline', f.tagline); set('footerBottomLeft', f.bottomLeft); set('footerBottomRight', f.bottomRight);
    const cols = document.getElementById('footerCols');
    if (!cols) return;
    cols.parentElement.style.setProperty('--footer-cols', Math.max(1, (f.columns || []).length));
    const safeUrl = u => /^(\/(?!\/)|https?:\/\/|mailto:|tel:)/i.test(u) ? u : '#';
    cols.innerHTML = (f.columns || []).map(c => `
      <div>
        <h5>${escHTML(c.title)}</h5>
        <ul>${(c.links || []).map(l => `<li><a href="${escHTML(safeUrl(l.url))}"${/^https?:/i.test(l.url) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escHTML(l.label)}</a></li>`).join('')}</ul>
      </div>`).join('');
  }
  renderFooterContent(FOOTER_DEFAULT);
  siteData('footer', '/settings/footer', r => r.footer).then(footer => { if (footer) renderFooterContent(footer); }).catch(() => {});

  // Patched in after the initial paint (Phase 7 store settings) — the footer
  // still renders instantly with sensible defaults even if this fetch is slow
  // or the API is briefly unavailable.
  siteData('store', '/settings/store', r => r.store).then(store => {
    if (!store) return;
    if (store.contactEmail) {
      const mailLink = document.getElementById('footerMailLink');
      const mailText = document.getElementById('footerMailText');
      if (mailLink) mailLink.href = 'mailto:' + store.contactEmail;
      if (mailText) mailText.textContent = store.contactEmail;
    }
    if (store.instagram) {
      const el = document.getElementById('footerInstagramLink');
      if (el) el.href = store.instagram;
    }
    if (store.youtube) {
      const el = document.getElementById('footerYoutubeLink');
      if (el) el.href = store.youtube;
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------------
// Mini-cart drawer — a slide-out preview so adding to bag doesn't force a
// full page navigation away from what you were browsing.
// ---------------------------------------------------------------------
function initMiniCart() {
  if (document.getElementById('miniCartDrawer')) return;
  const wrap = document.createElement('div');
  wrap.id = 'miniCartWrap';
  wrap.innerHTML = `
    <div class="mini-cart-backdrop" id="miniCartBackdrop"></div>
    <aside class="mini-cart-drawer" id="miniCartDrawer">
      <div class="mini-cart-head">
        <h3>Your Bag</h3>
        <button class="mini-cart-close" id="miniCartClose" aria-label="Close">&times;</button>
      </div>
      <div class="mini-cart-body" id="miniCartBody"><div class="loading-state"><span class="zari-spinner"></span>Loading…</div></div>
      <div class="mini-cart-foot" id="miniCartFoot"></div>
    </aside>`;
  document.body.appendChild(wrap);

  document.getElementById('miniCartBackdrop').addEventListener('click', closeMiniCart);
  document.getElementById('miniCartClose').addEventListener('click', closeMiniCart);
}

function closeMiniCart() {
  const drawer = document.getElementById('miniCartDrawer');
  const backdrop = document.getElementById('miniCartBackdrop');
  if (drawer) drawer.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
}

async function openMiniCart() {
  initMiniCart();
  document.getElementById('miniCartDrawer').classList.add('open');
  document.getElementById('miniCartBackdrop').classList.add('open');
  await renderMiniCart();
}

let miniCartData = null;   // the last bag shown in the drawer (names, prices, photos)

function drawMiniCart() {
  const body = document.getElementById('miniCartBody');
  const foot = document.getElementById('miniCartFoot');
  if (!body || !miniCartData) return;
  // quantities come from the live local picture of the bag, so +/- show up the instant they are tapped
  const items = miniCartData.items
    .map(i => ({ ...i, qty: i.variantId ? cardCart.qty(i.variantId) : i.qty }))
    .filter(i => i.qty > 0 && i.product);
  if (!items.length) {
    body.innerHTML = `<div class="empty-state" style="padding:40px 16px;"><p>Your bag is empty.</p></div>`;
    foot.innerHTML = `<a href="/shop" class="btn btn-primary btn-block" style="justify-content:center;">Browse Sarees</a>`;
    return;
  }
  const subtotal = items.reduce((sum, i) => sum + i.product.price * i.qty, 0);
  body.innerHTML = items.map(item => `
    <div class="mini-cart-line">
      <div class="mini-cart-thumb" style="background:${photoBg(item.imageUrl, item.color, 90)};"></div>
      <div class="mini-cart-line-info">
        <strong>${item.product.name}</strong>
        <span>${money(item.product.price)}</span>
        <div class="qty-stepper mini-cart-stepper">
          <button data-mini-dec="${item.variantId}">−</button><span>${item.qty}</span><button data-mini-inc="${item.variantId}">+</button>
        </div>
      </div>
      <button class="remove-line" data-mini-remove="${item.variantId}" aria-label="Remove">&times;</button>
    </div>`).join('');
  foot.innerHTML = `
    <div class="summary-row total" style="margin-bottom:12px;"><span>Subtotal</span><span>${money(subtotal)}</span></div>
    <a href="/cart" class="btn btn-outline btn-block" style="justify-content:center;margin-bottom:10px;">View Bag</a>
    <a href="/checkout" class="btn btn-primary btn-block" style="justify-content:center;">Checkout</a>`;
}

// One handler for the whole drawer body, so redrawing never loses a listener.
function bindMiniCartOnce() {
  const body = document.getElementById('miniCartBody');
  if (!body || body._bound) return;
  body._bound = true;
  body.addEventListener('click', e => {
    const inc = e.target.closest('[data-mini-inc]'), dec = e.target.closest('[data-mini-dec]'), rm = e.target.closest('[data-mini-remove]');
    const vid = Number((inc || dec || rm || {}).dataset ? (inc ? inc.dataset.miniInc : dec ? dec.dataset.miniDec : rm.dataset.miniRemove) : 0);
    if (!vid || !miniCartData) return;
    const item = miniCartData.items.find(i => Number(i.variantId) === vid);
    if (!item) return;
    const stock = item.product ? item.product.stock : null;
    if (inc) cardCart.change(vid, 1, stock);
    else if (dec) cardCart.change(vid, -1);
    else cardCart.change(vid, -cardCart.qty(vid));
  });
  // redraw whenever the local bag changes (from here, a product card, or the product page)
  cardCart.onChange(() => {
    const drawer = document.getElementById('miniCartDrawer');
    if (!drawer || !drawer.classList.contains('open') || !miniCartData) return;
    // something was added that the drawer has not seen yet: fetch the details once
    const unseen = Object.keys(cardCart.lines).some(v => !miniCartData.items.some(i => String(i.variantId) === v));
    if (unseen) { renderMiniCart(); return; }
    drawMiniCart();
  });
}

async function renderMiniCart() {
  const body = document.getElementById('miniCartBody');
  try {
    bindMiniCartOnce();
    miniCartData = await cardCart.load();
    drawMiniCart();
  } catch (e) {
    body.innerHTML = `<p style="padding:20px;color:var(--ink-soft);font-size:13px;">Could not load your bag.</p>`;
  }
}

// ---------------------------------------------------------------------
// Quick View — a lightweight in-page preview from any product card (shop
// grid, home bestsellers) so a shopper can see details or add to bag
// without leaving the listing. One shared modal, lazily built on first use
// (same pattern as initMiniCart/initSearchOverlay above), reused by every
// page that loads this file instead of each page building its own.
// ---------------------------------------------------------------------
function initQuickView() {
  if (document.getElementById('quickViewDialog')) return;
  const wrap = document.createElement('div');
  wrap.id = 'quickViewWrap';
  wrap.innerHTML = `
    <div class="confirm-backdrop" id="quickViewBackdrop"></div>
    <div class="size-guide-dialog quick-view-dialog" id="quickViewDialog" role="dialog" aria-modal="true">
      <button class="sg-close" id="quickViewClose" aria-label="Close">&times;</button>
      <div id="quickViewBody"><div class="loading-state"><span class="zari-spinner"></span>Loading…</div></div>
    </div>`;
  document.body.appendChild(wrap);

  function close() {
    document.getElementById('quickViewBackdrop').classList.remove('open');
    document.getElementById('quickViewDialog').classList.remove('open');
  }
  document.getElementById('quickViewClose').addEventListener('click', close);
  document.getElementById('quickViewBackdrop').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

async function openQuickView(productId) {
  initQuickView();
  const body = document.getElementById('quickViewBody');
  body.innerHTML = `<div class="loading-state"><span class="zari-spinner"></span>Loading…</div>`;
  document.getElementById('quickViewBackdrop').classList.add('open');
  document.getElementById('quickViewDialog').classList.add('open');

  try {
    const { product: p } = await apiFetch('/products/' + productId);
    const variants = (p.variants && p.variants.length) ? p.variants : [{
      id: null, colorName: p.swatch, swatch: p.swatch, price: p.price, mrp: p.mrp, stock: p.stock, media: [], isDefault: true
    }];
    let selected = variants.find(v => v.isDefault) || variants[0];

    function render() {
      const primaryImage = selected.media && selected.media.find(m => m.type === 'image' && m.isPrimary) || (selected.media || []).find(m => m.type === 'image');
      const soldOut = selected.stock <= 0;
      body.innerHTML = `
        <div class="quick-view-grid">
          <div class="quick-view-media" style="${primaryImage ? `background-image:url('${primaryImage.url}');background-size:cover;background-position:center;` : `background:${swatchBg(selected.swatch)};`}"></div>
          <div class="quick-view-info">
            <div class="product-fabric">${p.fabric}</div>
            <h3>${p.name}</h3>
            <div class="product-rating"><span class="stars">★★★★★</span> ${p.rating} (${p.reviews})</div>
            <div class="product-price" style="margin:8px 0;">
              <span class="price-now">${money(selected.price)}</span>${priceExtrasHTML(p, selected)}
            </div>
            ${variants.length > 1 ? `<div class="swatch-row" id="qvSwatches">${variants.map(v => `<span class="swatch-dot ${v.id === selected.id ? 'active' : ''}" data-qv-variant="${v.id}" title="${v.colorName}" style="background:${swatchBg(v.swatch)};"></span>`).join('')}</div>` : ''}
            ${(() => { const n = stockNote(selected.stock, selected.colorName); return n ? `<p class="stock-note ${n.level}" style="margin:6px 0 14px;">${n.text}</p>` : '<div style="height:14px;"></div>'; })()}
            <button class="btn btn-primary btn-block" id="qvAddToBag" style="justify-content:center;" ${soldOut ? 'disabled' : ''}>${soldOut ? 'Out of Stock' : 'Add to Bag'}</button>
            <a href="/product?id=${p.id}" class="size-guide-link" style="display:block;margin-top:12px;">View Full Details →</a>
          </div>
        </div>`;

      document.querySelectorAll('#qvSwatches [data-qv-variant]').forEach(dot => dot.addEventListener('click', () => {
        const v = variants.find(x => String(x.id) === dot.dataset.qvVariant);
        if (!v || v.id === selected.id) return;
        selected = v;
        render();
      }));
      const addBtn = document.getElementById('qvAddToBag');
      if (addBtn) addBtn.addEventListener('click', () => {
        // instant: the bag badge and the card behind update at once, the server catches up in the background
        cardCart.add(p.id, selected.id, selected.colorName, selected.stock);
        toast('Added to bag');
      });
    }
    render();
  } catch (e) {
    body.innerHTML = `<p style="padding:20px;color:var(--ink-soft);font-size:13px;">Could not load this saree.</p>`;
  }
}

// ---------------------------------------------------------------------
// Instant search — a header dropdown that shows matching sarees as you
// type, debounced so it doesn't hammer the API on every keystroke.
// ---------------------------------------------------------------------
let _searchDebounce = null;

function initSearchOverlay() {
  if (document.getElementById('searchOverlay')) return;
  const wrap = document.createElement('div');
  wrap.id = 'searchOverlayWrap';
  wrap.innerHTML = `
    <div class="search-backdrop" id="searchBackdrop"></div>
    <div class="search-overlay" id="searchOverlay">
      <div class="search-input-row">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" id="instantSearchInput" placeholder="Search sarees — try 'red saree' or 'maheshwari'">
        <button id="searchCloseBtn" aria-label="Close">&times;</button>
      </div>
      <div class="search-results" id="searchResultsBody"></div>
    </div>`;
  document.body.appendChild(wrap);

  document.getElementById('searchBackdrop').addEventListener('click', closeSearchOverlay);
  document.getElementById('searchCloseBtn').addEventListener('click', closeSearchOverlay);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearchOverlay();
  });

  const input = document.getElementById('instantSearchInput');
  input.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    const q = input.value.trim();
    if (!q) { renderSearchIdle(); return; }
    _searchDebounce = setTimeout(() => runInstantSearch(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      window.location.href = '/shop?search=' + encodeURIComponent(input.value.trim());
    }
  });
}

function renderSearchIdle() {
  const body = document.getElementById('searchResultsBody');
  if (body) body.innerHTML = `<p class="search-hint">Start typing to see matching sarees — by name, weave, or color.</p>`;
}

function openSearchOverlay() {
  initSearchOverlay();
  document.getElementById('searchOverlay').classList.add('open');
  document.getElementById('searchBackdrop').classList.add('open');
  renderSearchIdle();
  setTimeout(() => document.getElementById('instantSearchInput').focus(), 50);
}

function closeSearchOverlay() {
  const overlay = document.getElementById('searchOverlay');
  const backdrop = document.getElementById('searchBackdrop');
  if (overlay) overlay.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
}

async function runInstantSearch(query) {
  const body = document.getElementById('searchResultsBody');
  body.innerHTML = `<div class="loading-state"><span class="zari-spinner"></span></div>`;
  try {
    const { products } = await apiFetch('/products?search=' + encodeURIComponent(query));
    if (!products.length) {
      body.innerHTML = `<p class="search-hint">No sarees match "${query}" yet — try a weave name like Ajrakh or Paithani.</p>`;
      return;
    }
    const top = products.slice(0, 6);
    body.innerHTML = `
      <div class="search-result-list">
        ${top.map(p => `
          <a class="search-result-item" href="/product?id=${p.id}">
            <div class="search-result-media" style="background:${productBg(p, 120)};"></div>
            <div class="search-result-info"><strong>${p.name}</strong><span>${p.fabric} · ${money(p.price)}</span></div>
          </a>`).join('')}
      </div>
      <a class="search-view-all" href="/shop?search=${encodeURIComponent(query)}">See all results for "${query}" →</a>`;
  } catch (e) {
    body.innerHTML = `<p class="search-hint">Could not search right now — please try again.</p>`;
  }
}

// ---------------------------------------------------------------------
// Mobile bottom tab bar
// ---------------------------------------------------------------------
function initBottomNav(activePage) {
  if (document.getElementById('bottomNav')) return;
  const TABS = [
    { href: '/', page: 'index.html', label: 'Home', icon: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>' },
    { href: '/shop', page: 'shop.html', label: 'Shop', icon: '<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6L4.5 3H2"/>' },
    { href: '/wishlist', page: 'wishlist.html', label: 'Wishlist', icon: '<path d="M12 21s-7.5-4.7-10-9.3C.3 8 2 4.5 5.6 4.1c2-.2 3.8.8 4.4 2.5.6-1.7 2.4-2.7 4.4-2.5C18 4.5 19.7 8 22 11.7 19.5 16.3 12 21 12 21z"/>' },
    { href: '/cart', page: 'cart.html', label: 'Bag', icon: '<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6L4.5 3H2"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>' },
    { href: isLoggedIn() ? '/account' : '/login', page: isLoggedIn() ? 'account.html' : 'login.html', label: 'Account', icon: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"/>' }
  ];
  const nav = document.createElement('nav');
  nav.id = 'bottomNav';
  nav.className = 'bottom-nav';
  nav.innerHTML = TABS.map(t => `
    <a href="${t.href}" class="bottom-nav-tab ${t.page === activePage ? 'active' : ''}">
      <span class="bottom-nav-icon-wrap"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8">${t.icon}</svg><span class="badge-count" data-bn-badge="${t.label}" style="display:none;"></span></span>
      <span>${t.label}</span>
    </a>`).join('');
  document.body.appendChild(nav);
}

function updateBottomNavBadges(cartData, wishData) {
  const cartBadge = document.querySelector('[data-bn-badge="Bag"]');
  const wishBadge = document.querySelector('[data-bn-badge="Wishlist"]');
  const cartCount = cartData.items.reduce((s, i) => s + i.qty, 0);
  const wishCount = wishData.products.length;
  if (cartBadge) { cartBadge.textContent = cartCount; cartBadge.style.display = cartCount ? 'flex' : 'none'; }
  if (wishBadge) { wishBadge.textContent = wishCount; wishBadge.style.display = wishCount ? 'flex' : 'none'; }
}

// ---------------------------------------------------------------------
// Saree Finder — three quick questions (occasion, budget, weave) that end in real sarees to look at.
// Floating bottom-right on every page. It uses the store's live occasions and weaves, shows how many sarees
// match as you go, never dead-ends (if nothing matches exactly it relaxes the answers and says so), remembers
// the last picks, and closes with the X, the Esc key, or a tap anywhere outside it.
// ---------------------------------------------------------------------
const FINDER_KEY = 'padmora_finder_picks';
const FINDER_BUDGETS = [
  { label: 'Under ₹3,000', min: 0, max: 3000 },
  { label: '₹3,000 – ₹8,000', min: 3000, max: 8000 },
  { label: '₹8,000 – ₹15,000', min: 8000, max: 15000 },
  { label: '₹15,000 & above', min: 15000, max: 0 }
];
const FINDER_STATE = { occasion: null, budget: null, fabric: null }; // null = not answered yet, '' / -1 = "any"
let finderMeta = null;
let finderRun = 0; // guards against an older, slower answer overwriting a newer screen

async function loadFinderMeta() {
  if (finderMeta) return finderMeta;
  const fallback = { occasions: ['Wedding', 'Festive', 'Party', 'Casual', 'Office'], fabrics: ['Maheshwari', 'Ajrakh', 'Paithani', 'Narayanpeth'] };
  try {
    const [o, f] = await Promise.all([apiFetch('/occasions'), apiFetch('/fabrics')]);
    const occasions = (o.occasions || []).map(x => x.name).filter(Boolean);
    const fabrics = (f.fabrics || []).filter(x => x.productCount > 0).map(x => x.name);
    finderMeta = { occasions: occasions.length ? occasions : fallback.occasions, fabrics: fabrics.length ? fabrics : fallback.fabrics };
  } catch (e) { finderMeta = fallback; }
  return finderMeta;
}

function finderQuery(state, { withLimit } = {}) {
  const q = new URLSearchParams();
  if (state.occasion) q.set('occasion', state.occasion);
  const b = state.budget != null && state.budget >= 0 ? FINDER_BUDGETS[state.budget] : null;
  if (b) { if (b.min) q.set('minPrice', b.min); if (b.max) q.set('maxPrice', b.max); }
  if (state.fabric) q.set('fabric', state.fabric);
  if (withLimit) q.set('limit', withLimit);
  return q;
}

function initSareeFinder() {
  if (document.getElementById('sareeFinderBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'sareeFinderBtn';
  btn.className = 'saree-finder-btn';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5z"/></svg><span>Find My Saree</span>`;
  document.body.appendChild(btn);

  const backdrop = document.createElement('div');
  backdrop.id = 'sareeFinderBackdrop';
  backdrop.className = 'saree-finder-backdrop';
  document.body.appendChild(backdrop);

  const panel = document.createElement('div');
  panel.id = 'sareeFinderPanel';
  panel.className = 'saree-finder-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Find my saree');
  document.body.appendChild(panel);

  const isOpen = () => panel.classList.contains('open');
  const close = () => {
    panel.classList.remove('open'); backdrop.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    finderRun++;
  };
  const open = () => {
    panel.classList.add('open'); backdrop.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    FINDER_STATE.occasion = null; FINDER_STATE.budget = null; FINDER_STATE.fabric = null;
    renderFinderStep('occasion');
  };
  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  // a tap anywhere outside the window (the dimmed page behind it) closes it
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) close(); });
  // Delegated and bound once — every step replaces panel.innerHTML, so per-step listeners would be lost.
  panel.addEventListener('click', e => { if (e.target.closest('#finderCloseBtn')) close(); });
}

function finderShell(title, bodyHTML, { back, step } = {}) {
  const dots = step ? `<div class="finder-progress" aria-label="Question ${step} of 3">${[1, 2, 3].map(n => `<span class="${n <= step ? 'on' : ''}"></span>`).join('')}</div>` : '';
  return `
    <div class="finder-head">
      ${back ? '<button class="finder-back" data-finder-back aria-label="Back">←</button>' : '<span class="finder-back"></span>'}
      <strong>${title}</strong>
      <button class="finder-close" id="finderCloseBtn" aria-label="Close">&times;</button>
    </div>
    ${dots}
    ${bodyHTML}`;
}

function chipsHTML(items, attr, selectedValue) {
  return `<div class="finder-chips">${items.map(i => `<button type="button" class="finder-chip${String(i.value) === String(selectedValue) ? ' picked' : ''}" ${attr}="${String(i.value).replace(/"/g, '&quot;')}">${i.label}</button>`).join('')}</div>`;
}

// "34 sarees match so far" — updates itself under the options as the answers narrow things down.
async function updateFinderCount() {
  const el = document.getElementById('finderCount');
  if (!el) return;
  const run = finderRun;
  try {
    const { total } = await apiFetch('/products?' + finderQuery(FINDER_STATE, { withLimit: 1 }).toString());
    if (run !== finderRun || !document.getElementById('finderCount')) return;
    el.textContent = total === 0 ? 'No exact match yet — we will find the closest.' : `${total} saree${total === 1 ? '' : 's'} to choose from`;
  } catch (e) { /* the count is a nicety; the quiz works without it */ }
}

async function renderFinderStep(step) {
  const panel = document.getElementById('sareeFinderPanel');
  const run = ++finderRun;
  const meta = await loadFinderMeta();
  if (run !== finderRun) return;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(FINDER_KEY) || 'null'); } catch (e) { return null; } })();

  if (step === 'occasion') {
    const again = saved && (saved.occasion != null || saved.budget != null || saved.fabric != null)
      ? `<button type="button" class="finder-again" id="finderUseLast">Use my last picks</button>` : '';
    panel.innerHTML = finderShell('What\'s the occasion?',
      chipsHTML([...meta.occasions.map(o => ({ value: o, label: o })), { value: '', label: 'Any occasion' }], 'data-occasion', FINDER_STATE.occasion) +
      again + `<p class="finder-count" id="finderCount" aria-live="polite"></p>`, { step: 1 });
    panel.querySelectorAll('[data-occasion]').forEach(b => b.addEventListener('click', () => { FINDER_STATE.occasion = b.dataset.occasion; renderFinderStep('budget'); }));
    const last = document.getElementById('finderUseLast');
    if (last) last.addEventListener('click', () => { Object.assign(FINDER_STATE, saved); renderFinderResults(); });
  } else if (step === 'budget') {
    panel.innerHTML = finderShell('What\'s your budget?',
      chipsHTML([...FINDER_BUDGETS.map((b, i) => ({ value: i, label: b.label })), { value: -1, label: 'Show me everything' }], 'data-budget', FINDER_STATE.budget) +
      `<p class="finder-count" id="finderCount" aria-live="polite"></p>`, { back: true, step: 2 });
    panel.querySelector('[data-finder-back]').addEventListener('click', () => renderFinderStep('occasion'));
    panel.querySelectorAll('[data-budget]').forEach(b => b.addEventListener('click', () => { FINDER_STATE.budget = Number(b.dataset.budget); renderFinderStep('fabric'); }));
  } else if (step === 'fabric') {
    panel.innerHTML = finderShell('Which weave?',
      chipsHTML([...meta.fabrics.map(f => ({ value: f, label: f })), { value: '', label: 'Surprise me' }], 'data-fabric', FINDER_STATE.fabric) +
      `<p class="finder-count" id="finderCount" aria-live="polite"></p>`, { back: true, step: 3 });
    panel.querySelector('[data-finder-back]').addEventListener('click', () => renderFinderStep('budget'));
    panel.querySelectorAll('[data-fabric]').forEach(b => b.addEventListener('click', () => { FINDER_STATE.fabric = b.dataset.fabric; renderFinderResults(); }));
  }
  updateFinderCount();
}

async function renderFinderResults() {
  const panel = document.getElementById('sareeFinderPanel');
  const run = ++finderRun;
  panel.innerHTML = finderShell('Picked for you', `<div class="loading-state" style="padding:24px 0;"><span class="zari-spinner"></span></div>`, { back: true });
  panel.querySelector('[data-finder-back]').addEventListener('click', () => renderFinderStep('fabric'));
  try { localStorage.setItem(FINDER_KEY, JSON.stringify(FINDER_STATE)); } catch (e) { /* private mode */ }

  try {
    // Exact answers first; if nothing fits, loosen one answer at a time (weave, then budget, then occasion) so the
    // shopper always sees real sarees — and is told when they are "closest" picks rather than exact matches.
    const attempts = [
      { state: FINDER_STATE, note: '' },
      { state: { ...FINDER_STATE, fabric: '' }, note: 'No exact match for that weave — here are the closest picks.' },
      { state: { ...FINDER_STATE, fabric: '', budget: -1 }, note: 'Nothing in that budget — here are the closest picks.' },
      { state: { occasion: '', budget: -1, fabric: '' }, note: 'Nothing matched exactly — here are our most loved sarees.' }
    ];
    let products = [], note = '', used = FINDER_STATE, total = 0;
    for (const a of attempts) {
      const q = finderQuery(a.state); q.set('sort', 'rating');
      const res = await apiFetch('/products?' + q.toString());
      if (run !== finderRun) return;
      if (res.products.length) { products = res.products; total = res.total != null ? res.total : res.products.length; note = a.note; used = a.state; break; }
    }
    const top = products.slice(0, 4);
    const allQuery = finderQuery(used).toString();
    const body = top.length ? `
      ${note ? `<p class="finder-note">${note}</p>` : ''}
      <div class="finder-results">
        ${top.map(p => `
          <a class="finder-result-card" href="/product?id=${p.id}">
            <div class="finder-result-media" style="background:${productBg(p, 120)};"></div>
            <div class="finder-result-text"><strong>${escHTML(p.name)}</strong><small>${escHTML(p.fabric)}${p.occasion ? ' · ' + escHTML(p.occasion) : ''}</small><span>${money(p.price)}${p.rating ? ` <em>★ ${p.rating}</em>` : ''}</span></div>
          </a>`).join('')}
      </div>
      <a class="btn btn-primary btn-block" style="justify-content:center;" href="/shop${allQuery ? '?' + allQuery : ''}">See all ${total} match${total === 1 ? '' : 'es'}</a>
      <button type="button" class="finder-again" id="finderRestart">Start over</button>`
      : `<p class="finder-note">We could not find sarees right now.</p><a class="btn btn-outline btn-block" style="justify-content:center;" href="/shop">Browse all sarees</a>`;
    panel.innerHTML = finderShell('Picked for you', body, { back: true });
    panel.querySelector('[data-finder-back]').addEventListener('click', () => renderFinderStep('fabric'));
    const restart = document.getElementById('finderRestart');
    if (restart) restart.addEventListener('click', () => { FINDER_STATE.occasion = null; FINDER_STATE.budget = null; FINDER_STATE.fabric = null; renderFinderStep('occasion'); });
  } catch (e) {
    if (run !== finderRun) return;
    panel.innerHTML = finderShell('Picked for you', `<p class="finder-note">Could not load recommendations right now.</p>`, { back: true });
    panel.querySelector('[data-finder-back]').addEventListener('click', () => renderFinderStep('fabric'));
  }
}

// ---------------------------------------------------------------------
// Back to top
// ---------------------------------------------------------------------
function initBackToTop() {
  if (document.getElementById('backToTopBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'backToTopBtn';
  btn.className = 'back-to-top-btn';
  btn.setAttribute('aria-label', 'Back to top');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
  document.body.appendChild(btn);

  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 500);
  }, { passive: true });
}

// ---------------------------------------------------------------------
// Confirm dialog — an animated modal used in place of native confirm()
// for anything destructive or hard to undo (logout, cancelling an order).
// Usage: const ok = await showConfirmDialog('message', {title, confirmLabel, cancelLabel, danger});
// ---------------------------------------------------------------------
function showConfirmDialog(message, opts) {
  opts = opts || {};
  const title = opts.title || 'Are you sure?';
  const confirmLabel = opts.confirmLabel || 'Confirm';
  const cancelLabel = opts.cancelLabel || 'Cancel';
  const danger = !!opts.danger;

  return new Promise((resolve) => {
    const existing = document.getElementById('confirmDialogWrap');
    if (existing) existing.remove();

    const wrap = document.createElement('div');
    wrap.id = 'confirmDialogWrap';
    wrap.innerHTML = `
      <div class="confirm-backdrop" id="confirmBackdrop"></div>
      <div class="confirm-dialog" id="confirmDialogBox" role="alertdialog" aria-modal="true">
        <div class="confirm-icon ${danger ? 'danger' : ''}">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
        </div>
        <h3>${title}</h3>
        <p>${message}</p>
        <div class="confirm-actions">
          <button class="btn btn-outline" id="confirmCancelBtn">${cancelLabel}</button>
          <button class="btn btn-primary ${danger ? 'confirm-danger-btn' : ''}" id="confirmOkBtn">${confirmLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    requestAnimationFrame(() => {
      document.getElementById('confirmBackdrop').classList.add('open');
      document.getElementById('confirmDialogBox').classList.add('open');
    });

    function finish(result) {
      const backdrop = document.getElementById('confirmBackdrop');
      const box = document.getElementById('confirmDialogBox');
      if (backdrop) backdrop.classList.remove('open');
      if (box) box.classList.remove('open');
      setTimeout(() => wrap.remove(), 220);
      resolve(result);
    }

    document.getElementById('confirmOkBtn').addEventListener('click', () => finish(true));
    document.getElementById('confirmCancelBtn').addEventListener('click', () => finish(false));
    document.getElementById('confirmBackdrop').addEventListener('click', () => finish(false));
    const escHandler = (e) => { if (e.key === 'Escape') { finish(false); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
  });
}

// ---------------------------------------------------------------------
// Product cards: the hover "Add to Cart / Quick View" buttons, shared by every page that shows cards (shop, sale,
// the recommended sarees on a product page). Adding and +/- go through cardCart (js/api.js), so they happen on screen
// instantly and the server catches up in the background.
// ---------------------------------------------------------------------
const CARD_PRODUCTS = new Map();
// The product video inside a product card (hidden until it is playing). It loads nothing until the card is hovered.
// A card without a video gets nothing at all, so those cards are exactly as before.
function cardVideoHTML(p) {
  const url = productVideoUrl(p);
  return url ? `<video class="card-video" muted loop playsinline preload="none" tabindex="-1" aria-hidden="true" disablepictureinpicture data-src="${String(url).replace(/"/g, '&quot;')}"></video>` : '';
}
// Hovering a card with a video plays it (after a short pause, so sweeping the mouse across a grid starts nothing); leaving
// stops it. Mouse devices only - phones and tablets keep the photo - and nothing plays for shoppers who asked for reduced
// motion or a data saver. Listeners sit on the document, so cards drawn later (filters, "load more") work without any setup.
(function cardVideos() {
  const fine = () => !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  const calm = () => !!((window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || (navigator.connection && navigator.connection.saveData));
  let timer = null, current = null;
  const videoOf = card => card && card.querySelector('.card-video');
  function stop(card) {
    const v = videoOf(card);
    if (!v) return;
    v.pause();
    try { v.currentTime = 0; } catch (e) { /* not loaded yet */ }
    const box = v.closest('.product-media');
    if (box) box.classList.remove('is-playing');
  }
  function start(card) {
    const v = videoOf(card);
    if (!v) return;
    if (!v.getAttribute('src') && v.dataset.src) v.src = v.dataset.src;
    const p = v.play();
    if (p && p.catch) p.catch(() => { /* blocked or failed: the photo simply stays */ });
  }
  // the video fades in only once it is really playing, so a slow video never shows a black box
  document.addEventListener('playing', e => {
    const v = e.target;
    if (v && v.classList && v.classList.contains('card-video') && v.closest('.product-card:hover')) { const box = v.closest('.product-media'); if (box) box.classList.add('is-playing'); }
  }, true);
  document.addEventListener('mouseover', e => {
    const card = e.target.closest && e.target.closest('.product-card');
    if (!card || card === current) return;
    if (current) stop(current);
    current = card;
    clearTimeout(timer);
    if (!videoOf(card) || !fine() || calm()) return;
    timer = setTimeout(() => start(card), 140);
  });
  document.addEventListener('mouseout', e => {
    const card = e.target.closest && e.target.closest('.product-card');
    if (!card || (e.relatedTarget && card.contains(e.relatedTarget))) return;
    clearTimeout(timer);
    stop(card);
    if (current === card) current = null;
  });
})();

function registerCardProducts(list) { (list || []).forEach(p => CARD_PRODUCTS.set(p.id, p)); }
function defaultVariantOf(p) { return (p && p.variants && (p.variants.find(v => v.isDefault) || p.variants[0])) || null; }

function cardActionsInner(p) {
  const dv = defaultVariantOf(p);
  const line = dv ? cardCart.lines[dv.id] : null;
  const colorEsc = (dv ? dv.colorName : (p.swatch || '')).replace(/'/g, "\\'");
  const first = line && line.qty > 0
    ? `<div class="card-qty-stepper"><button type="button" onclick="event.preventDefault();cardChangeQty(${dv.id}, -1);">−</button><span>${line.qty}</span><button type="button" onclick="event.preventDefault();cardChangeQty(${dv.id}, 1);">+</button></div>`
    : `<button type="button" onclick="event.preventDefault();quickAddToCart(${p.id}, ${dv ? dv.id : 'null'}, '${colorEsc}', this);">Add to Cart</button>`;
  return first + `<button type="button" onclick="event.preventDefault();openQuickView(${p.id});">Quick View</button>`;
}

function quickAddToCart(productId, variantId, color) {
  const p = CARD_PRODUCTS.get(Number(productId));
  const dv = defaultVariantOf(p);
  cardCart.add(productId, variantId, color, dv ? dv.stock : null);
  toast('Added to bag');
}

function cardChangeQty(variantId, delta) {
  let stock = null;
  for (const p of CARD_PRODUCTS.values()) {
    const v = (p.variants || []).find(x => x.id === Number(variantId));
    if (v) { stock = v.stock; break; }
  }
  cardCart.change(variantId, delta, stock);
}

// Redraws only the cards whose bag quantity changed, and only their button area, so a card you are hovering keeps
// its buttons on screen while the number changes.
function syncCardActions() {
  document.querySelectorAll('.product-card[data-pid]').forEach(card => {
    const p = CARD_PRODUCTS.get(Number(card.dataset.pid));
    if (!p || p.stock <= 0) return;
    const dv = defaultVariantOf(p);
    const q = dv ? cardCart.qty(dv.id) : 0;
    if (String(q) !== (card.dataset.qty || '0')) {
      card.dataset.qty = String(q);
      const qa = card.querySelector('.quick-actions');
      if (qa) qa.innerHTML = cardActionsInner(p);
    }
  });
}
cardCart.onChange(syncCardActions);

// Confetti burst for celebratory moments (order confirmed). Pure canvas, no dependency.
// Time-based, so it looks the same on a 60 Hz phone, a 120 Hz phone and a desktop: pieces fall the full height
// of whatever screen this is (phones included) and only fade out at the very end. If the phone is in "reduce
// motion" mode the pieces do not fall - they appear as a still sprinkle that fades - so the celebration is still
// seen without any movement. If the page is in the background (for example returning from a UPI app) it waits
// until it is visible again.
function fireConfetti(opts) {
  if (document.hidden) {
    const again = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', again); fireConfetti(opts); } };
    document.addEventListener('visibilitychange', again);
    return;
  }
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const W0 = window.innerWidth, H0 = window.innerHeight;
  const options = Object.assign({ duration: reduce ? 1800 : 4200, pieceCount: W0 < 640 ? 120 : 170 }, opts || {});
  const colors = ['#AD3B5C', '#7A2740', '#D9A97C', '#F2B9BB', '#B87F55', '#D9749A', '#E8C07A'];

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:9999;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  function size() {
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  const onResize = () => size();
  window.addEventListener('resize', onResize);

  const pieces = Array.from({ length: options.pieceCount }, () => ({
    x: W0 * (0.04 + Math.random() * 0.92),
    y: reduce ? H0 * (0.08 + Math.random() * 0.7) : -20 - Math.random() * H0 * 0.55,
    w: 6 + Math.random() * 7,
    h: 9 + Math.random() * 10,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI,
    vRot: (Math.random() - 0.5) * 6,          // radians per second
    vx: (Math.random() - 0.5) * 110,          // px per second
    vy: H0 * (0.30 + Math.random() * 0.34),   // the whole screen height in roughly 2-3 seconds
    tilt: Math.random() * Math.PI,
    vTilt: 5 + Math.random() * 5,
    shape: Math.random() > 0.5 ? 'rect' : 'circle'
  }));

  const start = performance.now();
  let last = start;
  function frame(now) {
    const elapsed = now - start;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const fade = Math.min(1, Math.max(0, (options.duration - elapsed) / (options.duration * 0.3)));
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    pieces.forEach(p => {
      if (!reduce) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 40 * dt;
        p.rot += p.vRot * dt;
        p.tilt += p.vTilt * dt;
      }
      const wobble = reduce ? 0 : Math.sin(p.tilt) * 6;
      ctx.save();
      ctx.translate(p.x + wobble, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = fade;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    });
    if (elapsed < options.duration) {
      requestAnimationFrame(frame);
    } else {
      window.removeEventListener('resize', onResize);
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}
window.fireConfetti = fireConfetti;

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.getAttribute('data-page') || '';
  initHeader(page);
  initFooter();
  // Mini-cart, search overlay, the mobile bottom-nav, and the floating
  // "Find My Saree" button are all shopper engagement chrome — on the admin
  // dashboard they're not just irrelevant, the FAB actively floats on top of
  // dashboard controls. Skip them there.
  if (!isAdminRealm()) {
    initMiniCart();
    initSearchOverlay();
    initBottomNav(page);
    initSareeFinder();
  }
  initBackToTop();
});
