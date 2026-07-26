// CSV parser — accepts a readable stream of CSV data, yields row objects.
// Peer dep: csv-parse (declared as optional in @xeplr/actions/package.json).
//
// parseStream(stream, opts?) → async iterable<row>
//   opts.columns          true (default) uses the first row as headers.
//                         Pass an array to override header names.
//   opts.delimiter        default ','
//   opts.cast             default true — csv-parse infers numbers/booleans
//                         from strings automatically. Turn off if you want raw strings.
//   opts.skipEmptyLines   default true
//   opts.trim             default true

module.exports = {
  requires: ['csv-parse'],

  async *parseStream(stream, opts) {
    opts = opts || {};
    var { parse } = require('csv-parse');

    // Custom cast: empty → null, 'true'/'false' → boolean, numeric → number,
    // everything else → string. csv-parse's default `cast: true` handles only
    // numbers, so we roll our own to also pick up booleans (common in CSVs).
    function autoCast(value, context) {
      if (context && context.header) return value;
      if (value === '' || value == null) return null;
      var lower = value.toLowerCase();
      if (lower === 'true')  return true;
      if (lower === 'false') return false;
      if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
      return value;
    }

    var parserOpts = Object.assign({
      columns:          opts.columns !== undefined ? opts.columns : true,
      delimiter:        opts.delimiter || ',',
      cast:             opts.cast !== undefined ? opts.cast : autoCast,
      cast_date:        opts.cast_date !== undefined ? opts.cast_date : false,
      skip_empty_lines: opts.skipEmptyLines !== undefined ? opts.skipEmptyLines : true,
      trim:             opts.trim !== undefined ? opts.trim : true,
      // Strip UTF-8 BOM from stream start. Windows Excel exports CSVs
      // with a BOM (﻿) and it silently corrupts the first header
      // name if not removed. Zero downside — the only edge case is a
      // field whose first byte is literally ﻿, which is essentially
      // never a real file.
      bom:              opts.bom !== undefined ? opts.bom : true
    }, opts.forwardOpts || {});

    var parser = stream.pipe(parse(parserOpts));

    for await (var row of parser) {
      yield row;
    }
  }
};
