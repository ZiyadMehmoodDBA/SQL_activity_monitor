'use strict';

const VALID_RESOLUTIONS = ['auto', 'raw', '1m', '15m', '1h'];

function toInt(v) {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function parseHistoryRange(query, now = Date.now()) {
  const to = query.to !== undefined ? toInt(query.to) : now;
  if (to === null || to <= 0) return null;
  const from = query.from !== undefined ? toInt(query.from) : to - 3_600_000;
  if (from === null || from <= 0 || from >= to) return null;
  return { from, to };
}

module.exports = { parseHistoryRange, VALID_RESOLUTIONS };
