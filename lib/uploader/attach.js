// attachConfig — connect an app to the shared xeplr_configs control-plane DB
// and get back a ready-to-use metaStore + ImportMeta model, in one call.
// Mirrors @xeplr/auth's attach() shape exactly (ready()/model-style getters,
// required env owned by the library, lazy + memoized) so every consuming app
// writes the SAME few lines instead of each hand-rolling its own
// bootstrapConfigDb()/bindKnex()/meta-store-knex() dance:
//
//   const { attachConfig } = require('@xeplr/actions');
//   const xcfg = attachConfig({ service: 'xeplr-bi' });   // service = this app's name
//   await xcfg.ready();
//   xcfg.metaStore       // pass into uploads/loadMapping, uploader.rollback
//   xcfg.ImportMeta      // BaseModel bound to xeplr_configs — reads/soft-deletes
//   xcfg.SERVICE_NAME    // same string, for `.where('service', ...)` filters
//   xcfg.APPLICATION_ID  // the owning APP — see options.applicationId below
//
// An EMBEDDED package passes both, because they differ: the code is
// @xeplr-workflow/api, the product is xeplr-bi.
//
//   attachConfig({ service: 'xeplr-workflow', applicationId: 'xeplr-bi' })
//
// import_meta's SCHEMA is identical for every app (see xeplr-db/config/
// migrations/0001_import_meta.js + 0002_...) — there is nothing app-specific
// about the ImportMeta model, so it lives here once instead of being
// copy-pasted into every app's models/ directory.
var { BaseModel, bootstrapConfigDb, resolveDbConnection, getApplicationId, assertApplicationIdColumns } = require('@xeplr/db');
var { decrypt } = require('@xeplr/utils/isomorphic/crypto');
var makeMetaStore = require('./meta-store-knex');

var requiredEnv = [
  'XCFG_DB_NAME',                        // xeplr_configs db name
  // XCFG_DB_CONNECTION_INFO_ENCRYPTED is deliberately NOT here any more: the
  // server login normally comes from the shared XEPLR_DB_CONNECTION, so
  // demanding the xcfg-specific name would fail a correctly configured
  // install. It still wins when set. Missing-ness is caught at the point of
  // use by resolveDbConnection, which names both variables.
];

class ImportMeta extends BaseModel {
  static get tableName() { return 'import_meta'; }
  static get idColumn() { return 'id'; }
  // xeplr_configs is opened by EVERY app, so this is one of the few tables
  // where the database is not the boundary and the column has to be — see
  // BaseModel.applicationScoped.
  static get applicationScoped() { return true; }
}

function attachConfig(options) {
  options = options || {};
  var service = options.service;
  if (!service) throw new Error('attachConfig: options.service is required');

  // The APPLICATION that owns rows written through this handle, as distinct
  // from `service` (the package writing them). They differ precisely when a
  // package is embedded: @xeplr-workflow/api running inside xeplr-bi is
  // service='xeplr-workflow', applicationId='xeplr-bi'.
  //
  // Resolved LAZILY, at ready(), not here. Every app holds its instance in a
  // module that is require()d at load time (db/xcfgSetup.js), which is before
  // registerApplication() has run — reading it now would capture null in every
  // app and quietly fall back to the package name, which is the precise bug
  // this column exists to fix. An explicit options.applicationId still wins,
  // for a caller that knows better than the process-global.
  function resolveApplicationId() {
    return options.applicationId || getApplicationId() || service;
  }

  var _ready = null;
  var _xcfg = null;
  var _boundImportMeta = null;
  var _metaStore = null;

  function ready() {
    if (!_ready) {
      _ready = (async function() {
        // XCFG_DB_CONNECTION_INFO_ENCRYPTED is an OVERRIDE — the connection
        // normally comes from the shared XEPLR_DB_CONNECTION every xeplr
        // service reads. XCFG_DB_NAME (which database) is untouched.
        var login = JSON.parse(await decrypt(resolveDbConnection('XCFG_DB_CONNECTION_INFO_ENCRYPTED'), process.env.ENCRYPTION_KEY));
        _xcfg = await bootstrapConfigDb({ connection: login, database: process.env.XCFG_DB_NAME });

        // xeplr_configs is THE shared store, so every table in it must be
        // attributable to an application. Checked on each boot rather than
        // trusted to the migration, because this database is written to by
        // several codebases and a table added by any one of them without the
        // column would go unnoticed until another app read it.
        await assertApplicationIdColumns(_xcfg.db, { database: process.env.XCFG_DB_NAME });
        _boundImportMeta = ImportMeta.bindKnex(_xcfg.db);
        _metaStore = makeMetaStore(_xcfg.db, {
          table: 'import_meta',
          service: service,
          applicationId: resolveApplicationId()
        });
        return _xcfg;
      })();
    }
    return _ready;
  }

  function requireReady(name) {
    if (!_xcfg) throw new Error('attachConfig("' + service + '"): ' + name + ' accessed before ready() resolved');
  }

  return {
    ready: ready,
    SERVICE_NAME: service,
    // A getter, for the same reason resolveApplicationId is lazy: read at
    // module load it would be the fallback, not the registered value.
    get APPLICATION_ID() { return resolveApplicationId(); },
    get metaStore() { requireReady('metaStore'); return _metaStore; },
    get ImportMeta() { requireReady('ImportMeta'); return _boundImportMeta; },
    get db() { requireReady('db'); return _xcfg.db; }
  };
}

module.exports = { attachConfig: attachConfig, requiredEnv: requiredEnv, ImportMeta: ImportMeta };
