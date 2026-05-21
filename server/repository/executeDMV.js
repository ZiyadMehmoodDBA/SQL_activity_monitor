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
  return result.recordset
}

module.exports = { executeDMV, quoteName }
