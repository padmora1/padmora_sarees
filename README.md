# Padmora by Yashi — Saree E-Commerce Website

A full-stack saree shopping site split into a `frontend/` (static HTML, CSS, JS)
and a `backend/` (Node.js + Express API backed by SQLite). The catalog is
deliberately curated to four crafts — **Maheshwari, Ajrakh, Paithani, and
Narayanpet** — with more added only as the brand verifies new artisan
partners in person.

## Folder structure

```
saree-store/
├── backend/
│   ├── server.js            Entry point — API + serves the frontend
│   ├── package.json
│   ├── .env                 JWT_SECRET, PORT (gitignore this in real deployment)
│   ├── data/
│   │   ├── products.json    Seed catalog (12 sarees across 4 crafts) — only read once, on first boot
│   │   └── zaree.db         SQLite database (auto-created on first run)
│   ├── middleware/
│   │   └── auth.js          JWT auth guard
│   ├── routes/
│   │   ├── auth.js          Register / login / profile
│   │   ├── products.js      Product listing + filters + instant search + reels feed
│   │   ├── cart.js          Bag management + promo codes
│   │   ├── wishlist.js      Wishlist management
│   │   ├── orders.js        Checkout, order history, tracking, cancellation
│   │   ├── reviews.js       Product ratings & reviews (verified-purchase aware)
│   │   ├── contact.js       Contact form submissions
│   │   ├── admin.js         Admin-only: products, orders, stats, messages
│   │   ├── addresses.js     Multiple saved addresses per user
│   │   └── coupons.js       Public coupon preview (used by guest carts)
│   └── utils/
│       ├── db.js            SQLite schema, seeding, and product queries
│       ├── pricing.js       Coupon validation shared by cart + checkout
│       └── orderStatus.js   Simulated fulfillment timeline (Confirmed → Delivered)
└── frontend/
    ├── index.html           Home page
    ├── shop.html             "Menu" — full catalog with filters/search/sort
    ├── product.html          Product detail: authenticity card, reviews, related items
    ├── cart.html              Bag page with live promo codes
    ├── wishlist.html          Wishlist page
    ├── login.html / register.html
    ├── account.html           Profile, addresses, order history + cancel
    ├── checkout.html          3-step checkout (address + gift note → payment → confirm)
    ├── track-order.html       Animated order tracker — live path, updates feed, confetti on delivery
    ├── about.html             Brand story
    ├── our-weaves.html        Handloom vs powerloom explainer, region-by-region weaves
    ├── contact.html           Contact form (writes to the backend)
    ├── faq.html               Accordion FAQ
    ├── admin.html             Admin dashboard — products, orders, stats, messages
    ├── shipping-returns.html, privacy-policy.html, terms.html
    ├── css/style.css          Shared design system
    └── js/
        ├── api.js             fetch() wrapper, guest cart/wishlist, shared helpers (money, toast, swatches)
        ├── components.js      Header/footer/mini-cart/bottom-nav/saree-finder/back-to-top, injected everywhere
        └── guard.js           Redirects to login on pages that require an account
```

## Running it

