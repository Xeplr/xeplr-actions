// Dates and times as they move between databases — the ONE copy every driver
// uses, so no driver can quietly read a value in this machine's zone.
//
// Three logical types, and three rules:
//
//   date           a calendar day. Copied as the same day, always.
//   datetime       an INSTANT (MySQL TIMESTAMP, Postgres timestamptz, SQL Server
//                  datetimeoffset, DuckDB TIMESTAMPTZ). Copied as the same
//                  instant, in UTC.
//   localdatetime  a wall-clock reading with NO zone (MySQL DATETIME, Postgres
//                  timestamp, SQL Server datetime/datetime2, DuckDB TIMESTAMP).
//                  Copied digit for digit — 10:00 stays 10:00. What zone it was
//                  recorded in is declared later, where it is used (a cube's
//                  source timezone), never guessed here.
//
// NOTHING HERE READS THE MACHINE'S ZONE. Every Date is read with getUTC*, and a
// string without a zone is read as UTC rather than handed to `new Date()`,
// which would read it in local time. The drivers deliver values on the same
// terms: the MySQL session is pinned to UTC, the SQL Server driver to useUTC,
// Postgres returns its zoneless types as text, and DuckDB works in UTC. So a
// value here means the same thing on a server in India and one in New York —
// the tests run under both zones to keep it that way.

function pad(n, width) { return String(n).padStart(width || 2, '0'); }

function utcDate(d) {
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function utcClock(d) {
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '.' + pad(d.getUTCMilliseconds(), 3);
}

// '2025-08-01', '2025-08-01 10:00', '2025-08-01T10:00:00.123456', optionally with
// 'Z' or an offset. Captures the parts as written.
var STAMP = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * A calendar day as YYYY-MM-DD. A Date is read in UTC — every driver delivers a
 * date as midnight UTC of that day, or as text.
 */
function toDateOnly(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : utcDate(v);
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
  return m ? m[1] : v;
}

/**
 * A zoneless wall-clock time as 'YYYY-MM-DD HH:MM:SS.mmm', the digits it had.
 * A Date carries those digits in its UTC fields (that is how the drivers hand
 * one over); a string keeps its own digits, and any zone on it is dropped —
 * the column has none to keep.
 */
function toLocalDateTime(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : utcDate(v) + ' ' + utcClock(v);
  var m = STAMP.exec(String(v).trim());
  if (!m) return v;
  var ms = m[5] ? (m[5] + '00').slice(0, 3) : '000';
  return m[1] + ' ' + (m[2] || '00') + ':' + (m[3] || '00') + ':' + (m[4] || '00') + '.' + ms;
}

/**
 * An instant as a Date. A string that names its zone is read in it; one that
 * does not is read as UTC (a MySQL TIMESTAMP from a UTC session), never in this
 * machine's zone. Unreadable → null.
 */
function toInstant(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var m = STAMP.exec(String(v).trim());
  if (!m) return null;
  var iso = m[1] + 'T' + (m[2] || '00') + ':' + (m[3] || '00') + ':' + (m[4] || '00') +
    (m[5] ? '.' + (m[5] + '00').slice(0, 3) : '') + (m[6] ? normalizeZone(m[6]) : 'Z');
  var d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeZone(z) {
  if (/^z$/i.test(z)) return 'Z';
  var m = /^([+-])(\d{2}):?(\d{2})?$/.exec(z);
  return m ? m[1] + m[2] + ':' + (m[3] || '00') : 'Z';
}

/** An instant as ISO 8601 in UTC ('…Z'), or the value unchanged when unreadable. */
function toInstantIso(v) {
  if (v === null || v === undefined) return v;
  var d = toInstant(v);
  return d ? d.toISOString() : v;
}

/** An instant as 'YYYY-MM-DD HH:MM:SS.mmm' in UTC — for a column with no zone of its own (MySQL, SQL Server). */
function toInstantUtcClock(v) {
  if (v === null || v === undefined) return v;
  var d = toInstant(v);
  return d ? utcDate(d) + ' ' + utcClock(d) : v;
}

module.exports = {
  toDateOnly: toDateOnly,
  toLocalDateTime: toLocalDateTime,
  toInstant: toInstant,
  toInstantIso: toInstantIso,
  toInstantUtcClock: toInstantUtcClock
};
