# @xeplr/actions — map

Named-action registry + safe runner, and the built-in steps (db, file, email, http, export) that
@xeplr/jobs, @xeplr/workflow-engine, @xeplr/imports and BI run. Also the shared DB drivers, the
uploader (rows → table) and the file formats. NOT a server: no routes, no migrations, no `bin`.

## Where things are
- `index.js` — the public surface; every export points at one file below.
- `lib/registry.js` — `register()` (validates `name`, `execute`, `event`, peer `requires`), `get/has/list/clear`.
- `lib/runner.js` — `runAction()` (never throws; `applySchema` + `coerceScalars()` + `withTimeout()` + `finish()`), `previewAction()`, `PREVIEW_ROWS`.
- `lib/connections.js` — `resolveConnections()`, `connectionFieldFor()`: `*ConnectionInfoId` → `*Connection` via a host resolver.
- `lib/errors.js` — `ActionNotRegisteredError`, `ActionMissingDependencyError`, `TransientError`.
- `lib/dataDir.js` — re-export of `@xeplr/db`'s `dataDir` (XEPLR_DATA_DIR, per-tenant folders).
- `lib/fileNames.js` — `nameFrom()`, `plan()` (ifExists), `safeName()`, `nameInputs()`: how every writing action names files.
- `lib/signIn.js` — `tokenFor()`: API login/oauth2 tokens, kept in Redis (sealed) when `XEPLR_RUNS_STORE=redis`.
- `lib/builtins/index.js` — the catalogue of built-in action modules (keys like `dbMove`, `fileUpload`).
  - `builtins/db/` — `fetch.js` (db-fetch, spools NDJSON/Parquet), `push.js` (db-push), `move.js` (db-move: `fetchStream` → `upload()` in one pass, `buildSourcePlan()`), `procedure.js`, `dump.js`, `list-*.js`, `describe.js`, `columns.js`.
  - `builtins/file/` — `upload.js` (file-upload: source → format → `upload()`), `read/list/move/delete.js`, `archive.js`, `s3-upload.js`.
  - `builtins/email/*` (IMAP), `send-email.js`, `push-send.js`, `http-request.js`, `get-access-token.js`.
  - `builtins/data-operation.js` — filter/pick/compute/sort rows with @xeplr/expression-handler; `toHtml()`/`toText()`.
  - `builtins/export/table.js` (rows → csv/xlsx/pdf/parquet via `formats/writers`), `export/pages.js` (placed blocks → PDF).
  - `builtins/db/query.js`, `spawn-program.js` — comment-only placeholders (export `{}`).
- `lib/drivers/db/index.js` — `getDriver(type)`, `checkDriverRequires()`; `postgres|mysql|mssql|duckdb` (+ `mongo` stub).
  - `postgres.js`, `mysql.js`, `mssql.js`, `duckdb.js` — one common interface: `connect/query/close`, `fetchStream()` (async generator), `build*Sql()`, `coerceValue()`, `getTableSchema()`, `list*()`, `describeDatabase()`, `ensureMovementColumn/ensureUpsertIndex`, `rollbackMovement()`, staging hooks.
  - `stop.js` — `watch(signal, timeoutMs, cancel)`, `throwIfStopped()`, `QUERY_STOPPED`/`QUERY_TIMEOUT` errors.
  - `staging.js` — `stagingFor(dialect)`: staged Replace for pg/mysql/mssql. DuckDB has its own `prepareStaging/mergeStaged/committedMovement` in `duckdb.js`.
  - `procedure.js` — `buildProcedureCall()`, the only place that knows how a procedure is called (db-procedure and db-move).
  - `dateValues.js` (date/localdatetime/instant, all UTC), `describe.js` (`assemble()`), `errorRows.js`, `foreignKeys.js`, `internalTables.js` (`isInternalTable/Column`).
- `lib/drivers/file/` — `getSource()`; only `local.js` real, `sftp/sharepoint/google` stubs.
- `lib/drivers/email/` — `getInboundProvider()` (imap), `getOutboundProvider()` (smtp), `config.js` (IMAP_* env), `files.js`.
- `lib/uploader/index.js` — `upload()`, `rollback()`, `wasCommitted()`, `compareToTable()`, `checkMode()` (MODES), `watchWrites()`.
  - `infer.js` (`inferColumns`), `reconcile.js` (`reconcileColumns`, target types win), `meta-store-knex.js` (import_meta), `meta-store-noop.js`, `attach.js` (`attachConfig()` → xeplr_configs, `requiredEnv`).
- `lib/streaming/` — `spool.js` (`spool()`: rows → rotating NDJSON batches → target hooks; `readBatchFile`), `checkpoint.js`, `resume.js`, `utils.js`.
- `lib/formats/index.js` — `getFormat()`, `columnsOf()`, `scanPastedRows()`, `estimateRows()`; readers `csv/excel/json/parquet` (+ `_xlsx-stream.js`, `txt` stub).
  - `pastedRows.js` (Excel cells that swallowed rows), `parquet.js` (`open/writeAll/readRows/columnsOf` through DuckDB), `queryToParquet.js` (`writeQuery()`, pg COPY / DuckDB straight to Parquet), `writers/` (csv, xlsx, pdf, parquet).
- `scripts/upload-file.js` — dev CLI, not published.

