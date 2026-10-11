// ROWS THE DATABASE REFUSED, written to `<table>_import_errors`.
//
// Every dialect creates that table (buildCreateErrorTableSql) with the same
// columns; only the quoting and the bind marks differ. So the statement is
// built once, here, and each driver passes its own quoteIdent and mark.

var COLUMNS = ['movement_id', 'row_num', 'error_description', 'underlying_sql', 'raw_row'];

/**
 * One INSERT for several refused rows.
 *
 * @param {function} quoteIdent  the driver's identifier quoting
 * @param {function} mark        bind mark for param n (0-based): '?', '$1', '@p0'
 * @param {string}   tableName   the TARGET table — the error table is named from it
 * @param {string}   movementId
 * @param {Array<{rowNum, error, sql, row}>} entries
 * @returns {{ sql: string, params: any[] }}
 */
function buildInsertErrorRowsSql(quoteIdent, mark, tableName, movementId, entries) {
  var params = [];
  var groups = entries.map(function(e) {
    var marks = [];
    [movementId, e.rowNum == null ? null : e.rowNum, e.error || null, e.sql || null,
      e.row == null ? null : JSON.stringify(e.row)].forEach(function(v) {
      marks.push(mark(params.length));
      params.push(v);
    });
    return '(' + marks.join(', ') + ')';
  });
  return {
    sql: 'INSERT INTO ' + quoteIdent(tableName + '_import_errors') +
      ' (' + COLUMNS.map(quoteIdent).join(', ') + ') VALUES ' + groups.join(', '),
    params: params
  };
}

module.exports = { buildInsertErrorRowsSql: buildInsertErrorRowsSql };
