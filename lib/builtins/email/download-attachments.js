// email-download-attachments action — save a message's attachments to disk,
// optionally filtered by extension and/or filename substring.
//
// Each file is written with a random prefix, because attachment names collide
// constantly ("invoice.pdf" from fifty senders) and a download that silently
// overwrites the previous one is expensive to notice. Names are also
// sanitized: a filename arriving from a mailbox is attacker-controlled, and
// one containing path separators would otherwise escape the output directory.
//
// `saved[]` entries carry { filename, path } — exactly nodemailer's attachment
// descriptor shape — so the output can be handed straight to email-send to
// forward what was just downloaded.

var emailDrivers = require('../../drivers/email');
var emailConfig = require('../../drivers/email/config');

module.exports = {
  name: 'email-download-attachments',
  description: 'Save a message\'s attachments to disk, optionally filtered by extension or ' +
               'filename substring. Returns { count, saved[], path, skipped }.',
  requires: [],

  // Which mailbox first — it is the only answer that changes what the rest of
  // the form means. See send-email's schema for the showWhen/group split.
  inputSchema: [
    { name: 'useCustomConnection', type: 'boolean', default: false, order: 1,
      description: 'Off: use the mailbox this install is already configured with. On: supply your own below.' },
    { name: 'connection', type: 'object', order: 2,
      showWhen: { field: 'useCustomConnection', equals: true },
      description: '{ host, port, secure, user, password, tls? }' },
    { name: 'messageId',        type: 'string', required: true, order: 3,
      description: 'Message id (IMAP UID) as returned by email-read.' },
    { name: 'folder',           type: 'string', default: 'INBOX', order: 4,
      description: 'Folder the message is currently in — where its id is valid.' },
    { name: 'outDir',           type: 'string', order: 5,
      description: 'Directory to write into. Defaults to XEPLR_ACTIONS_TMP_DIR.' },

    { name: 'extension',        type: 'string', order: 6, group: 'Filters',
      description: 'Only attachments with this extension, e.g. "pdf" or ".pdf".' },
    { name: 'filenameContains', type: 'string', order: 7, group: 'Filters',
      description: 'Only attachments whose filename contains this substring.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var provider = emailDrivers.getInboundProvider(input.emailType);
    // 'system' resolves from env; 'custom' takes the step's own connection.
    var conn = emailConfig.resolveInbound(input);
    provider.checkRequires('email-download-attachments', { needsParser: true });
    return provider.downloadAttachments(conn, input);
  }
};
