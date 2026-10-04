// Product / variant descriptions can carry simple formatting (bold, italic, underline, headings, bullet and
// numbered lists). The admin editor produces HTML, which is shown to shoppers, so it is rebuilt here from an
// allow-list: only the tags below survive, every attribute is dropped, and anything else (scripts, styles,
// links, images, event handlers) is removed. Plain text saved before this existed passes through unchanged.
const MAX_LENGTH = 8000;

// tag in -> tag out
const ALLOWED = { p: 'p', br: 'br', strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'u', h3: 'h3', h4: 'h3', ul: 'ul', ol: 'ol', li: 'li', div: 'p' };
const VOID = new Set(['br']);

function escapeText(t) {
  return t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeRich(input) {
  let s = String(input == null ? '' : input).replace(/\r\n?/g, '\n');
  // Text with no tags at all (everything written before the editor existed) is left exactly as it is.
  if (!/<\/?[a-zA-Z!]/.test(s)) return s.slice(0, MAX_LENGTH);
  // Drop whole elements whose content must never be shown, and comments.
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|iframe|object|embed|svg|math|template|noscript|textarea|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  const stack = [];
  let out = '';
  for (const part of s.split(/(<\/?[a-zA-Z][^>]*>)/)) {
    const m = part.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>$/);
    if (!m) { out += escapeText(part); continue; }
    const tag = ALLOWED[m[2].toLowerCase()];
    if (!tag) continue;
    if (VOID.has(tag)) { if (!m[1]) out += '<br>'; continue; }
    if (!m[1]) { stack.push(tag); out += `<${tag}>`; continue; }
    // closing tag: only close what is actually open, so the output is always well-formed
    const at = stack.lastIndexOf(tag);
    if (at === -1) continue;
    while (stack.length > at) out += `</${stack.pop()}>`;
  }
  while (stack.length) out += `</${stack.pop()}>`;
  // Tidy: no empty paragraphs/lists, no runs of blank lines, no leading/trailing breaks.
  out = out.replace(/<(p|li|h3|strong|em|u)>(\s|<br>)*<\/\1>/g, '').replace(/<(ul|ol)>\s*<\/\1>/g, '');
  out = out.replace(/^(\s|<br>)+|(\s|<br>)+$/g, '').replace(/\n{3,}/g, '\n\n');
  return out.slice(0, MAX_LENGTH);
}

// What the admin typed once the formatting is removed — for meta descriptions and "is it empty?" checks.
function richToPlain(html) {
  return String(html == null ? '' : html)
    .replace(/<\/(p|li|h3|ul|ol)>|<br>/g, '\n').replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n').trim();
}

module.exports = { sanitizeRich, richToPlain, MAX_LENGTH };
