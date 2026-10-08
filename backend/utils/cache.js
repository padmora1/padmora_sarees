// A small in-memory "stale-while-revalidate" cache for the data every page needs (the catalogue, collections, fabrics, the
// footer, the home page...). Without it each page view re-read the whole catalogue from the remote database (several round
// trips, hundreds of milliseconds) just to draw a menu.
//
//   - fresh (default 5 s): served straight from memory;
//   - older, but not too old (default 15 s): served from memory at once AND refreshed in the background, so nobody waits;
//   - first request, or a failed/very old entry: waits for one load (concurrent requests share it - never a stampede);
//   - if a refresh fails, the last good copy keeps being served rather than an error page.
// invalidateAll() empties every cache at once: the admin calls it after any change and checkout after an order, so a change
// made through THIS server shows immediately; a change made by the other app (admin and storefront are separate processes)
// shows within `fresh` seconds.
const registry = new Set();

function swr(load, { fresh = 5000, stale = 15000, maxKeys = 300 } = {}) {
  const entries = new Map();   // key -> { value, at, loading, gen }
  let generation = 0;
  const cache = { invalidate() { generation++; entries.clear(); } };
  registry.add(cache);

  function refresh(key, args) {
    let e = entries.get(key);
    if (!e) { e = { value: undefined, has: false, at: 0, loading: null, gen: generation }; entries.set(key, e); if (entries.size > maxKeys) entries.delete(entries.keys().next().value); }
    if (e.loading) return e.loading;
    const gen = generation;
    e.loading = Promise.resolve().then(() => load(...args)).then(value => {
      if (gen === generation) { e.value = value; e.has = true; e.at = Date.now(); }
      return value;
    }).finally(() => { e.loading = null; });
    return e.loading;
  }

  // get(key?, ...args): key picks the cached copy (omit it for a single value); extra args go to load().
  function get(key = '', ...args) {
    const k = String(key);
    const e = entries.get(k);
    if (e && e.has) {
      const age = Date.now() - e.at;
      if (age < fresh) return Promise.resolve(e.value);
      if (age < stale) { refresh(k, [key, ...args]).catch(() => {}); return Promise.resolve(e.value); }
    }
    return refresh(k, [key, ...args]).catch(err => { if (e && e.has) return e.value; throw err; });
  }
  get.invalidate = cache.invalidate;
  return get;
}

// Other small caches (settings, a product's share-preview text...) register here to be emptied together with everything else.
const hooks = new Set();
function onInvalidate(fn) { hooks.add(fn); }

function invalidateAll() {
  registry.forEach(c => c.invalidate());
  hooks.forEach(fn => { try { fn(); } catch (e) { /* a hook must never stop the rest */ } });
}

module.exports = { swr, invalidateAll, onInvalidate };
