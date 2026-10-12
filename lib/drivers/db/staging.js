// A STAGED REPLACE on the server databases (Postgres, MySQL, SQL Server).
//
// An import that replaces a table must never leave it empty because the
// import failed. So the rows are written to `<target>__xeplr_staging` while
// the import runs, and only when every one is in does ONE transaction empty
// the target and move them across. Stopped, failed or killed before that:
// the target is exactly as it was, and the staging table is all there is to
// drop (the next load drops a leftover one anyway).
//
// The staging table is shaped like the target, with its NOT NULL and (where
// the dialect copies them) CHECK constraints — so a row the target would
// refuse is refused while it is staged, one row at a time, and recorded in
// `<target>_import_errors` like any other, rather than failing the move.
//
// Each driver supplies only what differs: how to make the staging table and
// how to run statements in one transaction. DuckDB keeps its own (it also
// upserts and replaces ranges there — see its "staged loads" section).

var SUFFIX = '__xeplr_staging';
var MOVEMENT_COL = '__xeplr_movement_id__';

function stagingTableFor(tableName) { return tableName + SUFFIX; }

/**
 * @param {object} dialect - { name, quoteIdent, query(pool, sql), createStagingSql(target, staging) → string[],
 *                             transaction(pool, fn(run)) where run(sql) → rows affected }
 */
function stagingFor(dialect) {
  var q = dialect.quoteIdent;

  async function prepareStaging(pool, tableName) {
    var staging = stagingTableFor(tableName);
    await dropStaging(pool, tableName);
    var sqls = dialect.createStagingSql(q(tableName), q(staging));
    for (var i = 0; i < sqls.length; i++) await dialect.query(pool, sqls[i]);
    return staging;
  }

  async function dropStaging(pool, tableName) {
    await dialect.query(pool, dialect.dropTableSql(q(stagingTableFor(tableName))));
  }

  /**
   * Replace the target's rows with the staged ones, in one transaction, then
   * drop the staging table. Only a whole-table replace: upserts and range
   * replaces are staged on DuckDB alone.
   *
   * @returns {{ inserted, replaced }} replaced: the rows the target held before
   */
  async function mergeStaged(pool, opts) {
    if (!opts.replaceAll || (opts.primaryKeys && opts.primaryKeys.length) || opts.replaceFrom) {
      throw new Error(dialect.name + ': a staged load replaces the whole table here — upserts and range replaces are not staged on this database');
    }
    var target = q(opts.targetTable);
    var staging = q(stagingTableFor(opts.targetTable));
    var cols = [MOVEMENT_COL].concat(opts.columns.map(function(c) { return c.name; })).map(q).join(', ');
    var counts = await dialect.transaction(pool, async function(run) {
      var replaced = await run('DELETE FROM ' + target);
      var inserted = await run('INSERT INTO ' + target + ' (' + cols + ') SELECT ' + cols + ' FROM ' + staging);
      return { inserted: inserted, replaced: replaced };
    });
    // After the commit, and allowed to fail: the rows have landed.
    await dropStaging(pool, opts.targetTable).catch(function() {});
    return counts;
  }

  return { prepareStaging: prepareStaging, dropStaging: dropStaging, mergeStaged: mergeStaged };
}

module.exports = { stagingFor: stagingFor, stagingTableFor: stagingTableFor, SUFFIX: SUFFIX };
