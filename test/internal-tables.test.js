// The uploader's own tables, recognised so table pickers can leave them out.
// Run: node --test test/internal-tables.test.js
var test = require('node:test');
var assert = require('node:assert');
var actions = require('../index');
var it = require('../lib/drivers/db/internalTables');

test('the tables the uploader makes for itself are internal', function() {
  assert.equal(actions.isInternalTable('orders_import_errors'), true);
  assert.equal(actions.isInternalTable('orders__xeplr_staging'), true);
  assert.equal(actions.isInternalTable('__xeplr_loads'), true);
  assert.equal(actions.isInternalTable({ name: 'orders_import_errors' }), true, 'a row from a table listing');
  assert.equal(actions.isInternalTable({ table: 'sales__xeplr_staging' }), true);
});

test('everything else is the user\'s', function() {
  ['orders', 'Costing_Data', 'x_import_errors_v2', '_import_errors', '__xeplr_staging', 'import_errors', '', null, undefined, {}]
    .forEach(function(n) { assert.equal(actions.isInternalTable(n), false, JSON.stringify(n)); });
});

test('the names are the ones the uploader and drivers use', function() {
  assert.equal(it.ERRORS_SUFFIX, '_import_errors');
  assert.equal(it.STAGING_SUFFIX, require('../lib/drivers/db/staging').SUFFIX);
  assert.equal(it.LOADS_LEDGER, '__xeplr_loads');
  var built = require('../lib/drivers/db/postgres').buildCreateErrorTableSql('orders');
  assert.ok(built.indexOf('"orders' + it.ERRORS_SUFFIX + '"') !== -1, 'the error table a driver creates is recognised');
});
