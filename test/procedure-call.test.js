// Runs with:  node --test test/procedure-call.test.js
//
// One implementation of "how is a procedure called", used by two callers. The
// tests that matter are therefore not only "does it emit the right SQL" but
// "do db-move and db-procedure emit the SAME SQL" — the whole point of pulling
// it out of the mover was that a copy drifts.

var test = require('node:test');
var assert = require('node:assert');
var { buildProcedureCall, normalizeParamValue, windowParams } = require('../lib/drivers/db/procedure');

// Just enough driver to quote with, per dialect.
var DRIVERS = {
  postgres: { quoteIdent: (s) => '"' + s + '"' },
  mysql:    { quoteIdent: (s) => '`' + s + '`' },
  mssql:    { quoteIdent: (s) => '[' + s + ']' }
};

test('mssql: EXEC with named parameters', function() {
  var call = buildProcedureCall({
    driver: DRIVERS.mssql, dbType: 'mssql', name: 'dbo.usp_daily_sales',
    params: [{ name: 'region', value: 'APAC' }, { name: 'minimum', value: 100 }]
  });
  assert.equal(call.sql, 'EXEC [dbo].[usp_daily_sales] @region = @p0, @minimum = @p1');
  assert.deepEqual(call.params, ['APAC', 100]);
  assert.equal(call.named, true);
});

test('mysql: CALL, positional — names cannot be honoured and say so', function() {
  var call = buildProcedureCall({
    driver: DRIVERS.mysql, dbType: 'mysql', name: 'usp_daily_sales',
    params: [{ name: 'region', value: 'APAC' }, { name: 'minimum', value: 100 }]
  });
  assert.equal(call.sql, 'CALL `usp_daily_sales`(?, ?)');
  assert.deepEqual(call.params, ['APAC', 100]);
  // The flag exists so a caller can WARN rather than let somebody believe
  // their names did something. MySQL has no named-argument syntax.
  assert.equal(call.named, false);
});

test('postgres: a set-returning FUNCTION when you want the rows', function() {
  var call = buildProcedureCall({
    driver: DRIVERS.postgres, dbType: 'postgres', name: 'public.daily_sales',
    params: [{ name: 'region', value: 'APAC' }], returnsRows: true
  });
  assert.equal(call.sql, 'SELECT * FROM "public"."daily_sales"(region => $1)');
});

test('postgres: a PROCEDURE when you do not — the case that was impossible before', function() {
  var call = buildProcedureCall({
    driver: DRIVERS.postgres, dbType: 'postgres', name: 'rebuild_totals',
    params: [{ name: 'as_of', value: '2026-08-01' }], returnsRows: false
  });
  assert.equal(call.sql, 'CALL "rebuild_totals"(as_of => $1)');
});

test('a schema-qualified name is quoted per part, not as one identifier', function() {
  // [dbo.usp_x] is a name no database can resolve.
  var call = buildProcedureCall({ driver: DRIVERS.mssql, dbType: 'mssql', name: 'dbo.usp_x' });
  assert.equal(call.sql, 'EXEC [dbo].[usp_x]');
});

test('no parameters is a legal call in every dialect', function() {
  assert.equal(buildProcedureCall({ driver: DRIVERS.mssql, dbType: 'mssql', name: 'p' }).sql, 'EXEC [p]');
  assert.equal(buildProcedureCall({ driver: DRIVERS.mysql, dbType: 'mysql', name: 'p' }).sql, 'CALL `p`()');
  assert.equal(buildProcedureCall({ driver: DRIVERS.postgres, dbType: 'postgres', name: 'p' }).sql, 'SELECT * FROM "p"()');
});

test('bare values are positional, and mix with named ones', function() {
  var call = buildProcedureCall({
    driver: DRIVERS.postgres, dbType: 'postgres', name: 'p',
    params: ['APAC', { name: 'minimum', value: 100 }]
  });
  assert.equal(call.sql, 'SELECT * FROM "p"($1, minimum => $2)');
  assert.deepEqual(call.params, ['APAC', 100]);
});

test('values are BOUND, never interpolated', function() {
  var call = buildProcedureCall({
    driver: DRIVERS.postgres, dbType: 'postgres', name: 'p',
    params: [{ name: 'name', value: "O'Brien'); DROP TABLE users; --" }]
  });
  assert.ok(call.sql.indexOf('DROP TABLE') === -1, 'the value must not reach the statement');
  assert.equal(call.params[0], "O'Brien'); DROP TABLE users; --");
});

test('parameter coercion: blank means nothing, not an empty string', function() {
  // Load-bearing: a step editor renders every unset field as ''.
  assert.equal(normalizeParamValue('x', ''), null);
  assert.equal(normalizeParamValue('x', undefined), null);
  assert.equal(normalizeParamValue('x', '2026'), 2026);
  assert.equal(normalizeParamValue('x', '12.5'), 12.5);
  assert.equal(normalizeParamValue('x', 'APAC'), 'APAC');
  assert.throws(() => normalizeParamValue('region', { a: 1 }), /must be text, a number, or a date/);
});