## Flow
- Run: host `register(builtins.x)` → `runAction({ name, input, system })` → `coerceScalars` → `applySchema` (drops undeclared fields) → `def.execute({ input, system, metaStore })` → `{ status, output, error, durationMs }`.
- db-move: `builtins/db/move.js execute` → `getDriver(src/target)` → `buildSourcePlan()` (table / query / `procedure.buildProcedureCall`) → `src.fetchStream({ signal: system.signal })` → `uploader.upload()` → `streaming.spool` → `SqlQueue` → `target.buildInsertSql` → `metaStore.recordEnd`.
- file-upload: `file/upload.js` → `drivers/file.getSource('local')` → `formats.getFormat(fmt)` → (`expandPastedRows`) → `upload()`.
- upload(): `normalizeOptions` → `checkMode` (TARGET_REFUSED) → `runBootstrap` (create/alter, staging) → spool batches → `enqueueBatch` → `SqlQueue` (@xeplr/utils, bisects a failed batch; refused rows → `recordRefusedRows` → `<t>_import_errors`) → staged `mergeStaged` in one transaction.

## To change X, edit Y
- Add a built-in action → new file under `lib/builtins/` exporting `{ name, inputSchema, execute, preview?/example? }` + a key in `lib/builtins/index.js` + README "Built-in actions".
- Add a DB engine → new `lib/drivers/db/<type>.js` with the full interface + `DRIVERS` in `drivers/db/index.js`; staged Replace via `staging.stagingFor()`; add `stop.<type>.test.js`.
- Type mapping for created columns → driver's `TYPE_MAP` / `dataTypeToLogical()`; inference → `uploader/infer.js`; existing-table reconciliation → `uploader/reconcile.js`.
- How a query is stopped/time-limited on an engine → that driver's `query()`/`fetchStream()` + `stop.watch()` (pg `cancelBackend`, mysql `killQuery`, mssql `request.cancel`, duckdb `interrupt`).
- Read-only behaviour for user SQL → driver `connect()` (`readOnly`) and `query()`.
- Date/time handling across zones → `drivers/db/dateValues.js` (never per-driver).
- Import modes new/append/replace → `uploader/index.js` `MODES`, `checkMode()`; staging → `drivers/db/staging.js` or `duckdb.js mergeStaged()`.
- A new file format to read → `lib/formats/<fmt>.js` + `FORMATS` in `formats/index.js`; to write → `formats/writers/` + `writers/index.js`.
- Output file naming / name-taken rule → `lib/fileNames.js`.
- Procedure call syntax → `drivers/db/procedure.js buildProcedureCall()`.
- Saved-connection swap → `lib/connections.js`; token login → `lib/signIn.js`.
- import_meta columns → `uploader/meta-store-knex.js` (table itself is created by `@xeplr/db` config migrations).
- Rows-between-steps step → `builtins/data-operation.js`.

## Rules and traps
- `applySchema` strips undeclared input; host-filled fields (`connection`, `dbType`) must stay declared (`system: true`) or they vanish before `execute`.
- Every new query path takes `signal` + `timeoutMs` and passes them to the driver; the cancel must reach the DB (workspace CLAUDE.md "No query runs that nobody needs"). Tests check `pg_stat_activity` / `sys.dm_exec_requests` / processlist.
- Peer deps (`pg`, `mysql2`, `mssql`, `@duckdb/node-api`, `imapflow`, `nodemailer`, `fflate`, `pdfkit`, aws-sdk) are lazy: `requires` on the driver/format, checked at run (`checkDriverRequires`, `checkFormatRequires`). Never `require` them at module top.
- DuckDB: read-only unless `access: 'rw'`; UTC always; read-write open runs CHECKPOINT, drops all indexes, refuses CREATE INDEX (`guardOnOpen`, `refuseIndex`) — README "A written DuckDB file keeps no index". Values come out plain (`plainDeep`, no BigInt).
- Framework columns `__xeplr_id__`, `__xeplr_movement_id__` and tables `_import_errors`, `__xeplr_staging`, `__xeplr_loads` are never carried to another table; keep `internalTables.js` and `reconcile.js INTERNAL_COLS` in step.
- Rollback refused for upsert movements and for Replace; `upsert` without `primaryKeys` refused. Half-open windows `from <= x < to`.
- Batch size capped by driver `maxParams` (`safeBatchSize`). Logs never carry row values.
- Files only under `dataDir` (tenant from context, never from input); `meta-store-knex` needs `service` + `applicationId` (xeplr_configs is application-scoped).
- Message ids are folder-scoped and change on move: move the mail last.
- Backend style: `var`, CommonJS, timers `.unref()` (see `stop.watch`).

## Test
- `npm test` = `node --test --test-concurrency=1 --require ./test/setup-data-dir.cjs "test/**/*.test.js"`. `setup-data-dir.cjs` makes a temp XEPLR_DATA_DIR and registers app `xeplr-actions-test`.
- DB suites read `PG_*`, `MYSQL_*`, `MSSQL_*` (HOST/PORT/USER/PASSWORD) via `test/helpers/databases.js testWith()`: unset HOST = skipped, set but refused = fail. Local: `PG_HOST=localhost PG_PORT=5432 PG_USER=vikasbhandari PG_PASSWORD= MSSQL_HOST=127.0.0.1 MSSQL_PORT=1433 MSSQL_USER=sa MSSQL_PASSWORD=<ask the user> npm test`. They share database `xeplr_actions_test` (hence concurrency 1).
- Exceptions: `test/list-columns-length.test.js` (`XEPLR_TEST_PG_URL`, `MYSQL_TEST_URL`, `MSSQL_TEST_URL`), `test/readonly-connections.test.js` (`PGHOST`…); `test/db-move.live.js` is manual, not in `npm test`.
- Coverage: `test/drivers/*` (per engine, `stop.*.test.js` = DB-side cancel), `test/uploader/*`, `import-modes`, `staged-load`, `duckdb-index-guard` (kills a real writer), `formats/*`, `builtins/*`, `data-dir.test.js` (tenant isolation), `dates-across-zones`.
