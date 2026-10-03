// Order tracking has two modes (Admin → Settings → Tracking):
//
//  • manual (the live store): an order is "Confirmed" the moment it's placed and
//    only moves forward when the admin marks it — one at a time from the order
//    list, or in bulk by uploading a sheet of order IDs (Orders → Bulk update
//    status). Each real change is stored in order_status_events so customers
//    see the actual time, not a guess.
//  • simulated (the old demo behaviour): progress is derived from elapsed time
//    since the order was placed. The stage order is fixed, but how many hours
//    each stage takes is admin-configurable and read fresh on every call.
//
// Switching to manual stamps a `since` time; orders placed before it keep the
// simulated behaviour so existing orders don't suddenly jump backwards.
const { getSetting, supabase, must } = require('./db');

const STAGE_NAMES = ['Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered'];
const DEFAULT_TIMING = { Confirmed: 0, Packed: 1, Shipped: 24, 'Out for Delivery': 72, Delivered: 120 };

async function getStages() {
  const timing = await getSetting('tracking_timing', DEFAULT_TIMING);
  return STAGE_NAMES.map(status => ({ status, afterHours: Number(timing[status] ?? DEFAULT_TIMING[status]) }));
}

// Read on every computeStatus call (the admin list computes one per order), so
// it's cached for a few seconds; saving the setting clears the cache at once.
let trackingModeCache = null;
function clearTrackingModeCache() { trackingModeCache = null; }
async function getTrackingMode() {
  if (trackingModeCache && Date.now() - trackingModeCache.at < 5000) return trackingModeCache.value;
  const cfg = await getSetting('tracking_mode', {});
  const since = cfg.since ? new Date(cfg.since).getTime() : 0;
  const value = { mode: cfg.mode === 'manual' ? 'manual' : 'simulated', since: Number.isFinite(since) ? since : 0 };
  trackingModeCache = { at: Date.now(), value };
  return value;
}

async function isManualOrder(order) {
  const { mode, since } = await getTrackingMode();
  return mode === 'manual' && new Date(order.placed_at).getTime() >= since;
}

async function computeStatus(order) {
  if (order.cancelled_at) return 'Cancelled';
  let current;
  // An admin can push an order forward (or hold it back) manually —
  // takes precedence over the time-based simulation.
  if (order.manual_status) {
    current = order.manual_status;
  } else if (await isManualOrder(order)) {
    current = 'Confirmed';
  } else {
    const stages = await getStages();
    const hoursElapsed = (Date.now() - new Date(order.placed_at).getTime()) / 36e5;
    current = stages[0].status;
    for (const stage of stages) {
      if (hoursElapsed >= stage.afterHours) current = stage.status;
    }
  }
  // The first moment any caller observes Delivered — whether via the time
  // simulation crossing its threshold or an admin's manual override — record
  // it durably. Nothing else derives "how long has this been delivered"
  // (the post-delivery return window, most importantly) from anything but
  // this real timestamp, never a recomputed guess.
  if (current === 'Delivered' && !order.delivered_at) {
    const now = new Date().toISOString();
    must(await supabase.from('orders').update({ delivered_at: now }).eq('id', order.id).is('delivered_at', null), 'computeStatus:stampDelivered');
    order.delivered_at = now;
  }
  return current;
}

async function buildTimeline(order) {
  const currentStatus = await computeStatus(order);
  if (currentStatus === 'Cancelled') {
    return [{ status: 'Cancelled', done: true, at: order.cancelled_at }];
  }
  if (await isManualOrder(order)) {
    // Real timestamps only: a stage that hasn't happened has no time (no "expected by"),
    // and a completed stage the admin skipped over (marked Shipped without Packed) has none either.
    const events = must(await supabase.from('order_status_events').select('status, created_at').eq('order_id', order.id).order('created_at', { ascending: true }), 'buildTimeline:events');
    const latest = {};
    events.forEach(e => { latest[e.status] = e.created_at; });
    const idx = STAGE_NAMES.indexOf(currentStatus);
    return STAGE_NAMES.map((status, i) => ({
      status,
      done: i <= idx,
      at: status === 'Confirmed' ? order.placed_at : (i <= idx ? (latest[status] || null) : null)
    }));
  }
  const stages = await getStages();
  const currentIndex = stages.findIndex(s => s.status === currentStatus);
  const placedAt = new Date(order.placed_at).getTime();
  return stages.map((stage, i) => ({
    status: stage.status,
    done: i <= currentIndex,
    // Reached/expected timestamp for this stage, purely for display —
    // matches how long the simulation says each stage takes.
    at: new Date(placedAt + stage.afterHours * 36e5).toISOString()
  }));
}

async function isCancellable(order) {
  const status = await computeStatus(order);
  return status === 'Confirmed' || status === 'Packed';
}

// Moves an order to `status` (a STAGE_NAMES entry), or back to automatic when
// status is null, and records the real time it happened. Used by both the
// single-order dropdown and the bulk upload so they can't drift apart.
async function setOrderManualStatus(order, status, source) {
  const previous = await computeStatus(order);
  const now = new Date().toISOString();
  const patch = { manual_status: status || null };
  if (status === 'Delivered' && !order.delivered_at) patch.delivered_at = now;
  must(await supabase.from('orders').update(patch).eq('id', order.id), 'setOrderManualStatus:update');
  if (status && status !== previous) {
    must(await supabase.from('order_status_events').insert({ order_id: order.id, status, source: source || 'manual' }), 'setOrderManualStatus:event');
  }
  return { previous, advanced: !!status && STAGE_NAMES.indexOf(status) > STAGE_NAMES.indexOf(previous) };
}

// Shown to the customer when requesting a cancellation, and to the admin
// reviewing it. 'other' is the only key that requires a detail note.
const CANCEL_REASONS = [
  { key: 'wrong_choice', label: 'Chose the wrong colour' },
  { key: 'changed_mind', label: 'Changed my mind' },
  { key: 'ordered_by_mistake', label: 'Ordered by mistake' },
  { key: 'found_better_price', label: 'Found a better price elsewhere' },
  { key: 'other', label: 'Other' }
];

module.exports = { computeStatus, buildTimeline, isCancellable, isManualOrder, getTrackingMode, clearTrackingModeCache, setOrderManualStatus, STAGE_NAMES, CANCEL_REASONS };
