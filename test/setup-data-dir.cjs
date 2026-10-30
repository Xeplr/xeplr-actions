// Every test process gets a data root of its own, and an application, as an
// app does at boot (XEPLR_DATA_DIR in env.required.js, registerApplication).
// No tenancy is registered, so the app is one tenant: <root>/<app>. A test
// that needs tenants registers them itself (test/data-dir.test.js).
var fs = require('fs');
var os = require('os');
var path = require('path');
if (!process.env.XEPLR_DATA_DIR) {
  process.env.XEPLR_DATA_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-data-')));
}
require('@xeplr/db').registerApplication('xeplr-actions-test');
