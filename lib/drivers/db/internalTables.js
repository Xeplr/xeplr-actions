// THE TABLES THE UPLOADER MAKES FOR ITSELF, beside the tables it loads:
//
//   <table>_import_errors    rows the database refused (errorRows.js)
//   <table>__xeplr_staging   a staged load's rows until they move in (staging.js, duckdb.js)
//   __xeplr_loads            a DuckDB file's ledger of staged loads (duckdb.js)
//
// They are the uploader's bookkeeping, not data anybody models: an app that
// lists a database's tables for people to pick from (a dataset builder, a
// cube's source picker) leaves them out with isInternalTable(). They still
// exist and are read where they belong (an import's dropped rows).

var ERRORS_SUFFIX = '_import_errors';
var STAGING_SUFFIX = require('./staging').SUFFIX;
var LOADS_LEDGER = '__xeplr_loads';

function endsWith(s, suffix) {
  return s.length > suffix.length && s.slice(-suffix.length) === suffix;
}

/** Whether a table is one the uploader made for itself. Case as the database reports it. */
function isInternalTable(name) {
  var s = String(name == null ? '' : (typeof name === 'object' ? name.name || name.table || '' : name));
  return endsWith(s, ERRORS_SUFFIX) || endsWith(s, STAGING_SUFFIX) || s === LOADS_LEDGER;
}

module.exports = {
  isInternalTable: isInternalTable,
  ERRORS_SUFFIX: ERRORS_SUFFIX,
  STAGING_SUFFIX: STAGING_SUFFIX,
  LOADS_LEDGER: LOADS_LEDGER
};
