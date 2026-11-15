// The columns a database source DECLARES — shared by db-move and db-fetch, so
// both carry a table's own types instead of guessing them from values.

function normalizeMapping(columns) {
  return (columns || [])
    .filter(function(c) { return c && c.from; })
    .map(function(c) { return { from: c.from, to: c.to || c.from }; });
}

/**
 * The source's DECLARED column types, in the target's names — or null when the
 * source has none to declare.
 *
 * Inference reads values, and for a database source that is throwing away an
 * answer the server already holds. Three ways it goes wrong, all of them quiet
 * and all of them baked into a CREATE TABLE that outlives the sample:
 *
 *   Postgres returns `numeric` to node as a STRING. A money column arrives as
 *   strings, infers as text, and the target column is created TEXT. You find
 *   out when somebody tries to SUM it.
 *
 *   A column that is all-null in the first batch has no type, so it becomes
 *   text — and stays text once the table exists.
 *
 *   A zero-padded code ('007') looks like a number and loses its zeros.
 *
 * Only for mode 'table': a query or a procedure has no single table to
 * describe. Both dialects CAN describe a result set — Postgres by preparing,
 * SQL Server via sp_describe_first_result_set — but that is a per-driver
 * capability that does not exist yet, so those fall back to inference and the
 * caveat above still applies to them.
 */
async function declaredColumns(driver, pool, input) {
  var mode = input.mode || (input.table ? 'table' : 'query');
  if (mode !== 'table' || !input.table) return null;
  if (typeof driver.getTableSchema !== 'function' || typeof driver.dataTypeToLogical !== 'function') return null;

  var schema = await driver.getTableSchema(pool, input.table);
  if (!schema || !schema.length) return null;

  var byName = {};
  schema.forEach(function(c) { byName[c.name] = c; });

  var mapping = normalizeMapping(input.columns);
  // No mapping means every source column, unrenamed — so the declaration is
  // the source's own schema in its own order.
  var wanted = mapping.length
    ? mapping
    : schema.map(function(c) { return { from: c.name, to: c.name }; });

  var out = [];
  for (var i = 0; i < wanted.length; i++) {
    var src = byName[wanted[i].from];
    // A mapped column the source does not have is left out rather than
    // guessed at — the SELECT will fail on it anyway, with a better message
    // than anything invented here.
    if (!src) return null;
    out.push({ name: wanted[i].to, type: driver.dataTypeToLogical(src.dataType) });
  }
  return out.length ? out : null;
}

module.exports = { declaredColumns: declaredColumns, normalizeMapping: normalizeMapping };
