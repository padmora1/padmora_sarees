// Tiny in-memory failed-attempt limiter for unauthenticated lookups (guest
// order cancellation). Counts only *failed* verifications, so a genuine
// customer who types the right email first time is never slowed down, while
// someone guessing order-ID/email combinations gets cut off quickly.
// In-memory is enough here: the app runs as a single Node process, and a
// restart only ever resets the counters, never opens anything else up.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 5000;

const buckets = new Map(); // key -> { count, resetAt }

function prune(now) {
  if (buckets.size < MAX_ENTRIES) return;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
  // Still full of live entries — drop the oldest so memory can't grow unbounded.
  while (buckets.size >= MAX_ENTRIES) buckets.delete(buckets.keys().next().value);
}

function isBlocked(key, max) {
  const b = buckets.get(key);
  if (!b) return false;
  if (b.resetAt <= Date.now()) { buckets.delete(key); return false; }
  return b.count >= max;
}

function recordFailure(key) {
  const now = Date.now();
  prune(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else b.count++;
}

module.exports = { isBlocked, recordFailure };
