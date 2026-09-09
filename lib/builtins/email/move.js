// email-move action — move one message to another folder.
//
// `folder` (the SOURCE) is a real input, not a detail: a message is addressed
// by IMAP UID, which is scoped to the folder it currently sits in. Moving from
// anywhere other than INBOX without saying so targets the wrong mailbox and
// either fails or moves something else.
//
// A move CHANGES the message's uid. Any further step that addresses the same
// message (download, delete) must run BEFORE this one, or re-read to pick up
// the new uid from the destination folder.

var emailDrivers = require('../../drivers/email');
var emailConfig = require('../../drivers/email/config');

module.exports = {
  name: 'email-move',
  description: 'Move a message to another mailbox folder. The message id is folder-scoped, ' +
               'so input.folder must name the folder the message is currently in.',
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
    { name: 'toFolder',   type: 'string', required: true, order: 4,
      description: 'Destination folder name.' },
    { name: 'folder',     type: 'string', default: 'INBOX', order: 5,
      description: 'Folder the message is currently in — where its id is valid.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var provider = emailDrivers.getInboundProvider(input.emailType);
    // 'system' resolves from env; 'custom' takes the step's own connection.
    var conn = emailConfig.resolveInbound(input);
    provider.checkRequires('email-move', { needsParser: false });
    return provider.move(conn, input);
  }
};