You need [Node.js](https://nodejs.org) 18+ installed.

```bash
cd backend
npm install
cp .env.example .env      # then edit .env and set a real JWT_SECRET
npm start
```

Open **http://localhost:5000** — the Express server serves both the API
(`/api/...`) and the static frontend from the same origin, so there's no CORS
setup to worry about.

For auto-restart on file changes during development:

```bash
npm run dev
```

## How the pieces fit together

- **Auth**: `POST /api/auth/register` and `/api/auth/login` return a JWT.
  The frontend stores it in `localStorage` (`zaree_token`) and sends it as
  `Authorization: Bearer <token>` on every request that needs it.
- **Database**: `backend/data/zaree.db` is a real SQLite file (via
  `better-sqlite3`), not a flat JSON blob — it handles concurrent writes
  safely. On first run it's created and seeded from `products.json` plus a
  starter set of coupon codes (`WELCOME10`, `PADMORA40`, `FEST500`).
- **Products** carry an honest provenance record — `weaverName`,
  `weaverRegion`, and `loomType` (Handloom / Powerloom / Handcrafted) — shown
  on the product page as a "Loom-to-You" authenticity card, and a live
  `stock` count that decrements on order and restocks on cancellation.
- **Coupons**: applied server-side and re-validated at checkout (never
  trusted from the client), stored per-user in `cart_meta` so they persist
  across the cart → checkout flow.
- **Reviews**: any logged-in user can review a product; purchases are
  cross-checked against `order_items` to award a "Verified Purchase" badge.
  Displayed ratings are a weighted blend of the original seed rating and
  real submitted reviews, so one new review doesn't swing an established
  average overnight.
- **Order tracking**: there's no real courier integration, so status
  (Confirmed → Packed → Shipped → Out for Delivery → Delivered) is derived
  from elapsed time since the order was placed (see `utils/orderStatus.js`).
  Orders can be self-cancelled from Account → Order History while still
  Confirmed/Packed, which restocks the items.
- **Checkout** supports an optional gift note, applies any active coupon,
  decrements stock, and empties the cart — visible afterwards on the
  **Account → Order History** tab.
- Pages that require an account (`cart.html`, `wishlist.html`,
  `account.html`, `checkout.html`) call `requireLogin()` from `js/guard.js`.
- **Admin dashboard** (`admin.html`) is seeded automatically on first boot —
  log in with the email/password from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in
  `.env` (defaults: `admin@padmora.store` / `ChangeMe123!` — **change these**
  before deploying anywhere real). All `/api/admin/*` routes require
  `is_admin = 1` on the logged-in user, enforced by `requireAdmin` middleware.
  It's not linked from the public nav/footer — only reachable by URL.
- **Sarees ship unstitched only** — no blouse-stitching add-on, by design.
  Keep it that way if re-adding features later; it was deliberately removed
  from checkout, the product page, and the account measurements panel.

## Usability layer (guest shopping, mini-cart, mobile nav, saree finder)

- **Guest cart & wishlist**: visitors can add to bag/wishlist without an
  account — items live in `localStorage` (see `getGuestCart`/`getGuestWishlist`
  in `js/api.js`). `cartGet()`/`cartAdd()`/`wishlistAdd()` etc. are the single
  entry points every page uses; they transparently switch between the guest
  (client-computed) and logged-in (server) cart based on `isLoggedIn()`. Login
  is still required at checkout — `mergeGuestDataIntoAccount()` runs right
  after login/register and folds the guest cart/wishlist/coupon into the
  account via `POST /api/cart/merge` and `POST /api/wishlist/merge`.
- **Mini-cart drawer**: clicking the header cart icon opens a slide-out
  preview (`initMiniCart()` in `components.js`) instead of navigating away —
  full page navigation still happens if you're already on `cart.html`.
- **Mobile bottom nav**: a fixed tab bar (Home/Shop/Wishlist/Bag/Account)
  appears below 760px screens, with live badge counts.
- **Saree Finder**: a floating button (bottom-right, all pages) opens a
  3-question quiz (occasion → budget → fabric) and recommends real products
  via the existing `/api/products` filters — see `initSareeFinder()` in
  `components.js`.
- **Saved addresses**: up to 5 per user (`/api/addresses`), selectable at
  checkout with one click, manageable from Account → Addresses.
- **Instant search**: a header search icon opens a debounced (250ms)
  live-results dropdown as you type — see `initSearchOverlay()` in
  `components.js`. Matching is forgiving on purpose: `GET /api/products?search=`
  splits the query into words and OR-matches each against name/fabric/occasion
  server-side, so a partial query like "red saree" still surfaces "Madder Red
  Ajrakh Cotton" even though no product is literally named "saree".
- Smaller polish: show/hide password + strength meter on register, inline
  email validation, a sticky mobile "Add to Bag" bar on the product page,
  and a global back-to-top button.

## Animated order tracker (`track-order.html`)

- A horizontal (vertical on mobile) progress path through Confirmed → Packed
  → Shipped → Out for Delivery → Delivered, each stage timestamped from
  `order.timeline` (now includes an `at` field per stage — see
  `buildTimeline()` in `backend/utils/orderStatus.js`).
- The current stage pulses (a radar-ping ring), completed connectors carry a
  continuous shimmer sweep, and a "Live tracking" badge pulses independently
  of the data — it's designed to always feel alive, not just when the status
  actually changes.
- Polls the order every 20s (`setInterval` in `track-order.html`) so a
  tab left open picks up admin-driven status changes without a refresh.
- A confetti burst fires once when an order reaches Delivered.
- No order ID handy? The page auto-loads your most recent order, or shows
  clickable chips for your last 6 orders.
- Reachable from Account → Order History ("Track Order →" on each order),
  the footer's "Track Order" link, or directly via `track-order.html?id=ZR12345`.

## Product & business strategy notes

The differentiators baked into this build target the biggest trust gap in
online saree retail — power-loom silk sold as handloom, and color/fit
uncertainty on a category people usually buy in person:

- **Loom-to-You authenticity card** on every product page (weaver, region,
  honest loom-type disclosure) — see `our-weaves.html` for the full explainer.
- **Scarcity messaging that's actually true** — low-stock handloom pieces
  (e.g. the Wine Gold Paithani, which only has 4 in stock) read as genuinely
  rare, not manufactured urgency.
- **Gifting-first checkout** — an optional gift note, and messaging that
  leans into sarees being a rare gift category where you don't need to know
  the recipient's size.
- **Verified-purchase reviews** rather than static seed ratings.
- **"Sarees in Motion" reel carousel** on the homepage — a scrollable rail of
  short vertical clips, each linking straight to that saree's product page.
  There's no real footage yet, so cards fall back to an animated gradient
  placeholder (see `.reel-placeholder` in `index.html`). To go live: drop an
  `.mp4` per saree somewhere under `frontend/` (e.g. `frontend/media/reels/1.mp4`)
  and set that product's `reel_video` column in `backend/data/zaree.db` to
  the relative path — the card will automatically switch to a real
  `<video>` element instead of the placeholder. Curated picks live in
  `REEL_PRODUCT_IDS` in `backend/utils/db.js`.
- **Order tracking timeline** and self-service cancellation, which most
  small D2C saree sellers on Instagram/WhatsApp cannot offer at all.
- **A deliberately narrow catalog** — Maheshwari, Ajrakh, Paithani, and
  Narayanpet only, framed as founder Yashi and team personally verifying each
  craft's artisans before it's added, rather than an unlimited drop-shipped catalog.
  New crafts should be added to `WEAVER_INFO` in `backend/utils/db.js` (with
  authentic weaver/region/loom-type data) and to `backend/data/products.json`
  — the frontend's fabric filters, category rail, and Saree Finder all read
  from live product data, so no other file needs to change.

## Notes for going to production

- Integrate a real payment gateway (Razorpay is standard for Indian D2C —
  supports UPI/cards/COD/EMI) instead of the mock payment step.
- Change the default admin credentials (`ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env`)
  before deploying anywhere real.
- Add input validation/sanitization and rate limiting on the API.
- Add email/SMS notifications for order confirmation and status changes.
- Set a strong, secret `JWT_SECRET` and serve everything over HTTPS.
- Back up `backend/data/zaree.db` regularly, or migrate to a hosted
  Postgres/MySQL instance for multi-instance deployments.
