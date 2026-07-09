'use strict';

const { CORE_KPIS } = require('./alertConfig');

function parseKpi(q) {
  return CORE_KPIS.includes(q) ? q : null;
}

function parseAlertId(param) {
  if (param === '' || param == null) return null;
  const n = Number(param);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = { parseKpi, parseAlertId };
