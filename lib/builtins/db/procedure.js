// db-procedure action — CALL a stored procedure. That is the whole job.
//
// It exists because "call this procedure" was previously only reachable
// through db-move, whose shape is "read rows from somewhere and write them
// somewhere else". That made a procedure returning nothing — a nightly
// recalculation, a rebuild, a queue drained, a flag flipped — impossible to
// run at all, because db-move requires a targetTable to put results in. The
// workaround was to name a scratch table and hope the procedure returned no
// rows, which is a costume, not a feature.
//
// Rows come back when there are rows. They are the OUTPUT of the action, not
// a movement: a caller that wants them written to a table already has db-move
// for exactly that, and db-move now calls the same builder this does (see
// drivers/db/procedure.js) rather than keeping its own copy of how a
// procedure is called in each dialect.
//
// ── returnsRows, and why it is not guesswork ─────────────────────────────
//
// On Postgres, "a procedure" is two different objects: a PROCEDURE (CALL, no
// readable result) and a set-returning FUNCTION (SELECT * FROM fn(), rows).
// Nothing about the name says which one you have, and calling the wrong form
// is an error rather than an empty result — so the caller says. The default is
// TRUE because a step that reads is the more common one and the more likely
// to be built by someone who has not thought about the distinction; a
// side-effect-only procedure is a deliberate act and can afford a checkbox.
//
// MSSQL's EXEC and MySQL's CALL cover both cases with one form, so the flag
// only changes what Postgres emits.

var dbDrivers = require('../../drivers/db');
var { buildProcedureCall } = require('../../drivers/db/procedure');

