// Unit tests for the MSSQL driver's SQL builders, type mapping and value
// coercion. No live database required — these assert on the generated SQL
// strings and parameter arrays (the driver lazy-requires mssql only inside
// connect()/query(), so the module loads without the peer dep).
//
// Run:  node --test test/drivers/mssql.test.js
//
// Live integration coverage (round-tripping against a real SQL Server) mirrors
// test/drivers/postgres.test.js and belongs in a DB-gated suite.

var test = require('node:test');
var assert = require('node:assert');
var driver = require('../../lib/drivers/db/mssql');

var COLS = [
  { name: 'invoice_id', type: 'string' },
  { name: 'amount',     type: 'number' },
  { name: 'issued_at',  type: 'datetime' },
  { name: 'is_paid',    type: 'boolean' },
  { name: 'meta',       type: 'object' }
];

test('type map covers every logical type', function() {
  assert.strictEqual(driver.toMssqlType('string'),   'NVARCHAR(MAX)');
  assert.strictEqual(driver.toMssqlType('number'),   'DECIMAL(38,10)');
  assert.strictEqual(driver.toMssqlType('boolean'),  'BIT');
  // A DATE IS NOT A DATETIME — see the same assertion in mysql.test.js.
  assert.strictEqual(driver.toMssqlType('date'),     'DATE');
  assert.strictEqual(driver.toMssqlType('datetime'), 'DATETIME2');
  assert.strictEqual(driver.toMssqlType('object'),   'NVARCHAR(MAX)');
  assert.strictEqual(driver.toMssqlType('array'),    'NVARCHAR(MAX)');
  assert.strictEqual(driver.toMssqlType('nonsense'), 'NVARCHAR(MAX)');   // fallback
});

test('dataTypeToLogical maps native SQL Server types back to logical', function() {
  assert.strictEqual(driver.dataTypeToLogical('nvarchar'),  'string');
  assert.strictEqual(driver.dataTypeToLogical('NVARCHAR'),  'string');   // case-insensitive
  assert.strictEqual(driver.dataTypeToLogical('bigint'),    'number');
  assert.strictEqual(driver.dataTypeToLogical('decimal'),   'number');
  assert.strictEqual(driver.dataTypeToLogical('bit'),       'boolean');
  assert.strictEqual(driver.dataTypeToLogical('datetime2'), 'datetime');
  assert.strictEqual(driver.dataTypeToLogical('geography'), 'string');   // unknown → string
});

test('quoteIdent bracket-quotes and escapes embedded closing brackets', function() {
  assert.strictEqual(driver.quoteIdent('amount'), '[amount]');
  assert.strictEqual(driver.quoteIdent('a]b'),    '[a]]b]');
});

test('buildCreateTableSql guards with IF OBJECT_ID and declares framework cols', function() {
  var sql = driver.buildCreateTableSql('invoices', COLS);
  assert.match(sql, /IF OBJECT_ID\(N'invoices', 'U'\) IS NULL/);
  assert.match(sql, /CREATE TABLE \[invoices\]/);
  assert.match(sql, /\[__xeplr_id__\] BIGINT IDENTITY\(1,1\) PRIMARY KEY/);
  assert.match(sql, /\[__xeplr_movement_id__\] NVARCHAR\(255\) NOT NULL/);
  assert.match(sql, /\[amount\] DECIMAL\(38,10\)/);
  assert.match(sql, /\[meta\] NVARCHAR\(MAX\)/);
});

test('buildCreateTableSql types a string PK column as indexable NVARCHAR (not MAX)', function() {
  var sql = driver.buildCreateTableSql('invoices', COLS, ['invoice_id']);
  assert.match(sql, /\[invoice_id\] NVARCHAR\(255\)/);   // PK string → indexable
  assert.match(sql, /\[meta\] NVARCHAR\(MAX\)/);          // non-PK unaffected
  assert.doesNotMatch(sql, /\[invoice_id\] NVARCHAR\(MAX\)/);
});

test('buildCreateErrorTableSql guards and names the sidecar table', function() {
  var sql = driver.buildCreateErrorTableSql('invoices');
  assert.match(sql, /IF OBJECT_ID\(N'invoices_import_errors', 'U'\) IS NULL/);
  assert.match(sql, /CREATE TABLE \[invoices_import_errors\]/);
  assert.match(sql, /movement_id NVARCHAR\(255\) NOT NULL/);
  assert.match(sql, /raw_row NVARCHAR\(MAX\)/);
  assert.match(sql, /recorded_at DATETIME2 DEFAULT SYSUTCDATETIME\(\)/);
});

test('buildAlterTableAddSql emits one guarded ADD per column (no COLUMN keyword)', function() {
  var stmts = driver.buildAlterTableAddSql('invoices', [
    { name: 'b', type: 'number' },
    { name: 'c', type: 'boolean' }
  ]);
  assert.strictEqual(stmts.length, 2);
  assert.match(stmts[0], /IF COL_LENGTH\(N'invoices', N'b'\) IS NULL/);
  assert.match(stmts[0], /ALTER TABLE \[invoices\] ADD \[b\] DECIMAL\(38,10\)/);
  assert.match(stmts[1], /ALTER TABLE \[invoices\] ADD \[c\] BIT/);
});

