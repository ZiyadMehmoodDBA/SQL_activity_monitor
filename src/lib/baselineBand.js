// Hour-of-week bucket math — must stay identical to server/baselineCalc.js.
const MONDAY_OFFSET_S = 4 * 86_400; // epoch was a Thursday
const WEEK_S = 7 * 86_400;

export function hourOfWeek(tsMs) {
  const s = Math.floor(tsMs / 1000);
  return Math.floor(((((s - MONDAY_OFFSET_S) % WEEK_S) + WEEK_S) % WEEK_S) / 3600);
}

export function bandData(baselineRows, timestamps) {
  const byHow = new Map((baselineRows || []).map((r) => [r.hour_of_week, r]));
  return (timestamps || []).map((ts) => {
    const b = byHow.get(hourOfWeek(ts));
    if (!b) return { x: ts, y: null };
    return { x: ts, y: [Math.max(0, b.mean - 2 * b.stddev), b.mean + 2 * b.stddev] };
  });
}
