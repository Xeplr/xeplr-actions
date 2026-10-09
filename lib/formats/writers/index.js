// File WRITERS — the other direction from the parsers beside this folder.
// Each is { requires, open(filePath, doc) → { writeRow(row), close() } }.
// The PDF writer also lays out placed blocks (renderPages).

var WRITERS = {
  csv:  function() { return require('./csv'); },
  xlsx: function() { return require('./xlsx'); },
  pdf:  function() { return require('./pdf'); }
};

var INFO = {
  csv:  { extension: 'csv',  contentType: 'text/csv; charset=utf-8' },
  xlsx: { extension: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pdf:  { extension: 'pdf',  contentType: 'application/pdf' }
};

function getWriter(type) {
  var loader = WRITERS[type];
  if (!loader) throw new Error('Unknown export format: "' + type + '". Supported: ' + Object.keys(WRITERS).join(', '));
  return loader();
}

module.exports = { getWriter: getWriter, INFO: INFO, SUPPORTED: Object.keys(WRITERS) };
