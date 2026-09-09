// email-delete action — permanently delete one message.
//
// PERMANENT. This flags \Deleted and EXPUNGES: the message is gone from the
// server, not moved to Trash, and there is nothing to undo. If what you want
// is the server's trash folder, that is email-move with toFolder set to it —
// which is reversible and is usually the right choice in an automated flow.
//
// Like every message-addressed action here, the id is folder-scoped; `folder`
// must name where the message currently lives.

var emailDrivers = require('../../drivers/email');
var emailConfig = require('../../drivers/email/config');

module.exports = {
  name: 'email-delete',
  description: 'Permanently delete a message (flags \\Deleted and expunges — NOT a move to Trash). ' +
               'The message id is folder-scoped, so input.folder must name the folder it is in.',
  requires: [],

  // Which mailbox first — it is the only answer that changes what the rest of
  // the form means. See send-email's schema for the showWhen/group split.
  inputSchema: [
    { name: 'useCustomConnection', type: 'boolean', default: false, order: 1,
      description: 'Off: use the mailbox this install is already configured with. On: supply your own below.' },
    { name: 'connection', type: 'object', order: 2,
      showWhen: { field: 'useCustomConnection', equals: true },
      description: '{ host, port, secure, user, password, tls? }' },
    { name: 'messageId',  type: 'string', required: true, order: 3,
      description: 'Message id (IMAP UID) as returned by email-read.' },
    { name: 'folder',     type: 'string', default: 'INBOX', order: 4,
      description: 'Folder the message is currently in — where its id is valid.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var provider = emailDrivers.getInboundProvider(input.emailType);
    // 'system' resolves from env; 'custom' takes the step's own connection.
    var conn = emailConfig.resolveInbound(input);
    provider.checkRequires('email-delete', { needsParser: false });
    return provider.delete(conn, input);
  }
};