module.exports = {
  name: 'db-procedure',
  description: 'Call a stored procedure with parameters. Returns its rows when it produces any — ' +
               'no target table, no movement. For a procedure whose rows you want written to a ' +
               'table, use db-move with mode="procedure".',
  requires: [],   // per-driver requires checked at runtime once dbType is known

  inputSchema: [
    // ── WHICH DATABASE, picked rather than typed ────────────────────────
    //
    // Same shape as db-fetch and db-push, and for the same reason: this action
    // is meant to be SCHEDULED, and a job's inputs are fetched by the browser
    // on every list load and snapshotted into every occurrence row. A password
    // in there is a password everywhere, forever.
    //
    // So the form collects ids. @xeplr/jobs' resolveInputs swaps any
    // *ConnectionInfoId for real credentials server-side, immediately before
    // execute() runs, by a naming convention it applies generically
    // (connectionInfoId → connection) — no per-action wiring.
    { name: 'connectionInfoId', type: 'string', order: 1,
      optionsFrom: 'connections',
      description: 'A saved connection. Resolved to credentials server-side.' },
    { name: 'dbInfoId',         type: 'string', order: 2,
      optionsFrom: 'databases', dependsOn: 'connectionInfoId',
      description: 'Which database on that connection.' },

    // Filled by the host from the two ids above, or supplied literally by a
    // caller with no host at all — a script, a test, a standalone worker, and
    // the live probes in this repo. `system: true` keeps them out of the form
    // either way, but they must stay DECLARED: @xeplr/schema-handler drops any
    // field a schema does not mention, which would strip the resolved
    // connection on its way to execute().
    { name: 'dbType',      type: 'string', required: true, default: 'postgres', order: 3,
      system: true, options: ['postgres', 'mysql', 'mssql'],
      description: 'Taken from the connection when one is chosen.' },
    { name: 'connection',  type: 'object', required: true, order: 4,
      system: true,
      description: 'Connection config: { host, port, user, password, database }' },

    { name: 'procedure',   type: 'string', required: true, order: 5,
      optionsFrom: 'procedures', dependsOn: 'connectionInfoId',
      description: 'Procedure name, optionally schema-qualified ("dbo.usp_rebuild").' },
    // ── INCREMENTAL ─────────────────────────────────────────────────────
    //
    // The window this run covers, handed to the procedure as two of its own
    // parameters, because a procedure has no WHERE to filter from outside.
    //
    // A SCHEDULED job fills this in by itself. @xeplr/jobs' buildWindow sets
    // `from` to the job's coveredTo — where the last SUCCESSFUL run stopped,
    // not when it last ran — and `to` to a single pinned `now`, keeping
    // whatever fromParam/toParam were authored here. On success it advances
    // coveredTo to that same `to`, so a failed run leaves the coverage where
    // it was and the next run picks up the gap by itself. Set the job's
    // incrementalMode to "period" and name the two parameters here; nothing
    // else is needed.
    //
    // Half-open, from <= x < to. The next run starts at exactly this run's
    // `to`, so a procedure treating `to` as inclusive double-counts the
    // boundary row every time.
    { name: 'window',      type: 'object', order: 6, group: 'Incremental',
      description: '{ from, to, fromParam, toParam } — the period this run covers, passed as the ' +
                   'named parameters fromParam/toParam. Filled automatically for a job with ' +
                   'incrementalMode "period"; name the two parameters and leave from/to empty. ' +
                   'A window without fromParam/toParam is refused rather than silently dropped.' },

    { name: 'params',      type: 'array', order: 7,
      description: 'Parameters, as [{ name, value }] or bare values. Named entries are matched by ' +
                   'name on postgres and mssql; MySQL has no named-argument syntax, so there they ' +
                   'are positional and must be in the order the procedure declares them.' },
    { name: 'returnsRows', type: 'boolean', default: true, order: 8,
      description: 'Postgres only: true calls a set-returning FUNCTION (SELECT * FROM fn(…)), ' +
                   'false calls a PROCEDURE (CALL proc(…)) that returns nothing. Ignored for ' +
                   'mssql and mysql, whose one call form covers both.' },
    { name: 'maxRows',     type: 'number', order: 9, group: 'Performance',
      description: 'Refuse to buffer more than this many rows. Omitted = no limit. A procedure ' +
                   'that answers with a million rows is a movement, not a step output.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};

    var driver = dbDrivers.getDriver(input.dbType);
    if (!driver) throw new Error('db-procedure: no driver for "' + input.dbType + '"');

    // A job that names a connection but reaches here without one means the
    // host's resolver never ran. Said plainly, because the alternative is the
    // driver failing on an undefined host three layers down.
    if (!input.connection) {
      throw new Error('db-procedure: no connection. Choose a saved connection, or pass ' +
        '`connection` and `dbType` directly. (If this job names a connectionInfoId, the host ' +
        'has no connection resolver configured — see @xeplr/jobs init().)');
    }

    var call = buildProcedureCall({
      driver: driver,
      dbType: input.dbType,
      name: input.procedure,
      params: input.params,
      window: input.window || null,
      returnsRows: input.returnsRows
    });

    // The STATEMENT, never its parameters — same rule the move path follows.
    // A procedure's arguments can carry values out of the customer's own data
    // (a customer id, an email), and a log is not where those belong.
    if (system.log) {
      system.log('Calling ' + input.procedure + ' on ' + input.dbType + ' "' + connDbName(input.connection) + '"', {
        phase: 'call',
        event: 'procedure_started',
        procedure: input.procedure,
        dbType: input.dbType,
        database: connDbName(input.connection),
        sql: call.sql,
        paramCount: call.params.length,
        // The BOUNDS, which are configuration somebody chose rather than rows
        // out of the customer's tables — and the first thing a "why did this
        // run do nothing" question asks about. The other parameter VALUES are
        // deliberately absent; they can carry customer data.
        window: input.window
          ? { from: input.window.from || null, to: input.window.to || null,
              fromParam: input.window.fromParam || null, toParam: input.window.toParam || null }
          : null,
        // Said out loud because it is the one thing that silently does
        // something other than what the author wrote — names given to a MySQL
        // call are ignored and the order decides.
        parametersAreNamed: call.named
      });
    }
    if (system.log && input.dbType === 'mysql' && (input.params || []).some(function(p) { return p && p.name; })) {
      system.log('MySQL has no named-argument syntax — these parameters are being passed in the ' +
                 'order given, not by name. Check they match the procedure\'s declaration.', {
        phase: 'call', event: 'names_ignored', dbType: 'mysql', paramCount: call.params.length });
    }

    var pool = await driver.connect(input.connection);
    var startedAt = Date.now();
    try {
      var result = await driver.query(pool, call.sql, call.params);
      // Every driver normalises to { rows } — and a call that returns nothing
      // legitimately has none, which is a success, not an empty answer to
      // apologise for.
      var rows = (result && result.rows) || [];

      if (input.maxRows && rows.length > input.maxRows) {
        throw new Error('db-procedure: ' + input.procedure + ' returned ' + rows.length +
          ' rows, over the ' + input.maxRows + ' allowed. Use db-move to write a result this size ' +
          'to a table instead of carrying it through a step.');
      }

      if (system.log) {
        system.log('Done — ' + input.procedure + ' returned ' + rows.length + ' row(s) in ' +
          ((Date.now() - startedAt) / 1000).toFixed(1) + 's', {
          phase: 'summary', event: 'procedure_done',
          procedure: input.procedure, rows: rows.length, durationMs: Date.now() - startedAt
        });
      }

      return { rows: rows, rowCount: rows.length, procedure: input.procedure, sql: call.sql };
    } catch (err) {
      if (system.log) {
        system.log(input.procedure + ' failed: ' + err.message, {
          phase: 'summary', event: 'procedure_failed',
          procedure: input.procedure, reason: err.message, durationMs: Date.now() - startedAt });
      }
      throw err;
    } finally {
      // Always — a pooled connection left open holds sockets and keeps the
      // process alive, the same trap the SMTP transport had.
      await driver.close(pool);
    }
  }
};

/** The database name off a connection config — never the password. */
function connDbName(connection) {
  return (connection && connection.database) || '?';
}
