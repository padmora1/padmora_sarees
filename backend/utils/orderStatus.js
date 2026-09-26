// Simulates fulfillment progress from elapsed time since the order was placed
// (there's no real warehouse/courier integration behind this demo store).
// The stage order is fixed, but how many hours each stage takes is admin-
// configurable (Settings → Tracking) and read fresh on every call, so a
// timing change takes effect immediately without a server restart.
const { getSetting, supabase, must } = require('./db');

const STAGE_NAMES = ['Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered'];
const DEFAULT_TIMING = { Confirmed: 0, Packed: 1, Shipped: 24, 'Out for Delivery': 72, Delivered: 120 };

async function getStages() {
  const timing = await getSetting('tracking_timing', DEFAULT_TIMING);
  return STAGE_NAMES.map(status => ({ status, afterHours: Number(timing[status] ?? DEFAULT_TIMING[status]) }));
}

async function computeStatus(order) {
  if (order.cancelled_at) return 'Cancelled';
  let current;
  // An admin can push an order forward (or hold it back) manually —
  // takes precedence over the time-based simulation.
  if (order.manual_status) {
    current = order.manual_status;
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
  const stages = await getStages();
  const currentStatus = await computeStatus(order);
  if (currentStatus === 'Cancelled') {
    return [{ status: 'Cancelled', done: true, at: order.cancelled_at }];
  }
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

// Shown to the customer when requesting a cancellation, and to the admin
// reviewing it. 'other' is the only key that requires a detail note.
const CANCEL_REASONS = [
  { key: 'wrong_choice', label: 'Chose the wrong color/size' },
  { key: 'changed_mind', label: 'Changed my mind' },
  { key: 'ordered_by_mistake', label: 'Ordered by mistake' },
  { key: 'found_better_price', label: 'Found a better price elsewhere' },
  { key: 'other', label: 'Other' }
];

module.exports = { computeStatus, buildTimeline, isCancellable, STAGE_NAMES, CANCEL_REASONS };
