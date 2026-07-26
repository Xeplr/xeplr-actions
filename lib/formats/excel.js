// Excel parser — streams .xlsx via the polus-derived reader (unzipper + saxes).
//
// See lib/formats/_xlsx-stream.js for the WHY (SharePoint / .NET OpenXML
// files use namespace-prefixed tags — <x:row>, <x:c> — which the popular
// `xlsx-stream-reader` npm package silently fails to parse, burning heap
// while emitting zero rows).
//
// Peer deps: `unzipper`, `saxes` — both small, both truly streaming.
//
// Interface:
//   inputMode:            'path'                   — needs a file path (unzipper seeks)
//   parsePath(filePath, opts?) → async iterable<row>
//
//   opts.sheet         — sheet name to read (default: first / largest sheet)
//   opts.startRow      — skip N leading rows AFTER headers (default 0)
//   opts.columns       — true (default): first row is headers, yield objects.
//                        false: yield arrays. Not supported yet — polus reader
//                        always uses header names.
// Values arrive TYPED from Excel cell metadata:
//   date-styled numbers → Date objects (identify with `value instanceof Date`)
//   number cells        → numbers
//   boolean cells       → booleans
//   string cells        → strings (from sharedStrings or inline)
//
// Memory / backpressure: `saxes` parses synchronously per data chunk and
// doesn't await our onRow callback, so we can't truly pause the SAX parser
// from userspace. Instead we buffer rows in an unbounded queue and yield
// them out; peak memory is bounded by how fast the downstream consumer
// pulls from the iterator. The uploader routes rows through `spool()` which
// flushes each batch to a rotating NDJSON file — that pulls the queue empty
// on a fast, disk-bound cadence and keeps peak RSS in the hundreds-of-MB
// range even on 1.3GB sheet.xml streams.

var { stream_xlsx_sheet_rows, list_xlsx_sheets } = require('./_xlsx-stream');

module.exports = {
  requires:  ['unzipper', 'saxes'],
  inputMode: 'path',

  // Sheet names in document order — for a "pick a sheet" UI step before
  // parsing any one sheet's rows via parsePath(filePath, {sheet}).
  async listSheets(filePath) {
    return list_xlsx_sheets(filePath);
  },

  async *parsePath(filePath, opts) {
    opts = opts || {};
    if (opts.columns === false) {
      throw new Error('excel: columns:false (array rows) is not supported by the streaming reader. Omit or set true.');
    }

    var startRow = opts.startRow || 0;
    var queue = [];
    var done  = false;
    var err   = null;
    var skipped = 0;

    var consumerWait = null;
    function wakeConsumer() { if (consumerWait) { consumerWait(); consumerWait = null; } }

    var readerDone = stream_xlsx_sheet_rows(filePath, opts.sheet || null, {
      onRow: function(rec) {
        if (skipped < startRow) { skipped++; return; }
        queue.push(rec);
        wakeConsumer();
      }
    }).then(function() {
      done = true;
      wakeConsumer();
    }, function(e) {
      err = e;
      done = true;
      wakeConsumer();
    });

    try {
      while (true) {
        if (err) throw err;
        if (queue.length) { yield queue.shift(); continue; }
        if (done) return;
        await new Promise(function(resolve) { consumerWait = resolve; });
      }
    } finally {
      try { await readerDone; } catch (_) { /* already surfaced via err */ }
    }
  }
};
