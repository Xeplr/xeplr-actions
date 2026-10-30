// WHERE A STEP'S FILES ARE — @xeplr/db's dataDir: one root (XEPLR_DATA_DIR),
// a folder per tenant (<root>/<app>/<mtId1>/…), the tenant from the context
// the work runs in, never from input. One copy, in @xeplr/db beside the
// tenant context, so uploads, imports and factory use the same one. See its
// README ("Files: a folder per tenant").
module.exports = require('@xeplr/db').dataDir;
