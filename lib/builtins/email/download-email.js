// email-download-email action — save the whole message as an RFC-822 .eml.
//
// Headers, body and every attachment, byte for byte as the server holds it —
// which is what an .eml IS, so nothing is built: the raw IMAP source streams
// straight to disk without being parsed or buffered whole. A message carrying
// a 40 MB attachment never becomes a 40 MB string.
//
// Output shape is deliberately identical to email-download-attachments
// ({ count, saved[], path }) so a downstream step binds the same way whichever
// produced the file.

var emailDrivers = require('../../drivers/email');
var emailConfig = require('../../drivers/email/config');

module.exports = {
  name: 'email-download-email',
  description: 'Save an entire message to disk as a .eml (RFC-822) file, streamed. ' +
               'Returns { count, saved[], path } like email-download-attachments.',
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
      description: 'Folder the message is currently in — where its id is valid.' },
    { name: 'outDir',     type: 'string', order: 5,
      description: 'Directory to write into. Defaults to XEPLR_ACTIONS_TMP_DIR.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var provider = emailDrivers.getInboundProvider(input.emailType);
    // 'system' resolves from env; 'custom' takes the step's own connection.
    var conn = emailConfig.resolveInbound(input);
    provider.checkRequires('email-download-email', { needsParser: false });
    return provider.downloadEmail(conn, input);
  }
};
