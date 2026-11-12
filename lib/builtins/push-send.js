// push-send action — a notification on people's phones and computers, even
// with the app closed, through @xeplr/push (Web Push).
//
// Peer dep: `@xeplr/push`, lazy-required here, so an install that never
// pushes does not need it. The host app sets it up once at boot —
// push.init({ knex }) with its VAPID keys — and this step only sends.
//
// WHO: account ids (`userIds`) and/or emails (`emails`) — every device each of
// them switched on, each device once. Nobody to send to is refused, rather
// than "succeeding" with nothing sent.
//
// WHERE A TAP GOES: `url` is a page of the app ("/orders/{params.id}"). A full
// address to another site is replaced by the app's home by @xeplr/push, so a
// step can never send people off somewhere else.

function asList(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(function(x) { return String(x).trim(); }).filter(Boolean);
}

module.exports = {
  name: 'push-send',
  // It sends, so it is never previewed.
  example: { devices: 2, sent: 2, removed: 0, failed: 0 },
  description: 'Send a push notification to people\'s phones and computers (Web Push, through @xeplr/push) — by account id or email. A tap opens the page given.',
  requires: [],   // @xeplr/push checked at runtime

  inputSchema: [
    { name: 'emails',  type: 'array',  order: 1,
      description: 'Who gets it, by email. A bare string is accepted and wrapped.' },
    { name: 'userIds', type: 'array',  order: 2,
      description: 'Who gets it, by account id — instead of, or as well as, emails.' },
    { name: 'title',   type: 'string', required: true, order: 3,
      description: 'The first line, e.g. "RTO: #{params.orderNumber}". At most 120 characters.' },
    { name: 'body',    type: 'string', order: 4,
      description: 'Under it. At most 300 characters.' },
    { name: 'url',     type: 'string', order: 5,
      description: 'The page of the app a tap opens, e.g. /orders/{params.id}. Leave empty for the home page.' },
    { name: 'tag',     type: 'string', order: 6, group: 'Message options',
      description: 'A new notification with the same tag replaces the one shown, so repeats stack as one.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var push;
    try {
      push = require('@xeplr/push');
    } catch (_) {
      throw new Error("push-send: '@xeplr/push' is not installed. Run: npm install @xeplr/push — and set it up at boot with push.init({ knex }).");
    }
    if (!push.enabled || !push.enabled()) {
      throw new Error('push-send: push is not set up on this server — the host must call push.init() with PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY / PUSH_VAPID_SUBJECT (npx xeplr-push keys).');
    }
    var target = { emails: asList(input.emails), userIds: asList(input.userIds) };
    if (!target.emails.length && !target.userIds.length) throw new Error('push-send: say who gets it — emails or userIds.');
    return push.send(target, { title: input.title, body: input.body, url: input.url, tag: input.tag });
  }
};
