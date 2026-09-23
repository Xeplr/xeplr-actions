// data-operation action — from what a step got, make what the next one needs.
//
// The step between steps. A fetch returns everything a table holds; an email
// wants four columns, only the active rows, sorted, and sometimes rendered.
// Without this every one of those is a module somebody writes and maintains,
// and the third one is written slightly differently from the first two.
//
// ROWS AND A RENDERING, BOTH. `rows` is always there and `html` only when
// asked for, and neither is privileged: the next step binds
// {steps.x.output.rows} or {steps.x.output.html} and the consumer decides,
// the same rule that settled the list/item-wise question.
//
// NO AGGREGATION. `group by status, count` changes what a row IS, which is a
// different shape and a different step. Filtering, picking, computing and
// sorting all leave a list of rows a list of rows.
//
// FORMULAS ARE @xeplr/expression-handler — the engine already running BI's
// report formulas and workflow's conditions. `where` and a computed column
// are the same language, with the same functions, evaluated with the run's
// own context: what `today()` means, and therefore what `yesterday()` means,
// is that engine's business and not this action's.

var xf = require('@xeplr/expression-handler');

/** A cell as it goes into HTML: never as markup. */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** What a column is called in the output, and what its header reads. */
function columnSpec(col) {
  if (typeof col === 'string') return { name: col.trim(), label: col.trim(), formula: null };
  if (!col || !col.name) return null;
  return {
    name: String(col.name).trim(),
    label: String(col.label || col.name).trim(),
    formula: col.formula ? String(col.formula) : null,
    // Hidden columns are computed and kept in `rows` — a later step may want
    // an id it does not want printed — but are not in the rendering. See the
    // note on `format` below.
    hidden: Boolean(col.hidden)
  };
}

/**
 * A formula, ready to run against a row.
 *
 * The RUN'S CONTEXT is compiled in — what today is, and when the financial
 * year starts. A workspace whose day starts elsewhere, and a run replayed
 * from history, have to agree on what `yesterday()` meant, and that answer
 * belongs to the engine and the context rather than to this action.
 *
 * `missing: 'null'` — a column that is not on a row reads as nothing, not as
 * an error. Rows out of a real system are ragged, and one row missing a field
 * should not fail the step that was filtering the other nine hundred.
 */
function compile(formula, where, ctx) {
  try {
    return xf.compile(formula, Object.assign({ missing: 'null' }, ctx));
  } catch (err) {
    var e = new Error('Cannot read ' + where + ': ' + err.message);
    e.status = 400;
    throw e;
  }
}

