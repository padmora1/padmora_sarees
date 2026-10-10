// The two settings that describe WHERE this copy of the shop lives.
//
// SITE_URL  the address customers use (https://padmorasarees.com). It is put into e-mails, the sitemap and robots.txt. It is easy to
//           type it without "https://" (a link without it is broken in an e-mail and a sitemap without it is rejected by Google),
//           so it is tidied here once, before anything else reads it.
// BLOCK_SEARCH_ENGINES=true  for a test copy (e.g. testit.padmorasarees.com): tells Google and others not to list it, so the test site
//           never competes with the real one. Leave it out on the real site.
function normalizeSiteUrl(raw) {
  let v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  return v.replace(/\/+$/, '');
}

function blockSearchEngines() {
  return /^(1|true|yes|on)$/i.test(String(process.env.BLOCK_SEARCH_ENGINES || '').trim());
}

// Tidies process.env.SITE_URL in place. Called first thing in server.js.
function applySiteUrl() {
  const before = process.env.SITE_URL;
  if (!before) return;
  const after = normalizeSiteUrl(before);
  if (after !== before) {
    process.env.SITE_URL = after;
    console.warn(`[config] SITE_URL was "${before}"; using "${after}" (it must start with https://)`);
  }
}

module.exports = { normalizeSiteUrl, blockSearchEngines, applySiteUrl };
