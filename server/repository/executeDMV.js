'use strict'

function quoteName(name) {
  return `[${name.replace(/]/g, ']]')}]`
}

async function executeDMV(pool, db, sqlBody) {
  const result = await pool.request().query(`
    USE ${quoteName(db)};
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
    SET LOCK_TIMEOUT 5000;
    ${sqlBody}
  `)
  const sets = result.recordsets
  return (sets && sets.length > 0) ? sets[sets.length - 1] : result.recordset
}

module.exports = { executeDMV, quoteName }