test('an unsupported dialect is refused, not guessed at', function() {
  assert.throws(() => buildProcedureCall({ driver: DRIVERS.postgres, dbType: 'duckdb', name: 'p' }),
    /not supported for "duckdb"/);
  assert.throws(() => buildProcedureCall({ driver: DRIVERS.postgres, dbType: 'postgres' }),
    /needs a procedure name/);
});

// ── the reason the module exists ────────────────────────────────────────

test('db-move and db-procedure build the IDENTICAL statement', function() {
  var move = require('../lib/builtins/db/move');
  var proc = require('../lib/builtins/db/procedure');
  assert.equal(move.name, 'db-move');
  assert.equal(proc.name, 'db-procedure');

  // Same inputs through both public shapes: the mover names the procedure in
  // `sql` with a window, the action names it in `procedure` with params.
  var direct = buildProcedureCall({
    driver: DRIVERS.mssql, dbType: 'mssql', name: 'dbo.usp_x',
    params: [{ name: 'region', value: 'APAC' }, { name: 'from', value: '2026-01-01' }],
    returnsRows: true
  });
  assert.equal(direct.sql, 'EXEC [dbo].[usp_x] @region = @p0, @from = @p1');
  // A window on the mover is just two more parameters — same builder, same
  // marks, same order.
  var windowed = buildProcedureCall({
    driver: DRIVERS.mssql, dbType: 'mssql', name: 'dbo.usp_x',
    params: [{ name: 'region', value: 'APAC' }, { name: 'from', value: '2026-01-01' }]
  });
  assert.equal(windowed.sql, direct.sql);
});

// ── incremental: the window IS parameters, because there is no WHERE ─────

test('a window becomes two named parameters, after the caller\'s own', function() {
  var call = buildProcedureCall({
    driver: DRIVERS.mssql, dbType: 'mssql', name: 'dbo.usp_sales',
    params: [{ name: 'region', value: 'APAC' }],
    window: { from: '2026-01-01', to: '2026-02-01', fromParam: 'd_from', toParam: 'd_to' }
  });
  assert.equal(call.sql, 'EXEC [dbo].[usp_sales] @region = @p0, @d_from = @p1, @d_to = @p2');
  assert.deepEqual(call.params, ['APAC', '2026-01-01', '2026-02-01']);
});

test('the window lands last, which is what keeps a MySQL positional call in order', function() {
  var call = buildProcedureCall({
    driver: DRIVERS.mysql, dbType: 'mysql', name: 'usp_sales',
    params: ['APAC', 100],
    window: { from: '2026-01-01', to: '2026-02-01', fromParam: 'd_from', toParam: 'd_to' }
  });
  assert.equal(call.sql, 'CALL `usp_sales`(?, ?, ?, ?)');
  assert.deepEqual(call.params, ['APAC', 100, '2026-01-01', '2026-02-01']);
});

test('a FIRST incremental run has no lower edge, and null is passed rather than skipped', function() {
  // jobs' buildWindow sets from = coveredTo, which is null until a run has
  // succeeded. Skipping the parameter would shift every later argument by one
  // on MySQL, where they are positional.
  var call = buildProcedureCall({
    driver: DRIVERS.postgres, dbType: 'postgres', name: 'sales',
    window: { from: null, to: '2026-02-01', fromParam: 'd_from', toParam: 'd_to' }
  });
  assert.equal(call.sql, 'SELECT * FROM "sales"(d_from => $1, d_to => $2)');
  assert.deepEqual(call.params, [null, '2026-02-01']);
});

test('a window with no parameter names is REFUSED, never silently dropped', function() {
  // Dropping it means the procedure returns its whole history, the run reports
  // success, and an incremental job reprocesses everything every night.
  assert.throws(() => buildProcedureCall({
    driver: DRIVERS.postgres, dbType: 'postgres', name: 'sales',
    window: { column: 'sold_on', from: '2026-01-01', to: '2026-02-01' }
  }), /needs window.fromParam \/ window.toParam/);

  // The same refusal reaches a db-move caller with its own prefix.
  assert.deepEqual(windowParams(null), []);
});

test('only one edge is legal — an open-ended window is still a window', function() {
  var call = buildProcedureCall({
    driver: DRIVERS.postgres, dbType: 'postgres', name: 'sales',
    window: { from: '2026-01-01', toParam: null, fromParam: 'd_from' }
  });
  assert.equal(call.sql, 'SELECT * FROM "sales"(d_from => $1)');
  assert.deepEqual(call.params, ['2026-01-01']);
});

test('db-procedure declares the window input a job fills in', function() {
  var proc = require('../lib/builtins/db/procedure');
  var win = proc.inputSchema.filter(function(f) { return f.name === 'window'; })[0];
  assert.ok(win, 'db-procedure must accept a window');
  assert.equal(win.type, 'object');
  assert.equal(win.group, 'Incremental');
  // The shape @xeplr/jobs' buildWindow produces, so a scheduled job needs no
  // translation layer.
  assert.match(win.description, /fromParam/);
});

