// Lets every running copy of the server learn at once that something changed.
//
// The shop keeps its data in memory (utils/cache.js). A change made through one copy of the server empties THAT copy's memory
// straight away, but a host may run several copies (workers, or the admin and the shop apart), and the others would keep showing
// the old data until their memory aged out. So every change also stamps a small "data version" row in the database, and every copy
// looks at that row every few seconds: when it has moved, the copy empties its own memory. A change made in the admin therefore
// reaches every shopper within a few seconds, wherever their request lands.
//
// One tiny read per copy every few seconds; if the database cannot be reached the copy just carries on with its normal short
// expiry (nothing here can break a request).
const { supabase } = require('./db');
const { invalidateAll } = require('./cache');

const KEY = 'data_version';
let known = null;       // the version this copy has already acted on
let bumpTimer = null;
let pollTimer = null;

// Called after any change that shoppers can see. Several changes in a row (saving a product is many requests) become one stamp.
function bump() {
  clearTimeout(bumpTimer);
  bumpTimer = setTimeout(async () => {
    const v = Date.now() + '-' + process.pid;
    known = v;   // this copy has already emptied its own memory
    try { await supabase.from('settings').upsert({ key: KEY, value: v }, { onConflict: 'key' }); }
    catch (e) { console.error('[dataVersion] could not stamp the change:', e.message); }
  }, 250);
}

async function poll() {
  try {
    const r = await supabase.from('settings').select('value').eq('key', KEY).maybeSingle();
    if (r.error) return;
    const v = r.data ? r.data.value : null;
    if (known === null) { known = v; return; }
    if (v !== known) { known = v; invalidateAll(); }   // another copy changed something
  } catch (e) { /* try again next time */ }
}

function start(intervalMs) {
  const ms = intervalMs === undefined ? Number(process.env.DATA_VERSION_POLL_MS || 2000) : intervalMs;
  if (!ms || pollTimer) return;
  poll();
  pollTimer = setInterval(poll, ms);
  if (pollTimer.unref) pollTimer.unref();
}

module.exports = { bump, start, poll };
