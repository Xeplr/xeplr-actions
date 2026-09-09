// CALLING A STORED PROCEDURE — one implementation, three dialects.
//
// This is the only place in the codebase that knows how a procedure is called.
// It lived inside db-move's procedurePlan, which was the wrong home for two
// reasons and both of them showed:
//
//   1. It could only be reached by MOVING data. A procedure that returns
//      nothing — a nightly recalculation, a flag flipped, a queue drained —
//      had no way to be called at all, because db-move requires a target
//      table and its whole shape is "read rows, write them somewhere".
//   2. A second caller would have had to copy it. Dialect-specific call
//      syntax copied twice is dialect-specific call syntax that disagrees with
//      itself within a release.
//
// So the mover now asks this for its SQL like anybody else. db-procedure (the
// action) and db-move (the mover) build the identical statement, because it is
// the identical function.
//
// ── the dialects genuinely differ, and not only in spelling ──────────────
//
//   mssql     EXEC dbo.usp_x @region = ?, @minimum = ?
//             Returns its result set directly, and works whether or not there
//             is one. The only dialect where one form covers both cases.
//
//   mysql     CALL usp_x(?, ?)
//             No named-argument syntax exists, so parameters are POSITIONAL
//             and must be given in the order the procedure declares them. A
//             caller that names them is not wrong here, it is just not helped.
//
//   postgres  SELECT * FROM fn(region => ?)   ← when you want the rows
//             CALL proc(region => ?)          ← when you do not
//             These are two different database objects. A Postgres PROCEDURE
//             (CREATE PROCEDURE, called with CALL) returns nothing a client
//             can read; a set-returning FUNCTION is the thing that behaves
//             like "a procedure that gives you rows". Choosing between them is
//             what `returnsRows` is for, and it is why db-move can only ever
//             use the function form: it exists to move the rows.
//
// Parameters are always BOUND, never interpolated. A procedure name is an
// identifier and is quoted; its arguments are values and travel as binds.

/**
 * Dialect placeholder for bind param n (0-based).
 *
 * Exported because the caller has to build the params array in the same order
 * as the marks, and there is no reason for two definitions of `$1`.
 */
function placeholders(dbType) {
  if (dbType === 'mysql')  return function()  { return '?'; };
  if (dbType === 'mssql')  return function(n) { return '@p' + n; };
  return function(n) { return '$' + (n + 1); };   // postgres
}

/**
 * A procedure/table-function name can be schema-qualified ("dbo.usp_x") —
 * driver.quoteIdent treats a dot as part of a single identifier and would
 * bracket the whole string as one name ("[dbo.usp_x]"), which the database
 * then cannot resolve at all. Table/column names elsewhere never legitimately
 * contain a dot, which is why this is its own function rather than a change to
 * quoteIdent itself — that one stays exactly as narrow as it always was for
 * the callers that rely on a dot never being special.
 */
function quoteQualifiedIdent(driver, name) {
  return String(name).split('.').map(function(part) { return driver.quoteIdent(part); }).join('.');
}

/**
 * A parameter value, made safe to bind — or a clear error instead of a
 * cryptic one from three layers down (the mssql driver's own type inference
 * falls back to NVARCHAR for anything it doesn't recognize as a number,
 * boolean or date, and NVARCHAR's own validation then rejects a plain object
 * with "Validation failed for parameter 'pN'. Invalid string." — naming the
 * placeholder, not the parameter someone actually typed, and giving no hint
 * that the real problem is the value's shape).
 *
 * A numeric-looking string ('2026') is coerced to a real number rather than
 * left for the database to implicitly convert from NVARCHAR.
 *
 * AN EMPTY STRING IS NULL, and that rule is load-bearing rather than tidy: a
 * step editor renders every unset field as '', so a procedure's optional date
 * parameter left blank arrives here as an empty string. Passing that through
 * fails on a date or an int in all three dialects, and "" is not what the
 * person who left the box alone meant — they meant nothing.
 */
function normalizeParamValue(name, value) {
  if (value === undefined || value === '') return null;
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) {
    return value;
  }
  if (typeof value === 'string') {
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
    return value;
  }
  throw new Error('parameter "' + name + '" must be text, a number, or a date — got ' + typeof value + '.');
}

/**
 * Normalise the caller's parameter list.
 *
 * Accepts `[{ name, value }]` or bare values, mixed. Named entries are matched
 * by NAME where the dialect supports it, because getting a procedure's
 * declared parameter ORDER right from outside it is easy to get wrong
 * silently — the call succeeds and the arguments are in the wrong slots.
 */
function normalizeParams(params) {
  return (params || []).map(function(p) {
    var raw = (p && typeof p === 'object' && 'value' in p) ? p : { name: null, value: p };
    return { name: raw.name || null, value: normalizeParamValue(raw.name || '(unnamed)', raw.value) };
  });
}

