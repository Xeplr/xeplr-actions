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
//   xcfg.metaStore     // pass into uploads/loadMapping, uploader.rollback
//   xcfg.ImportMeta    // BaseModel bound to xeplr_configs — reads/soft-deletes
//   xcfg.SERVICE_NAME  // same string, for `.where('service', ...)` filters
//
// import_meta's SCHEMA is identical for every app (see xeplr-db/config/
// migrations/0001_import_meta.js + 0002_...) — there is nothing app-specific
// about the ImportMeta model, so it lives here once instead of being
// copy-pasted into every app's models/ directory.
var { BaseModel, bootstrapConfigDb } = require('@xeplr/db');
var { decrypt } = require('@xeplr/utils/isomorphic/crypto');
var makeMetaStore = require('./meta-store-knex');

var requiredEnv = [
  'XCFG_DB_NAME',                        // xeplr_configs db name
  'XCFG_DB_CONNECTION_INFO_ENCRYPTED',   // xeplr_configs server login
];

class ImportMeta extends BaseModel {
  static get tableName() { return 'import_meta'; }
  static get idColumn() { return 'id'; }
}

function attachConfig(options) {
  options = options || {};
  var service = options.service;
  if (!service) throw new Error('attachConfig: options.service is required');

  var _ready = null;
  var _xcfg = null;
  var _boundImportMeta = null;
  var _metaStore = null;

  function ready() {
    if (!_ready) {
      _ready = (async function() {
        var login = JSON.parse(await decrypt(process.env.XCFG_DB_CONNECTION_INFO_ENCRYPTED, process.env.ENCRYPTION_KEY));
        _xcfg = await bootstrapConfigDb({ connection: login, database: process.env.XCFG_DB_NAME });
        _boundImportMeta = ImportMeta.bindKnex(_xcfg.db);
        _metaStore = makeMetaStore(_xcfg.db, { table: 'import_meta', service: service });
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
    get metaStore() { requireReady('metaStore'); return _metaStore; },
    get ImportMeta() { requireReady('ImportMeta'); return _boundImportMeta; },
    get db() { requireReady('db'); return _xcfg.db; }
  };
}

module.exports = { attachConfig: attachConfig, requiredEnv: requiredEnv, ImportMeta: ImportMeta };
