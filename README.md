# @xeplr/actions

**A registry of named actions with typed inputs, a runner that never throws, and the built-in actions xeplr uses to move data and handle mail.** An action is `{ name, inputSchema, execute }`; `runAction` validates the input against the schema, calls `execute`, and hands back `{ status, output, error, durationMs }`.

Use it directly for one-off programmatic runs, or through [`@xeplr/jobs`](https://www.npmjs.com/package/@xeplr/jobs) (scheduled and manual runs) and workflow steps, which look actions up by name. The built-ins cover database reads, writes and movements across Postgres, MySQL, SQL Server and DuckDB, stored procedures, CSV/Excel/JSON file loads, and IMAP/SMTP email. The primitives underneath — the uploader, spool, drivers and parsers — are exported for code that needs them without an action around them.

## Install

```sh
npm i @xeplr/actions @xeplr/db @xeplr/utils
```

`require('@xeplr/actions')` loads `@xeplr/db` and `@xeplr/utils` at load time (via `attachConfig` and the db/file built-ins), so both must be installed. `@xeplr/db` is not declared in `package.json`; `@xeplr/utils` is declared as an optional peer. Dependency: `@xeplr/schema-handler`.

Everything else is an **optional peer**, required only when an action actually uses it:

| peer | needed for |
|---|---|
| `pg` | `dbType: 'postgres'` |
| `mysql2` | `dbType: 'mysql'` |
| `mssql` | `dbType: 'mssql'` |
| `@duckdb/node-api` (1.5.5-r.3) | `dbType: 'duckdb'` |
| `csv-parse` | `format: 'csv'` |
| `unzipper`, `saxes` | `format: 'excel'` (.xlsx) |
| `imapflow` | every inbound email action |
| `mailparser` | `email-read` (unless `body: 'none'`), `email-download-attachments` |
| `nodemailer` | `email-send` with its own connection |
| `@xeplr/email` | `email-send` with `templateName` |
| `knex` | the knex meta store |
| `mongodb`, `ssh2-sftp-client`, `exceljs` | declared, but their drivers/sources are not implemented |

A missing peer fails with the `npm install …` line to run, when the action runs (or at `register()` for an action's own `requires`).

## Quick start

```js
var actions = require('@xeplr/actions')

// Your own action
actions.register({
  name: 'say-hello',
  description: 'Greets someone',
  inputSchema: [{ name: 'who', type: 'string', required: true }],
  execute: async function ({ input, system }) { return { said: 'hello ' + input.who } }
})

var result = await actions.runAction({ name: 'say-hello', input: { who: 'Ada' } })
// { status: 'success', output: { said: 'hello Ada' }, error: null, durationMs: 1 }

// A built-in, without registering it
var moved = await actions.runAction(actions.builtins.dbMove, {
  sourceDbType: 'postgres', sourceConnection: { host, port, user, password, database: 'app' },
  table: 'orders',
  targetDbType: 'postgres', targetConnection: { host, port, user, password, database: 'warehouse' },
  targetTable: 'orders_copy',
  writeMode: 'upsert', primaryKeys: ['id'],
  window: { column: 'updated_at', from: '2026-08-01', to: '2026-09-01' }
})
```

## API

| export | what |
|---|---|
| `register(def)` / `register(name, def)` | Add an action. Throws without `name` or `execute`, or with a `requires` module that is not installed (`ActionMissingDependencyError`). Re-registering a name replaces it. |
| `get(name)` / `has(name)` | Look one up. |
| `list()` | `[{ name, description, inputSchema, outputSchema, requires }]` — serializable, for an actions endpoint. |
| `clear()` | Empty the registry. |
| `runAction({ name, input, system?, timeoutMs? })` | Run a registered action. Never throws. |
| `runAction(nameOrDef, input, { system, timeoutMs, metaStore }?)` | Same, by name or with an action module directly. |
| `ActionNotRegisteredError` | Returned (in `error`) for an unknown name. |
| `ActionMissingDependencyError` | Thrown by `register()` for a missing `requires` module. |
| `TransientError` | For an action to signal "retry me". Nothing in this package (or `@xeplr/jobs`) acts on it yet. |
| `builtins` | The built-in action modules — see [Built-in actions](#built-in-actions). |
| `uploader` | `{ upload, rollback, inferColumns, inferColumnType, makeMetaStore }` — see [Uploader](#uploader). |
| `inferColumns(rows)` | `[{ name, type }]` from sample rows. |
| `streaming` | `{ spool, resume, readBatchFile, checkpoint }` — rows to rotating NDJSON batch files with ordered hooks and resumable checkpoints. |
| `drivers.db` | `{ getDriver(type), checkDriverRequires, SUPPORTED }` — `postgres`, `mysql`, `mssql`, `mongo`, `duckdb`. |
| `drivers.file` | `{ getSource(type), checkSourceRequires, SUPPORTED }` — `local`, `sharepoint`, `google`, `sftp`. |
| `formats` | `{ getFormat(type), checkFormatRequires, SUPPORTED }` — `excel`, `csv`, `txt`, `json`. |
| `attachConfig({ service, applicationId? })` | Connect to the shared `xeplr_configs` database; see [Movement metadata](#movement-metadata-xeplr_configs). |
| `configRequiredEnv` | `['XCFG_DB_NAME']` — spread into your app's required-env list. |

### An action

| field | |
|---|---|
| `name` | Required. |
| `description` | Text for pickers. |
| `inputSchema` | `[{ name, type, required, default, description, order, ... }]`, validated by `@xeplr/schema-handler` `applySchema`. Built-ins also use `group`, `showWhen`, `system`, `options`, `optionsFrom`, `dependsOn` — hints for a form; validation treats every field the same. |
| `outputSchema` | Optional documentation of the return value. |
| `requires` | Module names checked with `require.resolve` at `register()`. |
| `execute({ input, system, metaStore })` | Returns (or resolves to) the output. |

### `runAction` result

```js
{ status: 'success' | 'failed', output, error: { name, message, stack?, details?, actionName? } | null, durationMs }
```

An unknown action, invalid input, a thrown or rejected `execute`, and a timeout (`timeoutMs`, message `Action timed out after Nms`) all come back as `status: 'failed'`. A timeout does not cancel the running work.

## Built-in actions

Register the ones you want (`register(actions.builtins.dbFetch)`) or pass a module straight to `runAction`. `@xeplr/jobs` registers all implemented ones except `spawnProgram` and `dbMove`.

| key | action name | does |
|---|---|---|
| `dbFetch` | `db-fetch` | Stream rows from a table (`mode: 'table'`) or SQL (`mode: 'query'`, `params`). Default `streaming_mode: true` → NDJSON file `{ filePath, format: 'jsonl', bytes, rows }`; `false` → `{ rows, rowCount }`. |
| `dbPush` | `db-push` | Write `rows` or an NDJSON `filePath` into `targetTable` through the uploader. `primaryKeys` → upsert. |
| `dbMove` | `db-move` | One window of rows from a source table, query or procedure into a target table in one streamed pass. See [db-move](#db-move). |
| `dbProcedure` | `db-procedure` | Call a stored procedure; returns `{ rows, rowCount, procedure, sql }`. See [db-procedure](#db-procedure). |
| `dbListTables` | `db-list-tables` | `{ tables }` — base tables in a schema/database. |
| `dbListViews` | `db-list-views` | `{ views }`. |
| `dbListProcedures` | `db-list-procedures` | `{ procedures }` (functions excluded). |
| `dbListColumns` | `db-list-columns` | `{ columns }` — name and data type for one table. |
| `fileUpload` | `file-upload` | Read a file (`sourceType`, `sourcePath`), parse it (`format`), load it into `targetTable` (`dbType`, `dbConnection`). |
| `sendEmail` | `email-send` | Send one message. See [Email](#email). |
| `emailRead` | `email-read` | List messages, newest first, with `unread_only`, `limit` (1–1000, default 50), `since`, `from_equals`, `from_contains`, `subject_contains`, `body: 'full' \| 'text' \| 'none'`, optional NDJSON spooling. |
| `emailMove` | `email-move` | Move a message (`messageId`, `folder`) to `toFolder`. |
| `emailDelete` | `email-delete` | Flag `\Deleted` **and expunge** — permanent, not a move to Trash. |
| `emailDownloadEmail` | `email-download-email` | Stream the raw message to an `.eml` file. `{ count, saved[], path }`. |
| `emailDownloadAttachments` | `email-download-attachments` | Save attachments, optionally filtered by `extension` / `filenameContains`. `{ count, saved[], path, skipped }`. |
| `httpRequest`, `spawnProgram`, `dbQuery`, `fileMove` | — | **Placeholders.** Empty modules with no `name` or `execute`; `register()` rejects them. |

### Connections

The db actions `db-fetch`, `db-push` and `db-procedure` accept a connection two ways:

- `connectionInfoId` (+ `dbInfoId`) — ids of a saved connection. The action does not resolve these; a host does, before `runAction` (e.g. `@xeplr/jobs` `resolveConnection`, which turns `connectionInfoId` into `connection` and `dbType`).
- `connection: { host, port, user, password, database }` and `dbType` — literal, for scripts, tests and callers with no host.

`db-move` takes literal `sourceConnection` / `targetConnection`; `file-upload` takes `dbConnection`. A DuckDB connection is `{ file, access?: 'ro' | 'rw', openTimeoutMs?: 60000, maxConnections?: 4 }`.

### db-move

| input | meaning |
|---|---|
| `mode` | `table` (default) → `SELECT … FROM table`; `query` → `SELECT … FROM (sql) AS __src`; `procedure` → `sql` is the procedure name. |
| `columns` | `[{ from, to }]`. For table/query this becomes `SELECT "from" AS "to"`; for a procedure rows are renamed in JS and **unmapped columns are dropped**. Omitted = all columns. |
| `writeMode` | `append` (default), `replace` (TRUNCATE the target first if it exists, DELETE if TRUNCATE fails), `upsert` (**requires** `primaryKeys`). |
| `window` | `{ column, from, to }` → `column >= from AND column < to` (a null edge is left out). `{ columns: [{ column, from }] }` → OR of `column >= from` (null `from`s left out). For a procedure: `{ from, to, fromParam, toParam }`, passed as parameters. A window with none of `column`, `columns`, `fromParam`, `toParam` is treated as no window. |
| `where` | Raw SQL condition, ANDed with the window in parentheses, run on the source. Not parameterised. Ignored for `mode: 'procedure'`. |
| `movementId` | Correlation key. Default `system.occurrenceId`, else `mv_<id>`. |
| `batchSize`, `concurrency` | Default 5000 and 4. |

For `mode: 'table'` the source's declared column types (`getTableSchema`) are passed to the uploader instead of inferring from values. Returns the uploader result plus `{ movementId, writeMode, truncated, window, sourceSql }`. If `system.log(message, meta)` is supplied it receives one line per step (source, target, columns, write mode, window, SQL, each failed batch with a sample row's primary key, and a summary) — identifiers and counts only, never parameter values or row contents. `system.onProgress` is forwarded to the uploader.

### db-procedure

| dbType | statement |
|---|---|
| `mssql` | `EXEC name @param = …` |
| `mysql` | `CALL name(?, ?)` — positional; names are ignored (and logged as such) |
| `postgres` | `SELECT * FROM fn(param => …)` when `returnsRows` (default `true`), `CALL proc(param => …)` when `false` |

`params` is `[{ name, value }]` or bare values; values are always bound. `''` becomes `null`, integer- and decimal-looking strings become numbers, and an object value is an error naming the parameter. A schema-qualified name (`dbo.usp_x`) is quoted per part. `window: { from, to, fromParam, toParam }` appends the two bounds as parameters after `params` (null edges passed as `NULL`); a window without `fromParam`/`toParam` is refused. `maxRows` fails the run when more rows come back. If `system.log` is supplied it gets the statement, parameter count and window bounds — not the other parameter values.

### Email

`useCustomConnection` (default `false`) decides where the mailbox comes from:

| | inbound (`email-read`, `-move`, `-delete`, `-download-*`) | outbound (`email-send`) |
|---|---|---|
| `false` | IMAP from environment variables (below) | `@xeplr/utils` `sendEmail` — the install's configured sender. Accepts only `to`, `subject`, `html`, `cc`, `attachments`; `text`, `bcc`, `from` or `replyTo` are **refused**, and `html` is required. |
| `true` | `connection: { host, port, secure, user, password, tls? }` | `connection: { host, port, secure, user, password, from, replyTo, envelopeFrom, tls? }` via `nodemailer`. Returns `{ sent, messageId, accepted, rejected, response }`. A fresh transport per send. |

`email-send`: `to` / `cc` / `bcc` accept a bare string. `templateName` + `templateVars` render a stored template via `@xeplr/email` (the host must have called its `initTemplates()`), replacing any subject, html and text on the step. Attachments are nodemailer descriptors, so `saved[]` from `email-download-attachments` can be passed straight in.

Message ids are IMAP UIDs **scoped to `folder`**, and a move changes the id — download and delete before moving.

## Uploader

`uploader.upload(opts)` is what `db-push`, `db-move` and `file-upload` use:

```js
await actions.uploader.upload({
  source,                 // async iterable of row objects
  driver,                 // actions.drivers.db.getDriver('postgres')
  connection,             // config object or an open pool
  targetTable, movementId,
  queue,                  // a SqlQueue from @xeplr/utils/lib/queue
  primaryKeys,            // optional → upsert
  columns,                // optional [{ name, type }] — declared; skips inference
  batchSize: 5000, firstBatchScanRows: 1000,
  metaStore, mtId1, mtId2, mtId3, mtId4, details,
  errorTable, batchDir, keepBatchFiles, onProgress
})
// → { movementId, tables: { main, errors }, columns, totalRows, totalBatches, completed, dropped, aborted, durationMs }
```

Rows are spooled to NDJSON files on disk between source and database. From the first batch it creates, if missing: the target table, `<targetTable>_import_errors` (`movement_id`, `row_num`, `error_description`, `underlying_sql`, `raw_row`, `recorded_at`), a `__xeplr_movement_id__` column, and a unique index on `primaryKeys`. Server dialects also add `__xeplr_id__`; DuckDB does not.

Logical types and what each driver creates:

| type | postgres | mysql | mssql | duckdb |
|---|---|---|---|---|
| string | TEXT | LONGTEXT | NVARCHAR(MAX) | VARCHAR |
| number | NUMERIC | DECIMAL(38,10) | DECIMAL(38,10) | DOUBLE |
| boolean | BOOLEAN | TINYINT(1) | BIT | BOOLEAN |
| date | DATE | DATE | DATE | DATE |
| datetime | TIMESTAMPTZ | DATETIME(6) | DATETIME2 | TIMESTAMPTZ |
| object / array | JSONB | JSON | NVARCHAR(MAX) | JSON |

Inference (`inferColumns`): any array → `array`; any object → `object`; all `Date` or ISO-date strings → `datetime`; all booleans → `boolean`; all numbers → `number`; anything else, or all null → `string`.

`uploader.rollback({ movementId, driver, connection, targetTable, metaStore?, queue? })` aborts the movement's queued work, deletes its rows from the target and error tables by `__xeplr_movement_id__` / `movement_id`, and records `rolled-back`.

### Formats and file sources

| format | reads | notes |
|---|---|---|
| `csv` | stream | `formatConfig`: `columns` (default first row), `delimiter` (`,`), `cast` (true), `skipEmptyLines`, `trim`. |
| `excel` | file path | `.xlsx` via `unzipper` + `saxes`; `sheet`, `startRow`. Date-styled cells arrive as `Date`. |
| `json` | stream | A JSON array or NDJSON; buffers the whole file. |
| `txt` | — | Placeholder, not implemented. |

File sources: only `local` is implemented (`path`). `sftp`, `sharepoint` and `google` are placeholders.

## Movement metadata (`xeplr_configs`)

Pass a `metaStore` and each upload records a row in `import_meta`: start, running counters, end status, columns, primary keys, tenant ids and `details`.

```js
var xcfg = actions.attachConfig({ service: 'xeplr-workflow', applicationId: 'xeplr-bi' })
await xcfg.ready()
await actions.runAction(actions.builtins.dbPush, input, { metaStore: xcfg.metaStore })
// xcfg.ImportMeta — BaseModel bound to xeplr_configs; xcfg.db — its knex; xcfg.SERVICE_NAME; xcfg.APPLICATION_ID
```

`ready()` connects through `@xeplr/db` `bootstrapConfigDb` and checks every table there has an `applicationId` column (`assertApplicationIdColumns`). `applicationId` defaults to the application registered with `@xeplr/db`, else `service`, and is read at `ready()`, not at `attachConfig()`.

`uploader.makeMetaStore(knex, { table: 'import_meta', service, applicationId })` builds the same store on your own knex. Without a `metaStore` nothing is recorded.

## Environment variables

| name | required? | meaning |
|---|---|---|
| `XEPLR_ACTIONS_TMP_DIR` | no | Where `db-fetch` and `email-read` spool NDJSON, email downloads go (unless `outDir`), and the uploader spools batches. Default `<os.tmpdir()>/xeplr-actions`. Files are not cleaned up by `db-fetch` or `email-read`. |
| `XCFG_DB_NAME` | for `attachConfig` | The `xeplr_configs` database name. In `configRequiredEnv`. |
| `XCFG_DB_CONNECTION_INFO_ENCRYPTED` | no | Encrypted server login for `attachConfig`; overrides `XEPLR_DB_CONNECTION`. |
| `XEPLR_DB_CONNECTION` | for `attachConfig`, unless the above is set | Shared encrypted server login. |
| `ENCRYPTION_KEY` | for `attachConfig` | Decrypts the connection string. |
| `IMAP_HOST` / `IMAP_USER` / `IMAP_PASS` | for inbound email without `useCustomConnection` | Mailbox login. Each falls back to `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS`. Missing → error with code `EMAIL_SYSTEM_NOT_CONFIGURED`. |
| `IMAP_PORT` | no | Default 993. |
| `IMAP_SECURE` | no | Default `true` (`1/true/yes/on`, `0/false/no/off`). |
| `IMAP_CONNECTION_TIMEOUT`, `IMAP_SOCKET_TIMEOUT` | no | Milliseconds, passed to `imapflow`. |
| `IMAP_TLS_REJECT_UNAUTHORIZED`, `IMAP_TLS_SERVERNAME` | no | TLS options. |

Outbound mail without `useCustomConnection` reads no variables here — it uses whatever `@xeplr/utils` / `@xeplr/email` were configured with.

## Routes, migrations, CLI

None published. The package has no HTTP routes (a host serves `list()`, e.g. `@xeplr/jobs` `GET /actions`), no migrations (the `import_meta` table is created by `@xeplr/db`'s config migrations) and no `bin`.

The repository has `scripts/upload-file.js` (not in the npm package) — a CLI that loads a CSV or Excel file into Postgres with `file-upload`; its header documents the flags (`--file`, `--table`, `--conn-name`, `--conn`, `--host`/`--port`/`--db`/`--user`/`--password`, `--encrypt-conn`).

## Read-only connections — for SQL you did not write

A report preview, a user's query, anything whose SQL text came from outside your own code: connect with `readOnly: true`.

```js
const pool = await driver.connect({ ...connection, readOnly: true })
await driver.query(pool, userSql, params)          // reads only
```

| Driver | What `readOnly` does |
|---|---|
| postgres | every `query` and `fetchStream` runs inside `BEGIN TRANSACTION READ ONLY`, always rolled back, over the **extended protocol** — one statement only, so `…; COMMIT; DROP TABLE t` is refused, and nothing inside can switch the transaction back to read-write |
| mysql | every connection the pool opens is set to `TRANSACTION READ ONLY`; `multipleStatements` stays off, so one statement per query |
| mssql | `readOnlyIntent` (routes to a readable secondary where one exists) — **not enforcement**: SQL Server runs whole batches and has no session read-only mode. Give such SQL a login with only `db_datareader` |
| duckdb | read-only unless `access: 'rw'` |

**Values are bound, never written into SQL.** On MySQL, `stringifyObjects` is always on, so an object or array passed as a value is compared as text instead of being expanded into `key = value` pairs. **Procedure parameter names** are written into the call (`@region = @p0`, `region => $1`) and must be plain names — letters, digits and `_`.

## Rules the code enforces, and why

| rule | why |
|---|---|
| `runAction` never throws; every failure is a `failed` result. | Schedulers and workflow engines record the outcome instead of crashing on it. |
| Input is validated by `applySchema`, which **drops fields the schema does not declare**. That is why `connection` and `dbType` stay declared (as `system: true`) even when a host fills them. | Otherwise a resolved connection would be stripped on its way to `execute`. |
| A scalar given for an `array` field becomes a one-element array. Objects, `null`, `undefined` and `''` are left alone; JSON-looking strings are not parsed. | A bound reference such as `{params.email}` interpolates to a string; without this every array input was unbindable. |
| Peer dependencies are lazy: checked when an action runs with a given `dbType`, `format`, `sourceType` or email path. | A deployment installs only the drivers it uses. |
| Saved connection ids are for forms; literal credentials are for scripts. | Job inputs reach the browser and are copied into every run record, so a password there is everywhere. |
| `db-fetch` streams to disk by default; `streaming_mode: false` only for small reads. | Bounded memory at both ends for cross-engine replication. |
| **Half-open windows** (`from <= x < to`), no +1 second. | Consecutive windows meet exactly; closed windows move the boundary row twice. |
| `db-move` `upsert` without `primaryKeys` is refused, not downgraded to append. | A silent append is a duplicate every run, found a week later. |
| `replace` truncates before reading; on failure the target stays empty. | Accepted trade against keeping a second copy of the data. |
| A procedure call with a window but no `fromParam`/`toParam` is refused (`db-procedure`, and the shared builder `db-move` uses). | A procedure cannot be filtered from outside; dropping the window would reprocess its whole history every run while reporting success. |
| `db-move` uses the source table's declared types for `mode: 'table'`. | Inference is lossy: Postgres `numeric` arrives as a string and would create a TEXT column; an all-null sample becomes text; `'007'` loses its zeros. |
| Target types win over source types; a source column missing from an existing target **fails** the upload. | The existing table is authoritative; the fix is an explicit ALTER. |
| Batch size is capped by the driver's parameter limit (Postgres 30,000, MySQL 60,000, SQL Server 2,000). | Protocol limits: 65,535 params in Postgres; 2,100 params and 1,000 rows per statement in SQL Server. |
| **Rollback is refused for a movement that used `primaryKeys`.** | Upsert stamps the movement id on rows it only updated, so deleting by it would remove rows that already existed. |
| Movement logs carry identifiers, counts, SQL and the error text — never parameter values or row contents; a failed batch shows one row's primary key, not its data. | Logs are copied into tickets and chats. |
| DuckDB opens **read-only unless the call says `access: 'rw'`**; no environment variable can grant write. A file already open read-only in the process refuses a write. Opening waits on the lock (`openTimeoutMs`, default 60 s). | One read-write process locks every other process out, even readers. Write access belongs at the call site that writes. |
| `meta-store-knex` requires `service` and `applicationId`, and scopes every statement by `applicationId`. | `import_meta` is shared by every app; unattributed rows, or a rollback decided from another app's row, are worse than refusing. |
| Mail filenames are sanitised (`[^\w.-]` → `_`, all-dot names → `attachment`, max 180 chars) and prefixed with a random id. | Attachment names come from the sender and could escape the output directory; common names collide. |
| The system mail sender refuses `text`, `bcc`, `from`, `replyTo` rather than dropping them. | A silently lost bcc is a compliance problem found a year later. |
| `email-send` returns both `accepted` and `rejected`. | SMTP accepts per recipient; a "success" can drop half of them. |

## Tests

There is no `npm test` script. The tests use `node:test`; run a file directly:

```sh
node --test test/uploader/reconcile.test.js
```

| needs nothing | needs a database |
|---|---|
| `test/procedure-call.test.js`, `test/streaming/spool.test.js`, `test/uploader/reconcile.test.js`, `test/formats/csv-gnarly.test.js`, `test/drivers/mysql.test.js`, `test/drivers/mssql.test.js`, `test/drivers/query-columns.test.js`, `test/builtins/email.test.js` (loads the package root, so `@xeplr/db` must be resolvable) | Postgres at `localhost:5435` (`PG_PASSWORD`, default `postgres`; database `xeplr_actions_test`): `test/drivers/postgres.test.js`, `test/builtins/db-push.test.js`, `test/builtins/file-upload.test.js`, `test/uploader/upload.test.js`; plus `@xeplr/db` for `test/uploader/meta-store-knex.test.js` |
| `test/drivers/duckdb.test.js` (needs `@duckdb/node-api`) | MySQL `localhost:3306` (`MYSQL_HOST/PORT/USER/PASSWORD`): `test/drivers/mysql-integration.test.js` |
| | SQL Server `localhost:1433` (`MSSQL_HOST/PORT/USER/PASSWORD`): `test/drivers/mssql-integration.test.js` |
| | Postgres + MySQL + SQL Server (`PG_*`, `MYSQL_*`, `MSSQL_*`): `test/builtins/db-replication.test.js` |

`test/db-move.live.js` runs against a developer's own `.env` path and is not a portable test. CI (`.github/workflows/ci.yml`) skips tests when there is no `test` script.

## License

MIT