/**
 * A WINDOW, handed to a procedure as its own parameters.
 *
 * Everywhere else in this codebase a window becomes a WHERE. A procedure has
 * no WHERE to add one to — `SELECT … FROM (EXEC p) x` is not a thing in any of
 * the three dialects — so the only way to narrow one is to pass the edges in
 * and let the procedure do it. Which parameters those are is knowledge only
 * the caller has, so the caller names them.
 *
 * REFUSED when they are not named, rather than quietly dropping the window.
 * Dropping it means the procedure returns everything it has, the run reports
 * success, and an incremental job silently reprocesses its whole history every
 * night — which costs exactly what incremental was meant to save while looking
 * like it worked.
 *
 * HALF-OPEN, from <= x < to, and the procedure is expected to honour that.
 * Jobs pins `to` once per run and starts the next run at exactly that value
 * (see @xeplr/jobs' buildWindow and migrations/0006) — so a procedure that
 * treats `to` as inclusive double-counts the boundary row on every run.
 *
 * A null edge is passed through as null rather than skipped: an unbounded
 * lower edge is what a first incremental run legitimately has, and a
 * procedure that receives NULL can decide what that means. Skipping the
 * parameter instead would shift every later argument by one on MySQL, where
 * they are positional.
 */
function windowParams(win) {
  if (!win) return [];
  if (!win.fromParam && !win.toParam) {
    throw new Error(
      'a window on a procedure needs window.fromParam / window.toParam — a procedure cannot ' +
      'be filtered from outside. Give the procedure its own date parameters, or drop the window.');
  }
  var out = [];
  if (win.fromParam) out.push({ name: win.fromParam, value: win.from == null ? null : win.from });
  if (win.toParam)   out.push({ name: win.toParam,   value: win.to == null ? null : win.to });
  return out;
}

/**
 * Build the call.
 *
 * @param {object}  opts
 * @param {object}  opts.driver      - the db driver, for quoting
 * @param {string}  opts.dbType      - postgres | mysql | mssql
 * @param {string}  opts.name        - procedure name, optionally schema-qualified
 * @param {Array}   [opts.params]    - [{ name, value }] or bare values
 * @param {object}  [opts.window]    - { from, to, fromParam, toParam } — appended
 *                                     as two more named parameters, AFTER the
 *                                     caller's own, which is what keeps a MySQL
 *                                     positional call in the order the author
 *                                     wrote it plus the window at the end.
 * @param {boolean} [opts.returnsRows=true] - postgres only: SELECT * FROM fn()
 *                                     when true, CALL proc() when false. The
 *                                     other two dialects have one form each.
 * @returns {{ sql: string, params: Array, named: boolean }}
 *          `named` reports whether the dialect actually honoured the names —
 *          false on MySQL, so a caller can warn rather than let somebody
 *          believe their names did something.
 */
function buildProcedureCall(opts) {
  var dbType = opts.dbType;
  var name = opts.name;
  if (!name) throw new Error('a procedure call needs a procedure name');

  var entries = normalizeParams((opts.params || []).concat(windowParams(opts.window)));
  var returnsRows = opts.returnsRows !== false;
  var ph = placeholders(dbType);
  var supportsNames = dbType === 'mssql' || dbType === 'postgres';

  var marks = entries.map(function(p, i) {
    var mark = ph(i);
    if (!p.name || !supportsNames) return mark;
    if (dbType === 'mssql') return '@' + p.name + ' = ' + mark;
    return p.name + ' => ' + mark;              // postgres named-argument call
  }).join(', ');

  var quoted = quoteQualifiedIdent(opts.driver, name);
  var sql;
  switch (dbType) {
    case 'mssql':
      sql = 'EXEC ' + quoted + (marks ? ' ' + marks : '');
      break;
    case 'mysql':
      sql = 'CALL ' + quoted + '(' + marks + ')';
      break;
    case 'postgres':
      sql = returnsRows
        ? 'SELECT * FROM ' + quoted + '(' + marks + ')'
        : 'CALL ' + quoted + '(' + marks + ')';
      break;
    default:
      throw new Error('calling a procedure is not supported for "' + dbType + '"');
  }

  return {
    sql: sql,
    params: entries.map(function(p) { return p.value; }),
    named: supportsNames && entries.some(function(p) { return Boolean(p.name); })
  };
}

module.exports = {
  buildProcedureCall: buildProcedureCall,
  windowParams: windowParams,
  normalizeParams: normalizeParams,
  normalizeParamValue: normalizeParamValue,
  quoteQualifiedIdent: quoteQualifiedIdent,
  placeholders: placeholders
};
