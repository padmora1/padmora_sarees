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
async function loadNavCollectionsDropdown() {
  const desktopPanel = document.getElementById('navDropdown-collections.html');
  const mobilePanel = document.getElementById('mobileNavDropdown-collections.html');
  if (!desktopPanel && !mobilePanel) return;
  try {
    const { collections } = await apiFetch('/collections');
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
          <a href="/admin" class="logo"><img src="images/padmora-lotus.png" alt="" class="logo-mark">Padmora</a>
          <a href="/" class="admin-view-store" target="_blank" rel="noopener noreferrer">View Store ↗</a>
        </div>
      </header>`;
    return;
  }

  mount.innerHTML = `
    <div class="topbar" id="siteTopbar">Free shipping above ₹1,999 · Easy 7-day returns · Secure payments via Razorpay</div>
    <header class="site-header">
      <div class="header-inner">
        <button class="hamburger" id="hamburgerBtn" aria-label="Open menu">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        </button>
        <a href="/" class="logo" aria-label="Padmora — home"><img src="images/padmora-lotus.png" alt="" class="logo-mark"><span class="logo-text-stage" aria-hidden="true"><span class="logo-text-el active" id="logoTextEn">Padmora</span><span class="logo-text-el lang-mr" id="logoTextMr">पद्मोरा</span></span></a>
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

  // Keep the topbar's free-shipping claim honest against the admin's actual
  // Phase 7 shipping settings, not a hardcoded number that can drift out of
  // sync the moment an admin changes the threshold.
  apiFetch('/settings/shipping').then(({ shipping }) => {
    if (!shipping || !shipping.freeShippingThreshold) return;
    const bar = document.getElementById('siteTopbar');
    if (bar) bar.textContent = `Free shipping above ${money(shipping.freeShippingThreshold)} · Easy 7-day returns · Secure payments via Razorpay`;
  }).catch(() => {});
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

async function refreshBadgeCounts() {
  const cartEl = document.getElementById('cartCount');
  const wishEl = document.getElementById('wishlistCount');
  try {
    const [cartData, wishData] = await Promise.all([cartGet(), wishlistGet()]);
    if (cartEl) cartEl.textContent = cartData.items.reduce((s, i) => s + i.qty, 0);
    if (wishEl) wishEl.textContent = wishData.products.length;
    updateBottomNavBadges(cartData, wishData);
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
            <a class="footer-mail" id="footerMailLink" href="mailto:hello@padmora.example">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>
              <span id="footerMailText">hello@padmora.example</span>
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
      { title: 'Customer Care', links: [{ label: 'Track Order', url: '/track-order' }, { label: 'Policies', url: '/policies' }, { label: 'FAQ', url: '/faq' }, { label: 'Contact Us', url: '/contact' }] },
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
  apiFetch('/settings/footer').then(({ footer }) => { if (footer) renderFooterContent(footer); }).catch(() => {});

  // Patched in after the initial paint (Phase 7 store settings) — the footer
  // still renders instantly with sensible defaults even if this fetch is slow
  // or the API is briefly unavailable.
  apiFetch('/settings/store').then(({ store }) => {
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

async function renderMiniCart() {
  const body = document.getElementById('miniCartBody');
  const foot = document.getElementById('miniCartFoot');
  try {
    const cart = await cartGet();
    if (!cart.items.length) {
      body.innerHTML = `<div class="empty-state" style="padding:40px 16px;"><p>Your bag is empty.</p></div>`;
      foot.innerHTML = `<a href="/shop" class="btn btn-primary btn-block" style="justify-content:center;">Browse Sarees</a>`;
      return;
    }
    body.innerHTML = cart.items.map(item => `
      <div class="mini-cart-line">
        <div class="mini-cart-thumb" style="background:${photoBg(item.imageUrl, item.color)};"></div>
        <div class="mini-cart-line-info">
          <strong>${item.product.name}</strong>
          <span>${money(item.product.price)}</span>
          <div class="qty-stepper mini-cart-stepper">
            <button data-mini-dec="${item.id}">−</button><span>${item.qty}</span><button data-mini-inc="${item.id}">+</button>
          </div>
        </div>
        <button class="remove-line" data-mini-remove="${item.id}" aria-label="Remove">&times;</button>
      </div>`).join('');
    foot.innerHTML = `
      <div class="summary-row total" style="margin-bottom:12px;"><span>Subtotal</span><span>${money(cart.subtotal)}</span></div>
      <a href="/cart" class="btn btn-outline btn-block" style="justify-content:center;margin-bottom:10px;">View Bag</a>
      <a href="/checkout" class="btn btn-primary btn-block" style="justify-content:center;">Checkout</a>`;

    document.querySelectorAll('[data-mini-remove]').forEach(btn => btn.addEventListener('click', async () => {
      await cartRemoveItem(btn.dataset.miniRemove);
      renderMiniCart();
      refreshBadgeCounts();
    }));
    async function changeMiniQty(itemId, delta) {
      const item = cart.items.find(i => i.id === itemId);
      const newQty = item.qty + delta;
      if (newQty <= 0) { await cartRemoveItem(itemId); renderMiniCart(); refreshBadgeCounts(); return; }
      if (delta > 0 && item.product && newQty > item.product.stock) {
        toast(`Only ${item.product.stock} left in stock.`);
        return;
      }
      try {
        const updated = await cartUpdateQty(itemId, newQty);
        if (updated.message) toast(updated.message);
        renderMiniCart();
        refreshBadgeCounts();
      } catch (e) { toast(e.message, 'error'); }
    }
    document.querySelectorAll('[data-mini-inc]').forEach(btn => btn.addEventListener('click', () => changeMiniQty(btn.dataset.miniInc, 1)));
    document.querySelectorAll('[data-mini-dec]').forEach(btn => btn.addEventListener('click', () => changeMiniQty(btn.dataset.miniDec, -1)));
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
            <div class="product-fabric">${p.fabric} · ${p.occasion}</div>
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
      if (addBtn) addBtn.addEventListener('click', async () => {
        try {
          await cartAdd(p.id, 1, selected.colorName, selected.id);
          refreshBadgeCounts();
          toast('Added to bag');
          // Lets the product card behind the modal flip from "Add to Cart" to
          // a qty stepper too, same as adding straight from the card does.
          if (typeof window.refreshProductGrid === 'function') window.refreshProductGrid();
        } catch (e) { toast(e.message, 'error'); }
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
            <div class="search-result-media" style="background:${productBg(p)};"></div>
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
// Saree Finder — a quick 3-question quiz (occasion, budget, fabric) that
// recommends sarees, floating bottom-right on every page.
// ---------------------------------------------------------------------
function initSareeFinder() {
  if (document.getElementById('sareeFinderBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'sareeFinderBtn';
  btn.className = 'saree-finder-btn';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5z"/></svg><span>Find My Saree</span>`;
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'sareeFinderPanel';
  panel.className = 'saree-finder-panel';
  document.body.appendChild(panel);

  btn.addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) renderFinderStep('occasion');
  });

  // Delegated, bound once — every step's panel.innerHTML gets replaced on
  // navigation, which was silently dropping a fresh per-step listener on
  // #finderCloseBtn (only the final results step ever rebound it, so × did
  // nothing on the occasion/budget/fabric steps). Delegation survives re-renders.
  panel.addEventListener('click', (e) => {
    if (e.target.closest('#finderCloseBtn')) panel.classList.remove('open');
  });
}

const FINDER_STATE = { occasion: null, maxPrice: null, fabric: null };

function renderFinderStep(step) {
  const panel = document.getElementById('sareeFinderPanel');
  if (step === 'occasion') {
    panel.innerHTML = finderShell('What\'s the occasion?', `
      <div class="finder-options">
        ${['Wedding','Festive','Party','Casual','Office'].map(o=>`<button class="finder-opt" data-occasion="${o}">${o}</button>`).join('')}
      </div>`);
    panel.querySelectorAll('[data-occasion]').forEach(b => b.addEventListener('click', () => {
      FINDER_STATE.occasion = b.dataset.occasion;
      renderFinderStep('budget');
    }));
  } else if (step === 'budget') {
    panel.innerHTML = finderShell('What\'s your budget?', `
      <div class="finder-options">
        ${[['Under ₹3,000','3000'],['₹3,000–₹8,000','8000'],['₹8,000–₹15,000','15000'],['₹15,000+','']].map(([label,val])=>`<button class="finder-opt" data-budget="${val}">${label}</button>`).join('')}
      </div>`, true);
    bindFinderBack(panel, 'occasion');
    panel.querySelectorAll('[data-budget]').forEach(b => b.addEventListener('click', () => {
      FINDER_STATE.maxPrice = b.dataset.budget || null;
      renderFinderStep('fabric');
    }));
  } else if (step === 'fabric') {
    panel.innerHTML = finderShell('Any weave preference?', `
      <div class="finder-options">
        ${['Any','Maheshwari','Ajrakh','Paithani','Narayanpeth'].map(f=>`<button class="finder-opt" data-fabric="${f}">${f}</button>`).join('')}
      </div>`, true);
    bindFinderBack(panel, 'budget');
    panel.querySelectorAll('[data-fabric]').forEach(b => b.addEventListener('click', () => {
      FINDER_STATE.fabric = b.dataset.fabric;
      renderFinderResults();
    }));
  }
}

function bindFinderBack(panel, prevStep) {
  const backBtn = panel.querySelector('[data-finder-back]');
  if (backBtn) backBtn.addEventListener('click', () => renderFinderStep(prevStep));
}

function finderShell(title, bodyHTML, showBack) {
  return `
    <div class="finder-head">
      ${showBack ? '<button class="finder-back" data-finder-back aria-label="Back">←</button>' : '<span></span>'}
      <strong>${title}</strong>
      <button class="finder-close" id="finderCloseBtn" aria-label="Close">&times;</button>
    </div>
    ${bodyHTML}`;
}

async function renderFinderResults() {
  const panel = document.getElementById('sareeFinderPanel');
  panel.innerHTML = finderShell('Picked for you', `<div class="loading-state"><span class="zari-spinner"></span></div>`, true);
  bindFinderBack(panel, 'fabric');

  const q = new URLSearchParams();
  if (FINDER_STATE.occasion) q.set('occasion', FINDER_STATE.occasion);
  if (FINDER_STATE.maxPrice) q.set('maxPrice', FINDER_STATE.maxPrice);
  if (FINDER_STATE.fabric && FINDER_STATE.fabric !== 'Any') {
    q.set('fabric', FINDER_STATE.fabric);
  }
  q.set('sort', 'rating');

  try {
    const { products } = await apiFetch('/products?' + q.toString());
    const top = products.slice(0, 4);
    const resultsHTML = top.length ? `
      <div class="finder-results">
        ${top.map(p => `
          <a class="finder-result-card" href="/product?id=${p.id}">
            <div class="finder-result-media" style="background:${productBg(p)};"></div>
            <div><strong>${p.name}</strong><span>${money(p.price)}</span></div>
          </a>`).join('')}
      </div>
      <a class="btn btn-primary btn-block" style="justify-content:center;margin-top:10px;" href="/shop?${q.toString()}">See All Matches</a>`
      : `<p style="padding:14px 4px;font-size:13px;color:var(--ink-soft);">No exact matches — but browse the full collection, we're adding new weaves often.</p>
         <a class="btn btn-outline btn-block" style="justify-content:center;" href="/shop">Browse All Sarees</a>`;

    panel.innerHTML = finderShell('Picked for you', resultsHTML, true);
    bindFinderBack(panel, 'fabric');
  } catch (e) {
    panel.innerHTML = finderShell('Picked for you', `<p style="padding:14px 4px;font-size:13px;color:var(--ink-soft);">Could not load recommendations right now.</p>`, true);
    bindFinderBack(panel, 'fabric');
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

// Confetti burst for celebratory moments (order confirmed). Pure canvas,
// no dependency — respects prefers-reduced-motion by skipping entirely.
function fireConfetti(opts) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const options = Object.assign({ duration: 2600, pieceCount: 140 }, opts || {});
  const colors = ['#AD3B5C', '#7A2740', '#D9A97C', '#F2B9BB', '#B87F55', '#D9749A'];

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  function size() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  const onResize = () => size();
  window.addEventListener('resize', onResize);

  const pieces = Array.from({ length: options.pieceCount }, () => ({
    x: window.innerWidth * (0.15 + Math.random() * 0.7),
    y: -20 - Math.random() * 200,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 10,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI,
    vRot: (Math.random() - 0.5) * 0.3,
    vx: (Math.random() - 0.5) * 3,
    vy: 2 + Math.random() * 3,
    tilt: Math.random() * Math.PI,
    vTilt: 0.08 + Math.random() * 0.08,
    shape: Math.random() > 0.5 ? 'rect' : 'circle'
  }));

  const start = performance.now();
  let rafId;
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    pieces.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.02;
      p.rot += p.vRot;
      p.tilt += p.vTilt;
      const wobble = Math.sin(p.tilt) * 6;
      ctx.save();
      ctx.translate(p.x + wobble, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - elapsed / options.duration);
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
      rafId = requestAnimationFrame(frame);
    } else {
      window.removeEventListener('resize', onResize);
      canvas.remove();
    }
  }
  rafId = requestAnimationFrame(frame);
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
