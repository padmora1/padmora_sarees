// Editable bits of the storefront home: the thin announcement bar at the very top of every page, and the
// "Shop by Weave" section under the hero. Edited in Admin → Storefront; defaults match what the site showed
// before they were editable, so nothing changes until an admin saves.
const DEFAULT_ANNOUNCEMENT = {
  enabled: true,
  // {freeShipping} is replaced on the storefront with the real free-shipping amount from Settings → Shipping,
  // so the bar can never quote a number that checkout does not honour.
  text: 'Free shipping above {freeShipping} · Easy 7-day returns · Secure payments via Razorpay',
  link: ''
};

const DEFAULT_WEAVE_SECTION = {
  enabled: true,
  eyebrow: '',
  title: 'Shop by Weave',
  subtitle: '',
  hiddenFabricIds: [],
  order: []
};

const SAFE_LINK = /^(\/(?!\/)[^\s<>"']*|https?:\/\/[^\s<>"']+)$/i;

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, max);
}

function cleanIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    const n = Number(x);
    if (Number.isInteger(n) && n > 0 && n <= 2147483647 && !out.includes(n)) out.push(n);
    if (out.length >= 100) break;
  }
  return out;
}

function validateAnnouncement(input) {
  const b = input || {};
  const text = clean(b.text, 200);
  const link = clean(b.link, 300);
  const enabled = b.enabled !== false && b.enabled !== 'false' && b.enabled !== 0;
  if (enabled && !text) return { error: 'Write the announcement text, or switch the bar off.' };
  if (link && !SAFE_LINK.test(link)) return { error: 'The link must start with / (a page on this site) or https://.' };
  return { value: { enabled, text: text || DEFAULT_ANNOUNCEMENT.text, link } };
}

function validateWeaveSection(input) {
  const b = input || {};
  const title = clean(b.title, 80);
  const enabled = b.enabled !== false && b.enabled !== 'false' && b.enabled !== 0;
  if (enabled && !title) return { error: 'The section needs a heading, or switch the section off.' };
  return { value: {
    enabled,
    eyebrow: clean(b.eyebrow, 60),
    title: title || DEFAULT_WEAVE_SECTION.title,
    subtitle: clean(b.subtitle, 200),
    hiddenFabricIds: cleanIds(b.hiddenFabricIds),
    order: cleanIds(b.order)
  } };
}

module.exports = { DEFAULT_ANNOUNCEMENT, DEFAULT_WEAVE_SECTION, validateAnnouncement, validateWeaveSection };
