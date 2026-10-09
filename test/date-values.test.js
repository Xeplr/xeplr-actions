// The three date rules, in the one helper every driver uses — and never the
// machine's zone. dates-across-zones.test.js proves them through real moves;
// this proves the helper itself, with no database, under two zones.
var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var child = function() {
  var dv = require(process.env.DV);
  console.log(JSON.stringify({
    dateFromUtcMidnight: dv.toDateOnly(new Date(Date.UTC(2026, 0, 5))),
    dateFromText: dv.toDateOnly('2026-01-05'),
    dateFromStamp: dv.toDateOnly('2026-01-05 23:30:00'),
    localFromText: dv.toLocalDateTime('2026-01-05 10:00:00'),
    localFromIso: dv.toLocalDateTime('2026-01-05T10:00:00.5'),
    localDropsZone: dv.toLocalDateTime('2026-01-05T10:00:00+05:30'),
    localFromDate: dv.toLocalDateTime(new Date(Date.UTC(2026, 0, 5, 10, 0, 0))),
    instantNoZoneIsUtc: dv.toInstantIso('2026-01-05 10:00:00'),
    instantWithOffset: dv.toInstantIso('2026-01-05 15:30:00+05:30'),
    instantCompactOffset: dv.toInstantIso('2026-01-05T15:30:00+0530'),
    instantForMysql: dv.toInstantUtcClock('2026-01-05T15:30:00+05:30'),
    unreadable: dv.toInstantIso('not a date'),
    nulls: [dv.toDateOnly(null), dv.toLocalDateTime(undefined), dv.toInstant(null)]
  }));
};

function runIn(tz) {
  var r = spawnSync(process.execPath, ['-e', '(' + child.toString() + ')()'],
    { env: Object.assign({}, process.env, { TZ: tz, DV: path.join(__dirname, '../lib/drivers/db/dateValues') }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('dates, zoneless and zoned date-times — the same answers in India and in New York', function() {
  var a = runIn('Asia/Kolkata');
  assert.deepStrictEqual(a, {
    dateFromUtcMidnight: '2026-01-05', dateFromText: '2026-01-05', dateFromStamp: '2026-01-05',
    localFromText: '2026-01-05 10:00:00.000', localFromIso: '2026-01-05 10:00:00.500',
    localDropsZone: '2026-01-05 10:00:00.000', localFromDate: '2026-01-05 10:00:00.000',
    instantNoZoneIsUtc: '2026-01-05T10:00:00.000Z', instantWithOffset: '2026-01-05T10:00:00.000Z',
    instantCompactOffset: '2026-01-05T10:00:00.000Z', instantForMysql: '2026-01-05 10:00:00.000',
    unreadable: 'not a date', nulls: [null, null, null]
  });
  assert.deepStrictEqual(runIn('America/New_York'), a);
});
