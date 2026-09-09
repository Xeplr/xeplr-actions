// Unit tests for the MySQL driver's SQL builders, type mapping and value
// coercion. No live database required — these assert on the generated SQL
// strings and parameter arrays (the driver lazy-requires mysql2 only inside
// connect()/query(), so the module loads without the peer dep).
//
// Run:  node --test test/drivers/mysql.test.js
//
// Live integration coverage (round-tripping against a real MySQL) mirrors
// test/drivers/postgres.test.js and belongs in a DB-gated suite.

var test = require('node:test');
var assert = require('node:assert');
var driver = require('../../lib/drivers/db/mysql');

var COLS = [
  { name: 'invoice_id', type: 'string' },
  { name: 'amount',     type: 'number' },
  { name: 'issued_at',  type: 'datetime' },
  { name: 'is_paid',    type: 'boolean' },
  { name: 'meta',       type: 'object' }
];

test('type map covers every logical type', function() {
  assert.strictEqual(driver.toMysqlType('string'),   'LONGTEXT');
  assert.strictEqual(driver.toMysqlType('number'),   'DECIMAL(38,10)');
  assert.strictEqual(driver.toMysqlType('boolean'),  'TINYINT(1)');
  // A DATE IS NOT A DATETIME. This asserted DATETIME(6) for both, which is
  // what made a source DATE column acquire a midnight in the target — and a
  // midnight shifts under a timezone, moving a business date by a day. The
  // logical vocabulary now has both and they map to different column types.
  assert.strictEqual(driver.toMysqlType('date'),     'DATE');
  assert.strictEqual(driver.toMysqlType('datetime'), 'DATETIME(6)');
  assert.strictEqual(driver.toMysqlType('object'),   'JSON');
  assert.strictEqual(driver.toMysqlType('array'),    'JSON');
  assert.strictEqual(driver.toMysqlType('nonsense'), 'LONGTEXT');   // fallback
});

test('dataTypeToLogical maps native MySQL types back to logical', function() {
  assert.strictEqual(driver.dataTypeToLogical('varchar'),  'string');
  assert.strictEqual(driver.dataTypeToLogical('LONGTEXT'), 'string');   // case-insensitive
  assert.strictEqual(driver.dataTypeToLogical('bigint'),   'number');
  assert.strictEqual(driver.dataTypeToLogical('decimal'),  'number');
  assert.strictEqual(driver.dataTypeToLogical('datetime'), 'datetime');
  assert.strictEqual(driver.dataTypeToLogical('json'),     'object');
  assert.strictEqual(driver.dataTypeToLogical('geometry'), 'string');   // unknown → string
});

test('quoteIdent backtick-quotes and escapes embedded backticks', function() {
  assert.strictEqual(driver.quoteIdent('amount'), '`amount`');
  assert.strictEqual(driver.quoteIdent('a`b'),    '`a``b`');
});

test('buildCreateTableSql includes framework columns first, then user columns', function() {
  var sql = driver.buildCreateTableSql('invoices', COLS);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `invoices`/);
  assert.match(sql, /`__xeplr_id__` BIGINT AUTO_INCREMENT PRIMARY KEY/);
  assert.match(sql, /`__xeplr_movement_id__` VARCHAR\(255\) NOT NULL/);
  assert.match(sql, /`amount` DECIMAL\(38,10\)/);
  assert.match(sql, /`meta` JSON/);
  // Framework id column precedes the first user column.
  assert.ok(sql.indexOf('__xeplr_id__') < sql.indexOf('invoice_id'));
});

test('buildCreateTableSql types a string PK column as indexable VARCHAR (not LONGTEXT)', function() {
  var sql = driver.buildCreateTableSql('invoices', COLS, ['invoice_id']);
  assert.match(sql, /`invoice_id` VARCHAR\(255\)/);   // PK string → indexable
  assert.match(sql, /`meta` JSON/);                    // non-PK unaffected
  assert.doesNotMatch(sql, /`invoice_id` LONGTEXT/);
});

