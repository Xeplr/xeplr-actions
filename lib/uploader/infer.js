// Type inference from the first N rows.
//
// Precedence when a column has mixed values:
//   1. Any non-null value is an Array          → 'array'
//   2. Any non-null value is a plain object    → 'object'
//   3. All non-null values are Date instances OR ISO-parseable strings → 'datetime'
//   4. All non-null values are booleans        → 'boolean'
//   5. All non-null values are numbers         → 'number'
//   6. Anything else / all null                → 'string'
//
// Text always wins ties (per user preference: "string always wins... no complexity").

var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function inferColumnType(values) {
  var seenObject = false, seenArray = false;
  var allBool = true, sawBool = false;
  var allNum  = true, sawNum  = false;
  var allDate = true, sawDate = false;
  var allNull = true;

  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v === undefined || v === null) continue;
    allNull = false;

    if (Array.isArray(v))                                    { seenArray = true;  allBool = allNum = allDate = false; continue; }
    if (v instanceof Date)                                   { sawDate = true; allBool = allNum = false; continue; }
    if (typeof v === 'boolean')                              { sawBool = true; allNum = allDate = false; continue; }
    if (typeof v === 'number' && !isNaN(v))                  { sawNum = true;  allBool = allDate = false; continue; }
    if (typeof v === 'object')                               { seenObject = true; allBool = allNum = allDate = false; continue; }
    if (typeof v === 'string') {
      if (ISO_DATE_RE.test(v)) { sawDate = true; allBool = allNum = false; continue; }
      allBool = allNum = allDate = false;
      continue;
    }
    // Anything else falls through to string.
    allBool = allNum = allDate = false;
  }

  if (seenArray)  return 'array';
  if (seenObject) return 'object';
  if (sawDate && allDate) return 'datetime';
  if (sawBool && allBool) return 'boolean';
  if (sawNum  && allNum)  return 'number';
  return 'string';
}

// Given a buffer of rows, return an ordered list of column defs:
//   [{ name, type }]
// Column order follows the FIRST row's keys, then any additional keys
// encountered in later rows appended in insertion order.
function inferColumns(rows) {
  if (!rows || rows.length === 0) return [];

  var order = [];
  var seen = new Set();
  var valuesByCol = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || typeof row !== 'object') continue;
    var keys = Object.keys(row);
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      if (!seen.has(k)) { seen.add(k); order.push(k); valuesByCol[k] = []; }
      valuesByCol[k].push(row[k]);
    }
  }

  return order.map(function(name) {
    return { name: name, type: inferColumnType(valuesByCol[name]) };
  });
}

module.exports = { inferColumns: inferColumns, inferColumnType: inferColumnType };
