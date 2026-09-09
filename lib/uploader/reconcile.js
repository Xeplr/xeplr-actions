// Reconcile source-inferred column types with an existing target table's
// actual schema. The target table is authoritative — its column types WIN.
// Source values will be coerced to match the target's type at INSERT.
//
// Special case: TEXT / VARCHAR target columns accept anything, so any
// source type widens safely to 'string' (numbers/dates/bools/objects all
// get serialized on INSERT).
//
// Columns that exist in the source but NOT in the target are surfaced as
// `missing: true` — the caller (uploader) decides whether to ALTER TABLE
// ADD or reject the upload.
//
// Framework-managed columns (__xeplr_id__, __xeplr_movement_id__) are
// ignored during reconciliation.

var INTERNAL_COLS = new Set(['__xeplr_id__', '__xeplr_movement_id__']);

// Postgres data_type strings → our logical types.
var PG_TO_LOGICAL = {
  'text':                        'string',
  'character varying':           'string',
  'character':                   'string',
  'uuid':                        'string',
  'integer':                     'number',
  'bigint':                      'number',
  'smallint':                    'number',
  'numeric':                     'number',
  'real':                        'number',
  'double precision':            'number',
  'boolean':                     'boolean',
  'timestamp with time zone':    'datetime',
  'timestamp without time zone': 'datetime',
  // A DATE IS NOT A TIMESTAMP, and mapping it to one moves it.
  //
  // This said 'datetime', so a source `date` was created as TIMESTAMPTZ in the
  // target and the value acquired midnight in the server's zone. From +05:30,
  // 2026-01-05 stored as 2026-01-04T18:30:00Z — a business date a day earlier
  // than the one that was moved, and every report grouped by it off by one for
  // half the day.
  //
  // Reachable only via a declared schema (inference sees an ISO string and
  // still says 'datetime', correctly — it cannot know), so nothing that infers
  // changes behaviour. See upload()'s `columns` option.
  'date':                        'date',
  'time with time zone':         'datetime',
  'time without time zone':      'datetime',
  'json':                        'object',
  'jsonb':                       'object',
  'ARRAY':                       'array'
};

function pgDataTypeToLogical(dataType) {
  return PG_TO_LOGICAL[dataType] || 'string';   // unknown → assume TEXT-like
}

/**
 * @param {Array<{name,type}>}                                   sourceColumns
 * @param {Array<{name,dataType,udtName?}> | null | undefined}   targetSchema
 * @param {(dataType:string)=>string} [toLogical]  Dialect-specific native
 *   data_type → logical type mapper. Defaults to the Postgres mapping so
 *   existing callers are unaffected; the uploader passes driver.dataTypeToLogical
 *   so MySQL/MSSQL target schemas reconcile against their own type strings.
 * @returns {Array<{ name, type, sourceType?, targetType?, missing? }>}
 *   `type` is the EFFECTIVE type — what values will be coerced to before
 *   INSERT. `sourceType` is preserved for auditing; `missing` flags columns
 *   present in source but absent from target.
 */
function reconcileColumns(sourceColumns, targetSchema, toLogical) {
  sourceColumns = sourceColumns || [];
  toLogical = toLogical || pgDataTypeToLogical;

  if (!targetSchema || targetSchema.length === 0) {
    // No existing table → source types stand as effective.
    return sourceColumns.map(function(s) { return { name: s.name, type: s.type }; });
  }

  var targetByName = {};
  for (var i = 0; i < targetSchema.length; i++) {
    var t = targetSchema[i];
    if (INTERNAL_COLS.has(t.name)) continue;
    targetByName[t.name] = toLogical(t.dataType);
  }

  return sourceColumns.map(function(src) {
    if (INTERNAL_COLS.has(src.name)) return { name: src.name, type: src.type };
    var targetType = targetByName[src.name];
    if (targetType === undefined) {
      return { name: src.name, type: src.type, sourceType: src.type, missing: true };
    }
    // Target's type wins.
    if (targetType === src.type) return { name: src.name, type: src.type };
    return { name: src.name, type: targetType, sourceType: src.type, targetType: targetType };
  });
}

module.exports = {
  reconcileColumns:    reconcileColumns,
  pgDataTypeToLogical: pgDataTypeToLogical
};
