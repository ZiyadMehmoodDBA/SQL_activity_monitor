'use strict';

// Per-KPI evaluation config. A future `kpi_config` table can replace this
// object without restructuring the evaluator (spec: designed-for extension).
const KPI_ALERT_CONFIG = {
  cpu_pct:            { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 5 },
  waiting_tasks:      { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 2 },
  io_mb:              { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 5 },
  batch_req:          { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 10 },
  ple_sec:            { direction: 'below', sigmaOpen: 3, sigmaClose: 2, minStddev: 100 },
  mem_grants_pending: { direction: 'above', sigmaOpen: 3, sigmaClose: 2, minStddev: 1 },
};

const CORE_KPIS = Object.keys(KPI_ALERT_CONFIG);

module.exports = { KPI_ALERT_CONFIG, CORE_KPIS };
