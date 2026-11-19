// A whole database's structure in one read — every table with its schema,
// columns, types, keys and comments, and the foreign keys between them — as
// every SQL driver's describeDatabase returns it. What an app needs to
// explain a database to someone (or to a language model) without reading any
// of its rows. Each driver reads its own catalogue in a few queries, never one
// per table, and hands the rows here:
//
//   columns     { schema, table, tableDescription, column, dataType,
//                 nullable, primaryKey, description }, in column order
//   foreign     { name, schema, table, column, refSchema, refTable,
//                 refColumn }, in key order
//
// →  { tables: [{ schema, name, description, columns: [{ name, dataType,
//                 nullable, primaryKey, description }] }],
//      foreignKeys: [{ name, schema, table, columns, refSchema, refTable,
//                 refColumns }] }
//
// An empty comment is null, so "no description" is one value whatever the
// database stores for it.

function text(value) {
  if (value == null) return null;
  var s = String(value).trim();
  return s ? s : null;
}

function flag(value) {
  return value === true || value === 1 || value === '1' || value === 'YES' || value === 't';
}

/** The rows of the two catalogue reads → { tables, foreignKeys }. */
function assemble(columnRows, foreignRows) {
  var tables = [];
  var byTable = {};
  (columnRows || []).forEach(function(r) {
    var key = r.schema + '\u0000' + r.table;
    var t = byTable[key];
    if (!t) {
      t = byTable[key] = { schema: r.schema, name: r.table, description: text(r.tableDescription), columns: [] };
      tables.push(t);
    }
    t.columns.push({
      name: r.column,
      dataType: r.dataType,
      nullable: flag(r.nullable),
      primaryKey: flag(r.primaryKey),
      description: text(r.description)
    });
  });

  var foreignKeys = [];
  var byKey = {};
  (foreignRows || []).forEach(function(r) {
    var key = r.schema + '\u0000' + r.table + '\u0000' + r.name;
    var fk = byKey[key];
    if (!fk) {
      fk = byKey[key] = { name: r.name, schema: r.schema, table: r.table, columns: [],
        refSchema: r.refSchema, refTable: r.refTable, refColumns: [] };
      foreignKeys.push(fk);
    }
    fk.columns.push(r.column);
    fk.refColumns.push(r.refColumn);
  });

  return { tables: tables, foreignKeys: foreignKeys };
}

module.exports = { assemble: assemble };
