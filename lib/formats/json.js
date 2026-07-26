// JSON parser — buffers the whole stream (no streaming-JSON dependency —
// CSV/Excel already handle the genuinely-large-file case via true streaming;
// JSON uploads are typically smaller structured data, so buffering the whole
// file is an acceptable simplification here). Accepts either shape,
// auto-detected:
//   - a single JSON array of row objects: [{...}, {...}]
//   - NDJSON: one JSON object per line
//
// parseStream(stream, opts?) → async iterable<row>

module.exports = {
  requires: [],

  async *parseStream(stream, opts) {
    opts = opts || {};
    var chunks = [];
    for await (var chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    var text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return;

    // A single JSON document (array or object) parses cleanly as one value;
    // NDJSON does not (multiple top-level values) — JSON.parse failing is
    // the signal to fall back to line-by-line.
    try {
      var parsed = JSON.parse(text);
      var rows = Array.isArray(parsed) ? parsed : [parsed];
      for (var i = 0; i < rows.length; i++) yield rows[i];
      return;
    } catch (_) {
      // fall through to NDJSON
    }

    var lines = text.split('\n');
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j].trim();
      if (!line) continue;
      yield JSON.parse(line);
    }
  }
};
