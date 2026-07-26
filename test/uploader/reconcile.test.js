// Unit tests for reconcileColumns — pure function, no DB needed.
// Run: node --test test/uploader/reconcile.test.js

var test = require('node:test');
var assert = require('node:assert');
var { reconcileColumns, pgDataTypeToLogical } = require('../../lib/uploader/reconcile');

test('no target schema → source columns stand', function() {
  var src = [{ name: 'a', type: 'number' }, { name: 'b', type: 'string' }];
  var out = reconcileColumns(src, null);
  assert.deepStrictEqual(out, [{ name: 'a', type: 'number' }, { name: 'b', type: 'string' }]);
});

test('target = source types → no change', function() {
  var src = [{ name: 'age', type: 'number' }];
  var target = [{ name: 'age', dataType: 'numeric' }];
  var out = reconcileColumns(src, target);
  assert.deepStrictEqual(out, [{ name: 'age', type: 'number' }]);
});

test('target = TEXT → source number widens to string', function() {
  var src = [{ name: 'age', type: 'number' }];
  var target = [{ name: 'age', dataType: 'text' }];
  var out = reconcileColumns(src, target);
  assert.strictEqual(out[0].type, 'string');
  assert.strictEqual(out[0].sourceType, 'number');
  assert.strictEqual(out[0].targetType, 'string');
});

test('target = TEXT → source datetime widens to string', function() {
  var src = [{ name: 'ts', type: 'datetime' }];
  var target = [{ name: 'ts', dataType: 'character varying' }];
  var out = reconcileColumns(src, target);
  assert.strictEqual(out[0].type, 'string');
});

test('target = INTEGER → source string narrows to number (may fail per-row)', function() {
  var src = [{ name: 'n', type: 'string' }];
  var target = [{ name: 'n', dataType: 'integer' }];
  var out = reconcileColumns(src, target);
  assert.strictEqual(out[0].type, 'number');
  assert.strictEqual(out[0].sourceType, 'string');
});

test('source column missing in target → flagged missing', function() {
  var src = [{ name: 'a', type: 'string' }, { name: 'b', type: 'number' }];
  var target = [{ name: 'a', dataType: 'text' }];   // no 'b'
  var out = reconcileColumns(src, target);
  assert.strictEqual(out[0].missing, undefined);
  assert.strictEqual(out[1].missing, true);
  assert.strictEqual(out[1].name, 'b');
});

test('internal columns ignored in target and source', function() {
  var src = [{ name: 'x', type: 'string' }, { name: '__xeplr_id__', type: 'number' }];
  var target = [
    { name: '__xeplr_id__', dataType: 'bigint' },
    { name: '__xeplr_movement_id__', dataType: 'text' },
    { name: 'x', dataType: 'text' }
  ];
  var out = reconcileColumns(src, target);
  // Internal columns pass through unchanged; not marked missing.
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, 'x');
  assert.strictEqual(out[1].name, '__xeplr_id__');
  assert.strictEqual(out[1].missing, undefined);
});

test('pgDataTypeToLogical maps common types correctly', function() {
  assert.strictEqual(pgDataTypeToLogical('text'), 'string');
  assert.strictEqual(pgDataTypeToLogical('character varying'), 'string');
  assert.strictEqual(pgDataTypeToLogical('integer'), 'number');
  assert.strictEqual(pgDataTypeToLogical('numeric'), 'number');
  assert.strictEqual(pgDataTypeToLogical('boolean'), 'boolean');
  assert.strictEqual(pgDataTypeToLogical('timestamp with time zone'), 'datetime');
  assert.strictEqual(pgDataTypeToLogical('jsonb'), 'object');
  assert.strictEqual(pgDataTypeToLogical('unknown_type'), 'string');   // fallback
});
