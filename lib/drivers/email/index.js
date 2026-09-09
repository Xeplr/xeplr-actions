// Email provider registry — the same shape as lib/drivers/db: an action names
// a provider, this resolves it, and the action never learns which one it got.
//
// TODAY: 'imap' handles all five inbound operations and 'smtp' handles sending.
// They are separate providers rather than one because they are separate
// protocols on separate ports with separate credentials — a mailbox that
// receives over IMAP frequently sends through a different relay entirely.
//
// A future 'graph' provider (Microsoft 365, where one OAuth app covers both
// directions) plugs in here by implementing the same method names; no action
// changes.

var imap = require('./imap');
var smtp = require('./smtp');

var INBOUND = {
  imap: imap
};

var OUTBOUND = {
  smtp: smtp
};

function getInboundProvider(name) {
  var key = String(name || 'imap').toLowerCase();
  var provider = INBOUND[key];
  if (!provider) {
    throw new Error('email: unknown inbound provider "' + key + '" (supported: ' + Object.keys(INBOUND).join(', ') + ')');
  }
  return provider;
}

function getOutboundProvider(name) {
  var key = String(name || 'smtp').toLowerCase();
  var provider = OUTBOUND[key];
  if (!provider) {
    throw new Error('email: unknown outbound provider "' + key + '" (supported: ' + Object.keys(OUTBOUND).join(', ') + ')');
  }
  return provider;
}

module.exports = {
  getInboundProvider: getInboundProvider,
  getOutboundProvider: getOutboundProvider
};