test('buildCreateErrorTableSql names the sidecar table and its columns', function() {
  var sql = driver.buildCreateErrorTableSql('invoices');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `invoices_import_errors`/);
  assert.match(sql, /movement_id VARCHAR\(255\) NOT NULL/);
  assert.match(sql, /raw_row JSON/);
  assert.match(sql, /recorded_at DATETIME\(6\) DEFAULT CURRENT_TIMESTAMP\(6\)/);
});

test('buildAlterTableAddSql emits one ADD COLUMN per column', function() {
  var stmts = driver.buildAlterTableAddSql('invoices', [
    { name: 'b', type: 'number' },
    { name: 'c', type: 'boolean' }
  ]);
  assert.strictEqual(stmts.length, 2);
  assert.strictEqual(stmts[0], 'ALTER TABLE `invoices` ADD COLUMN `b` DECIMAL(38,10)');
  assert.strictEqual(stmts[1], 'ALTER TABLE `invoices` ADD COLUMN `c` TINYINT(1)');
});

test('buildInsertSql: placeholders, movement id prepended, params in order', function() {
  var built = driver.buildInsertSql('invoices', [
    { invoice_id: 'A1', amount: 100.5, issued_at: '2026-01-01T10:00:00Z', is_paid: false, meta: { source: 'x' } }
  ], COLS, 'mv_1', null);

  assert.match(built.sql, /^INSERT INTO `invoices` \(`__xeplr_movement_id__`, `invoice_id`, `amount`, `issued_at`, `is_paid`, `meta`\) VALUES /);
  assert.match(built.sql, /VALUES \(\?,\?,\?,\?,\?,\?\)$/);
  // 6 params: movement id + 5 columns.
  assert.deepStrictEqual(built.params, [
    'mv_1',
    'A1',
    100.5,
    '2026-01-01 10:00:00.000',   // datetime coerced to UTC 'YYYY-MM-DD HH:MM:SS.mmm'
    0,                            // boolean false → 0
    '{"source":"x"}'             // object → JSON string
  ]);
});

test('buildInsertSql: multi-row batch flattens params row-major', function() {
  var cols = [{ name: 'k', type: 'string' }, { name: 'v', type: 'number' }];
  var built = driver.buildInsertSql('t', [
    { k: 'a', v: 1 },
    { k: 'b', v: 2 }
  ], cols, 'mv', null);
  assert.match(built.sql, /VALUES \(\?,\?,\?\),\(\?,\?,\?\)$/);
  assert.deepStrictEqual(built.params, ['mv', 'a', 1, 'mv', 'b', 2]);
});

test('buildInsertSql UPSERT: ON DUPLICATE KEY UPDATE sets non-PK cols + movement id', function() {
  var cols = [
    { name: 'invoice_id', type: 'string' },
    { name: 'amount',     type: 'number' }
  ];
  var built = driver.buildInsertSql('invoices', [{ invoice_id: 'X', amount: 25 }], cols, 'mv2', ['invoice_id']);
  assert.match(built.sql, /ON DUPLICATE KEY UPDATE `amount` = VALUES\(`amount`\), `__xeplr_movement_id__` = VALUES\(`__xeplr_movement_id__`\)/);
  // invoice_id is a PK → must NOT appear in the SET list.
  assert.doesNotMatch(built.sql, /`invoice_id` = VALUES/);
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
    b_true: true, b_str: 'yes', n_str: '42', n_bad: 'N/A',
    arr: [1, 2], when: new Date('2026-03-04T05:06:07.000Z'), nothing: null
  }], cols, 'mv', null);

  // params[0] is movement id, then columns in order.
  assert.deepStrictEqual(built.params.slice(1), [
    1,                       // boolean true → 1
    1,                       // 'yes' → 1
    42,                      // numeric string → number
    'N/A',                   // non-numeric string passes through (MySQL rejects → error table)
    '[1,2]',                 // array → JSON string
    '2026-03-04 05:06:07.000',
    null                     // null stays null
  ]);
});

test('driver advertises a param ceiling and the framework column constants', function() {
  assert.strictEqual(typeof driver.maxParams, 'number');
  assert.ok(driver.maxParams > 0 && driver.maxParams <= 65535);
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
  assert.deepStrictEqual(driver.requires, ['mysql2']);
});
