// Storefront footer content (tagline, link columns, bottom line) — edited in Admin → Settings → Footer.
// Contact email and social links stay in Store Info; this holds everything else the footer shows.
const DEFAULT_FOOTER = {
  tagline: 'Bringing handloom weavers and heritage crafts directly to your wardrobe — one drape at a time.',
  columns: [
    { title: 'Customer Care', links: [
      { label: 'Track Order', url: '/track-order' },
      { label: 'Policies', url: '/policies' },
      { label: 'FAQ', url: '/faq' },
      { label: 'Contact Us', url: '/contact' }
    ] },
    { title: 'Company', links: [
      { label: 'About Padmora', url: '/about' }
    ] }
  ],
  bottomLeft: '© 2026 Padmora. All rights reserved.',
  bottomRight: 'Made with care for handloom weavers across India.'
};

const MAX_COLUMNS = 4;
const MAX_LINKS = 10;
const SAFE_URL = /^(\/(?!\/)[^\s<>"']*|https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|tel:[+0-9\-\s()]+)$/i;

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, max);
}

// Returns { value } with a tidy config, or { error } with a message an admin can act on.
function validateFooter(input) {
  const body = input || {};
  const columnsIn = Array.isArray(body.columns) ? body.columns : [];
  if (columnsIn.length > MAX_COLUMNS) return { error: `Use at most ${MAX_COLUMNS} link columns.` };
  const columns = [];
  for (const col of columnsIn) {
    const title = clean(col && col.title, 40);
    const linksIn = Array.isArray(col && col.links) ? col.links : [];
    if (linksIn.length > MAX_LINKS) return { error: `A column can have at most ${MAX_LINKS} links.` };
    const links = [];
    for (const l of linksIn) {
      const label = clean(l && l.label, 40);
      const url = clean(l && l.url, 300);
      if (!label && !url) continue; // a blank row is just ignored
      if (!label) return { error: 'Every footer link needs a name.' };
      if (!SAFE_URL.test(url)) return { error: `"${label}": the link must start with / (a page on this site), https://, mailto: or tel:.` };
      links.push({ label, url });
    }
    if (!title && !links.length) continue;
    if (!title) return { error: 'Every footer column needs a heading.' };
    columns.push({ title, links });
  }
  return { value: {
    tagline: clean(body.tagline, 240),
    columns,
    bottomLeft: clean(body.bottomLeft, 120),
    bottomRight: clean(body.bottomRight, 120)
  } };
}

module.exports = { DEFAULT_FOOTER, validateFooter };
