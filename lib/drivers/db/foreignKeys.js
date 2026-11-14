// Foreign keys between the tables of one schema, as every SQL driver's
// listForeignKeys returns them — what the BI dataset canvas joins two tables
// on without asking. One entry per constraint, its columns in key order (a
// composite key keeps every pair): { name, table, columns, refTable,
// refColumns }. Each driver reads its own catalogue one row per column pair
// and hands the rows here; only keys whose BOTH tables are in the schema
// listTables lists, so every name is one listTables also returns.

/** Rows of { name, table, refTable, column, refColumn }, in key order → one entry per key. */
function group(rows) {
  var byKey = {};
  var out = [];
  (rows || []).forEach(function(r) {
    var key = r.table + '\u0000' + r.name;
    var fk = byKey[key];
    if (!fk) {
      fk = byKey[key] = { name: r.name, table: r.table, columns: [], refTable: r.refTable, refColumns: [] };
      out.push(fk);
    }
    fk.columns.push(r.column);
    fk.refColumns.push(r.refColumn);
  });
  return out;
}

module.exports = { group: group };
