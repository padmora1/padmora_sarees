// A saree can suit several occasions. They are kept in the product's one `occasion` text column, comma separated
// ("Wedding, Festive"), so a saree with a single occasion looks exactly as it always did.
const MAX_OCCASIONS = 8;

// "Wedding, Festive" -> ['Wedding', 'Festive'] (blank-safe, no repeats).
function splitOccasions(value) {
  const seen = new Set();
  return String(value == null ? '' : value).split(',').map(s => s.trim()).filter(s => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}

// Accepts the list the admin page sends (or a single string) and returns the text to store, or null when it is
// empty / too long / has too many occasions.
function normalizeOccasions(input) {
  const list = Array.isArray(input) ? input.flatMap(splitOccasions) : splitOccasions(input);
  const unique = [...new Map(list.map(o => [o.toLowerCase(), o])).values()];
  if (!unique.length || unique.length > MAX_OCCASIONS || unique.some(o => o.length > 80)) return null;
  return unique.join(', ');
}

module.exports = { splitOccasions, normalizeOccasions, MAX_OCCASIONS };