test('buildInsertSql: @p placeholders 0-based, movement id prepended, params in order', function() {
  var built = driver.buildInsertSql('invoices', [
    { invoice_id: 'A1', amount: 100.5, issued_at: '2026-01-01T10:00:00Z', is_paid: false, meta: { source: 'x' } }
  ], COLS, 'mv_1', null);

  assert.match(built.sql, /^INSERT INTO \[invoices\] \(\[__xeplr_movement_id__\], \[invoice_id\], \[amount\], \[issued_at\], \[is_paid\], \[meta\]\) VALUES /);
  assert.match(built.sql, /VALUES \(@p0,@p1,@p2,@p3,@p4,@p5\)$/);
  assert.deepStrictEqual(built.params, [
    'mv_1',
    'A1',
    100.5,
    '2026-01-01 10:00:00.000',   // datetime → UTC 'YYYY-MM-DD HH:MM:SS.mmm'
    false,                        // boolean stays JS boolean (→ BIT via mssql)
    '{"source":"x"}'
  ]);
});

test('buildInsertSql: multi-row batch keeps @p indices monotonic across rows', function() {
  var cols = [{ name: 'k', type: 'string' }, { name: 'v', type: 'number' }];
  var built = driver.buildInsertSql('t', [
    { k: 'a', v: 1 },
    { k: 'b', v: 2 }
  ], cols, 'mv', null);
  assert.match(built.sql, /VALUES \(@p0,@p1,@p2\),\(@p3,@p4,@p5\)$/);
  assert.deepStrictEqual(built.params, ['mv', 'a', 1, 'mv', 'b', 2]);
});

test('buildInsertSql UPSERT: emits a terminated MERGE with matched/not-matched arms', function() {
  var cols = [
    { name: 'invoice_id', type: 'string' },
    { name: 'amount',     type: 'number' }
  ];
  var built = driver.buildInsertSql('invoices', [{ invoice_id: 'X', amount: 25 }], cols, 'mv2', ['invoice_id']);
  assert.match(built.sql, /^MERGE INTO \[invoices\] AS T/);
  assert.match(built.sql, /USING \(VALUES \(@p0,@p1,@p2\)\) AS S/);
  assert.match(built.sql, /ON T\.\[invoice_id\] = S\.\[invoice_id\]/);
  assert.match(built.sql, /WHEN MATCHED THEN UPDATE SET T\.\[amount\] = S\.\[amount\], T\.\[__xeplr_movement_id__\] = S\.\[__xeplr_movement_id__\]/);
  assert.match(built.sql, /WHEN NOT MATCHED THEN INSERT/);
  assert.match(built.sql, /;\s*$/);   // MERGE must be semicolon-terminated
  // PK column must not appear in the UPDATE SET arm.
  assert.doesNotMatch(built.sql, /SET[^]*T\.\[invoice_id\] = S/);
});

test('coerceValue (via buildInsertSql params) handles booleans, dates, json, nulls', function() {
  var cols = [
    { name: 'b_true',  type: 'boolean' },
    { name: 'b_str',   type: 'boolean' },
    { name: 'n_str',   type: 'number' },
    { name: 'n_bad',   type: 'number' },
    { name: 'arr',     type: 'array' },
    { name: 'when',    type: 'datetime' },
    { name: 'nothing', type: 'string' }
  ];
  var built = driver.buildInsertSql('t', [{
    b_true: true, b_str: 'no', n_str: '42', n_bad: 'N/A',
    arr: [1, 2], when: new Date('2026-03-04T05:06:07.000Z'), nothing: null
  }], cols, 'mv', null);

  assert.deepStrictEqual(built.params.slice(1), [
    true,                    // boolean stays boolean
    false,                   // 'no' → false
    42,                      // numeric string → number
    'N/A',                   // non-numeric string passes through (SQL Server rejects → error table)
    '[1,2]',                 // array → JSON string
    '2026-03-04 05:06:07.000',
    null
  ]);
});

test('driver advertises the SQL Server param ceiling (≤ 2100) and framework constants', function() {
  assert.strictEqual(typeof driver.maxParams, 'number');
  // Must stay under the 2100-param limit AND keep ≤1000 rows/statement.
  assert.ok(driver.maxParams > 0 && driver.maxParams <= 2100);
  assert.strictEqual(driver.INTERNAL_ID_COL, '__xeplr_id__');
  assert.strictEqual(driver.INTERNAL_MOVEMENT_COL, '__xeplr_movement_id__');
});

test('exposes the full driver interface (parity with postgres)', function() {
  ['requires', 'connect', 'query', 'close', 'dataTypeToLogical', 'quoteIdent',
   'buildCreateTableSql', 'buildCreateErrorTableSql', 'buildAlterTableAddSql',
   'buildInsertSql', 'ensureMovementColumn', 'ensureUpsertIndex',
   'getTableSchema', 'rollbackMovement'
  ].forEach(function(k) {
    assert.ok(driver[k] !== undefined, 'missing driver export: ' + k);
  });
  assert.deepStrictEqual(driver.requires, ['mssql']);
});