module.exports = {
  name: 'data-operation',
  description: 'From a list of rows, make the list the next step needs: keep some rows, pick and ' +
               'rename columns, compute new ones, sort — and optionally render an HTML table.',
  requires: [],

  inputSchema: [
    { name: 'from', type: 'array', required: true, order: 1,
      description: 'The rows to work on — usually an earlier step\'s output. One object is treated as one row.' },

    { name: 'where', type: 'string', order: 2,
      description: 'Keep only the rows this is true for, e.g. status = "active" and createdDate >= yesterday(). ' +
                   'Blank keeps every row.' },

    // A list rather than a comma-separated string: a computed column needs a
    // formula and a label beside its name, and three parallel strings that
    // have to line up is a shape nobody can edit by hand.
    { name: 'columns', type: 'array', order: 3,
      description: 'Which columns to keep, in order: "name", or { name, label, formula, hidden }. ' +
                   'Blank keeps every column of the first row, as it is.' },

    { name: 'sort', type: 'string', order: 4,
      description: 'A column to sort by. Put - in front for descending, e.g. -dueDate.' },

    // OFF BY DEFAULT. Building a table for ten thousand rows nobody renders
    // is work done and stored on every run — so it is asked for rather than
    // assumed, and the rows are there either way.
    { name: 'format', type: 'boolean', default: false, order: 5,
      description: 'Also give back an HTML table (and a plain-text one) of the visible columns.' },
    { name: 'title', type: 'string', order: 6, group: 'Formatting',
      description: 'A heading above the table.' },
    { name: 'emptyText', type: 'string', order: 7, group: 'Formatting',
      description: 'What the table says when no rows are left. Default: "Nothing to show".' }
  ],

  outputSchema: [
    { name: 'rows', type: 'array', description: 'What is left, with the columns asked for.' },
    { name: 'count', type: 'number', description: 'How many rows — so the next step can branch on none.' },
    { name: 'html', type: 'string', description: 'A table of the visible columns. Only when `format` is on.' },
    { name: 'text', type: 'string', description: 'The same, as plain text, for a mail client that refuses HTML.' }
  ],

  execute: async function(input, context) {
    var given = input.from;
    // A list, always — one object is a list of one, and nothing is an empty
    // list rather than an error. The step after this one should not have to
    // ask which it got.
    var source = given === null || given === undefined ? []
      : Array.isArray(given) ? given
      : [given];

    // The run's own context decides what today is — and therefore what
    // yesterday is. See the note at the top.
    var ctx = (context && context.formula) || {};

    var keep = null;
    if (input.where && String(input.where).trim()) {
      var test = compile(String(input.where), 'the condition', ctx);
      // Anything the formula calls true. `status = "active"` gives a boolean,
      // but `daysLate` gives a number, and a step that filtered on it would
      // otherwise keep every row including the zeroes.
      keep = function(row) {
        var v = test(row);
        return v !== null && v !== undefined && v !== false && v !== 0 && v !== '';
      };
    }

    var specs = (Array.isArray(input.columns) ? input.columns : [])
      .map(columnSpec)
      .filter(Boolean);

    // No columns asked for: every column of the data, as it is. A step that
    // only filters should not have to list what it is not changing.
    if (!specs.length) {
      var first = source.find(function(r) { return r && typeof r === 'object'; });
      specs = Object.keys(first || {}).map(function(k) { return { name: k, label: k, formula: null }; });
    }

    var computed = specs.map(function(spec) {
      return spec.formula ? Object.assign({}, spec, { fn: compile(spec.formula, '"' + spec.label + '"', ctx) }) : spec;
    });

    var rows = [];
    for (var i = 0; i < source.length; i++) {
      var row = source[i] && typeof source[i] === 'object' ? source[i] : {};
      if (keep && !keep(row)) continue;

      var out = {};
      for (var c = 0; c < computed.length; c++) {
        var spec = computed[c];
        out[spec.name] = spec.fn ? spec.fn(row) : row[spec.name];
      }
      rows.push(out);
    }

    if (input.sort && String(input.sort).trim()) {
      var desc = String(input.sort).trim().charAt(0) === '-';
      var by = desc ? String(input.sort).trim().slice(1) : String(input.sort).trim();
      rows.sort(function(a, b) {
        var x = a[by], y = b[by];
        if (x === y) return 0;
        // Nothing sorts last either way: an empty cell is not the smallest
        // value, it is the absence of one, and burying it under the top of a
        // descending list is how it gets missed.
        if (x === null || x === undefined || x === '') return 1;
        if (y === null || y === undefined || y === '') return -1;
        var out = x < y ? -1 : 1;
        return desc ? -out : out;
      });
    }

    var result = { rows: rows, count: rows.length };

    if (input.format) {
      // THE VISIBLE COLUMNS ONLY. A column kept for the next step but not
      // meant to be printed is not printed — and its label, which exists for
      // a header, goes with it.
      var shown = computed.filter(function(s) { return !s.hidden; });
      var empty = input.emptyText || 'Nothing to show';
      result.html = toHtml(rows, shown, input.title, empty);
      result.text = toText(rows, shown, input.title, empty);
    }

    return result;
  }
};

function toHtml(rows, columns, title, empty) {
  var head = '<tr>' + columns.map(function(c) {
    return '<th align="left" style="padding:6px 10px;border-bottom:1px solid #ddd">' + escapeHtml(c.label) + '</th>';
  }).join('') + '</tr>';

  var body = rows.map(function(r) {
    return '<tr>' + columns.map(function(c) {
      return '<td style="padding:6px 10px;border-bottom:1px solid #f0f0f0">' + escapeHtml(r[c.name]) + '</td>';
    }).join('') + '</tr>';
  }).join('');

  // Inline styles and no stylesheet: an email client strips <style> and most
  // of what it does not strip, it ignores.
  var table = rows.length
    ? '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">' +
      '<thead>' + head + '</thead><tbody>' + body + '</tbody></table>'
    : '<p style="font-family:sans-serif;font-size:14px">' + escapeHtml(empty) + '</p>';

  return title ? '<h3 style="font-family:sans-serif;font-size:15px;margin:0 0 8px">' + escapeHtml(title) + '</h3>' + table : table;
}

function toText(rows, columns, title, empty) {
  if (!rows.length) return (title ? title + '\n\n' : '') + empty;

  var cells = [columns.map(function(c) { return String(c.label); })].concat(
    rows.map(function(r) {
      return columns.map(function(c) { return r[c.name] === null || r[c.name] === undefined ? '' : String(r[c.name]); });
    })
  );

  // Padded to the widest cell in each column, so it still reads as a table in
  // a client that shows plain text in a proportional font badly.
  var widths = columns.map(function(_, i) {
    return cells.reduce(function(max, line) { return Math.max(max, line[i].length); }, 0);
  });
  var line = function(parts) {
    return parts.map(function(p, i) { return p.padEnd(widths[i]); }).join('  ').trimEnd();
  };

  var out = [line(cells[0]), widths.map(function(w) { return '-'.repeat(w); }).join('  ')]
    .concat(cells.slice(1).map(line))
    .join('\n');

  return title ? title + '\n\n' + out : out;
}
