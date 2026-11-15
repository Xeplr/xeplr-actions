// Parquet writer for export-table — one .parquet file, the raw values, typed.
//
// Column names are the headers (made unique: Parquet columns need distinct
// names). Types come from the values themselves (formats/parquet.js), so a
// number stays a number and a date a date for whatever program reads it.
// The rows are held until close, in DuckDB's memory: an export is bounded.

var parquet = require('../parquet');

module.exports = {
  requires: ['@duckdb/node-api'],

  /**
   * @param {string} filePath
   * @param {object} doc - { columns: [{ header }] }
   * @returns {{ writeRow(row): Promise<boolean>, close(): Promise<{ rows, truncated }> }}
   */
  open: function(filePath, doc) {
    var seen = {};
    var names = (doc.columns || []).map(function(c, i) {
      var base = c.header == null || c.header === '' ? 'column_' + (i + 1) : String(c.header);
      var name = base;
      for (var n = 2; seen[name]; n++) name = base + ' (' + n + ')';
      seen[name] = true;
      return name;
    });
    var w = parquet.open({ file: filePath });

    return {
      writeRow: async function(row) {
        var values = row.values || [];
        var record = {};
        for (var i = 0; i < names.length; i++) record[names[i]] = values[i] === undefined ? null : values[i];
        try { await w.write(record); } catch (err) { await w.abort(); throw err; }
        return true;
      },
      close: async function() {
        try {
          var done = await w.close();
          return { rows: done.rows, truncated: false };
        } catch (err) {
          await w.abort();
          throw err;
        }
      }
    };
  }
};
