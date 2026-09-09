// email-send action — send one message over SMTP.
//
// Peer dep: `nodemailer`, lazy-required inside the driver so a read-only
// deployment never has to install it.
//
// ATTACHMENTS take nodemailer's own descriptors — { filename, path },
// { filename, content }, { filename, href } — which is why the output of
// email-download-attachments (`saved[]`, each with filename + path) can be
// passed straight back in to forward what was just downloaded.
//
// `accepted` / `rejected` are both returned. SMTP accepts per-recipient, so a
// send can succeed at the protocol level while dropping half its recipients;
// reporting only success would hide that.

var emailDrivers = require('../drivers/email');
var emailConfig = require('../drivers/email/config');

module.exports = {
  name: 'email-send',
  description: 'Send an email over SMTP. Attachments accept { filename, path } descriptors, ' +
               'so email-download-attachments output can be forwarded directly.',
  requires: [],   // nodemailer checked at runtime

  // ORDERED THE WAY THE DECISIONS ARE ACTUALLY MADE. Which server sends this
  // comes first, because it is the only answer that changes what the rest of
  // the form means — and it is one tick, which either ends the subject there
  // or opens a connection box. Then what to say, then who else gets a copy.
  //
  // Two ways to keep the form short, and they are not the same thing:
  //
  //   showWhen  the field is not asked AT ALL right now. Choosing a template
  //             means there is no subject to write, so the subject box is
  //             gone rather than sitting there collecting a discarded value.
  //
  //   group     the field is always legitimate, just rarely wanted. cc, bcc,
  //             reply-to, attachments — real inputs, none of them what you
  //             opened the step for. Same group name → one collapsed section.
  //
  // Both are layout only; @xeplr/schema-handler validates every field the same
  // way regardless (see its validate.js).
  inputSchema: [
    { name: 'useCustomConnection', type: 'boolean', default: false, order: 1,
      description: 'Off: send through this install\'s email service. On: supply your own SMTP connection below.' },
    { name: 'connection', type: 'object', order: 2,
      showWhen: { field: 'useCustomConnection', equals: true },
      description: '{ host, port, secure, user, password, from, replyTo, envelopeFrom, tls? }' },

    // A stored template replaces subject+html entirely: pick "User
    // Registration" and supply its variables, instead of restating the same
    // message in every workflow that sends it. Templates live in the EMAIL
    // service (@xeplr/email) because everything here sends mail — one store,
    // every product.
    { name: 'templateName', type: 'string', order: 3,
      description: 'Name of a stored email template. Leave empty to write the subject and body here instead.' },
    { name: 'templateVars', type: 'object', order: 4,
      showWhen: { field: 'templateName', isSet: true },
      description: 'Values for the template\'s {{variables}}. Bind them like any other input, e.g. { "firstName": "{params.name}" }.' },
    { name: 'to',          type: 'array',  required: true, order: 5,
      description: 'Recipient addresses. A bare string is accepted and wrapped.' },
    { name: 'subject',     type: 'string', order: 6,
      showWhen: { field: 'templateName', isSet: false },
      description: 'Message subject. Required unless a template supplies it.' },
    { name: 'html',        type: 'string', order: 7,
      showWhen: { field: 'templateName', isSet: false },
      description: 'HTML body. Required unless a template supplies it.' },

    { name: 'text',        type: 'string', order: 8, group: 'Message options',
      showWhen: { field: 'templateName', isSet: false },
      description: 'Plain-text body, as an alternative to html.' },
    { name: 'attachments', type: 'array',  order: 9, group: 'Message options',
      description: 'Nodemailer attachment descriptors, e.g. [{ filename, path }].' },

    { name: 'cc',          type: 'array',  order: 10, group: 'More addresses',
      description: 'CC addresses.' },
    { name: 'bcc',         type: 'array',  order: 11, group: 'More addresses',
      description: 'BCC addresses.' },
    { name: 'from',        type: 'string', order: 12, group: 'More addresses',
      description: 'Sender address. Falls back to connection.from.' },
    { name: 'replyTo',     type: 'string', order: 13, group: 'More addresses',
      description: 'Reply-To address. Falls back to connection.replyTo, then from.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};

    // A template supplies subject/html/text; anything typed on the step is
    // OVERRIDDEN rather than merged, so "which subject actually went out" has
    // one answer. @xeplr/email is an optional peer — an install that never
    // uses templates does not need it, and only a step naming one hits this.
    if (input.templateName) {
      var email;
      try {
        email = require('@xeplr/email');
      } catch (_) {
        throw new Error("email-send: templateName is set but '@xeplr/email' is not installed. Install it, or write the subject and body on the step.");
      }
      if (!email.templatesReady || !email.templatesReady()) {
        throw new Error('email-send: the template store is not initialised — the host must call initTemplates() at boot (see @xeplr/email).');
      }
      var rendered = await email.renderTemplate(input.templateName, input.templateVars || {});
      input = Object.assign({}, input, {
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text
      });
    }

    var provider = emailDrivers.getOutboundProvider(input.emailType);
    // 'system' hands off to the install's configured sender (which may not be
    // SMTP at all), so there is no connection to resolve and no SMTP library
    // to require. 'custom' builds a transport from the step's own connection.
    var useSystem = emailConfig.usesSystemSender(input);
    provider.checkRequires('email-send', { useSystem: useSystem });
    var conn = useSystem ? null : emailConfig.resolveOutbound(input);
    return provider.send(conn, input, useSystem);
  }
};
