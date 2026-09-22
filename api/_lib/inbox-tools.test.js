// api/_lib/inbox-tools.test.js
//
// Cross-tenant + privacy tests for the Dossie inbox tools. Written as part of
// the build, not after it — see docs/DOSSIE-INBOX-CAPABILITY-SCOPE.md §6.
//
// Run with:  node --test api/_lib/inbox-tools.test.js
//
// These run with NO network: makeMailClient and fetch are both stubbed, so
// the real control flow executes but nothing leaves the process.
//
// The single question every test here answers: can member A, by any route
// available to them or to the model, cause a read of member B's mailbox?

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const {
  INBOX_TOOLS,
  INBOX_TOOL_NAMES,
  executeInboxTool,
  InboxSecurityError,
  _internal,
} = require('./inbox-tools.js');

const {
  isIdentityKey,
  redactForLog,
  buildGmailQuery,
  buildGmailContactQuery,
  buildMicrosoftQuery,
  contactNameVariants,
  parseAddressList,
  messageDirection,
  sanitizeFreeText,
  clampInt,
  resolveOwnedTransaction,
  GMAIL_FOLDER_SCOPE,
  __setTestDeps,
  __resetTestDeps,
  LIMITS,
} = _internal;

const ATTACKER = '00000000-aaaa-4aaa-8aaa-000000000001';
const VICTIM = '00000000-bbbb-4bbb-8bbb-000000000002';

// --------------------------------------------------------------------------
// Harness: records every userId the mail client was asked for, and every
// Supabase URL that was hit.
// --------------------------------------------------------------------------
function harness({ entitled = [ATTACKER, VICTIM], connected = [ATTACKER, VICTIM], transactions = {} } = {}) {
  const log = { mailClientUserIds: [], urls: [] };

  __setTestDeps({
    makeMailClient: async ({ userId }) => {
      log.mailClientUserIds.push(userId);
      if (!connected.includes(userId)) return null;
      return {
        provider: 'google',
        email: `${userId}@mailbox.test`,
        tokens: { access_token: 'stub' },
        client: async (path) => {
          if (path === 'messages') return { messages: [{ id: `msg-for-${userId}` }] };
          if (/^messages\/[^/]+$/.test(path)) {
            return {
              id: `msg-for-${userId}`,
              snippet: `snippet belonging to ${userId}`,
              payload: {
                headers: [
                  { name: 'From', value: `"Agent" <someone@${userId}.test>` },
                  { name: 'Subject', value: `subject belonging to ${userId}` },
                  { name: 'Date', value: 'Fri, 19 Sep 2026 10:00:00 -0500' },
                ],
                parts: [
                  { mimeType: 'text/plain', body: { data: Buffer.from(`body belonging to ${userId}`).toString('base64url') } },
                ],
              },
            };
          }
          throw new Error(`unexpected path ${path}`);
        },
      };
    },
    fetch: async (url, init = {}) => {
      log.urls.push(String(url));
      const u = String(url);
      if (u.includes('/subscriptions?')) {
        const m = u.match(/user_id=eq\.([^&]+)/);
        const uid = m ? decodeURIComponent(m[1]) : null;
        const rows = entitled.includes(uid) ? [{ user_id: uid }] : [];
        return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
      }
      if (u.includes('/transactions?')) {
        const m = u.match(/user_id=eq\.([^&]+)/);
        const uid = m ? decodeURIComponent(m[1]) : null;
        const rows = transactions[uid] || [];
        return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
      }
      return { ok: true, status: 200, text: async () => '[]' };
    },
    loadScanner: () => { throw new Error('scanner must not be reached in these tests'); },
  });

  return log;
}

test.afterEach(() => __resetTestDeps());

// ==========================================================================
// 1. No tool schema carries an identity parameter.
//    This is the test that would have caught _mt_acting_user.
// ==========================================================================
test('no inbox tool schema exposes an identity parameter', () => {
  assert.equal(INBOX_TOOLS.length, 4);
  for (const tool of INBOX_TOOLS) {
    const props = Object.keys(tool.input_schema.properties || {});
    for (const prop of props) {
      assert.equal(
        isIdentityKey(prop),
        false,
        `tool ${tool.name} exposes identity-shaped parameter "${prop}" — a caller could select whose mailbox is read`,
      );
    }
    // Belt and braces: the whole schema, serialized, must not mention a user.
    const json = JSON.stringify(tool.input_schema);
    assert.ok(!/"user_id"|"userId"|"mailbox"|"account_id"|"on_behalf_of"|"acting_user"/.test(json), `${tool.name} schema mentions an identity field`);
  }
});

test('the identity-key guard recognises the shapes that matter', () => {
  for (const k of ['user_id', 'userId', 'user', 'member_id', 'account', 'mailbox', 'owner_id', 'acting_user', 'on_behalf_of', 'as_user', 'impersonate', 'email', 'to_email', 'access_token', 'uid', 'sub']) {
    assert.ok(isIdentityKey(k), `expected "${k}" to be treated as an identity key`);
  }
  for (const k of ['query', 'from', 'days', 'message_id', 'deal_identifier', 'attachment_ids', 'extract', 'max_results', 'has_attachment']) {
    assert.equal(isIdentityKey(k), false, `"${k}" must remain usable`);
  }
});

// ==========================================================================
// 2. Injected identity params are REJECTED, not silently ignored.
//    A silent drop looks identical to a normal call in the logs.
// ==========================================================================
test('every executor rejects an injected identity parameter', async () => {
  harness();
  const injections = [
    { user_id: VICTIM },
    { userId: VICTIM },
    { email: 'victim@example.com' },
    { mailbox: 'victim@example.com' },
    { on_behalf_of: VICTIM },
    { acting_user: VICTIM },
    { account: VICTIM },
    { access_token: 'stolen' },
  ];

  for (const toolName of INBOX_TOOL_NAMES) {
    for (const inj of injections) {
      const input = { query: 'sablewood', message_id: 'm1', deal_identifier: 'sablewood', ...inj };
      await assert.rejects(
        () => executeInboxTool(toolName, input, { userId: ATTACKER }),
        (err) => err instanceof InboxSecurityError && /identity_param_not_allowed/.test(err.message),
        `${toolName} accepted ${JSON.stringify(inj)}`,
      );
    }
  }
});

// ==========================================================================
// 3. The mail client is only ever requested for the session user.
// ==========================================================================
test('search_inbox asks for the session user mailbox, never a caller-named one', async () => {
  const log = harness();
  const res = await executeInboxTool('search_inbox', { query: 'sablewood' }, { userId: ATTACKER });

  assert.equal(res.ok, true);
  assert.deepEqual(log.mailClientUserIds, [ATTACKER]);
  assert.ok(!log.mailClientUserIds.includes(VICTIM));
  // And the entitlement check was scoped to the same id.
  assert.ok(log.urls.some((u) => u.includes('/subscriptions?') && u.includes(`user_id=eq.${ATTACKER}`)));
  assert.ok(!log.urls.some((u) => u.includes(VICTIM)));
});

test('read_email cannot be pointed at another mailbox via message_id', async () => {
  const log = harness();
  // A message id belonging to the victim's mailbox is meaningless here: the
  // client is bound to the attacker's token, so the id resolves against the
  // attacker's own mailbox or not at all.
  const res = await executeInboxTool('read_email', { message_id: `msg-for-${VICTIM}` }, { userId: ATTACKER });
  assert.equal(res.ok, true);
  assert.deepEqual(log.mailClientUserIds, [ATTACKER]);
  assert.match(res.body_text, new RegExp(ATTACKER));
  assert.doesNotMatch(res.body_text, new RegExp(VICTIM));
  assert.doesNotMatch(res.subject, new RegExp(VICTIM));
});

test('a session with no userId is refused outright', async () => {
  harness();
  for (const bad of [undefined, null, {}, { userId: '' }, { userId: 123 }]) {
    await assert.rejects(
      () => executeInboxTool('search_inbox', { query: 'x' }, bad),
      (err) => err instanceof InboxSecurityError && /missing_session_user/.test(err.message),
    );
  }
});

// ==========================================================================
// 4. Deal lookup is always filtered by the session user.
// ==========================================================================
test('transaction lookup always carries the session user filter', async () => {
  const log = harness({
    transactions: {
      [VICTIM]: [{ id: 'victim-tx', property_address: '14 Sablewood' }],
      [ATTACKER]: [],
    },
  });

  const res = await executeInboxTool(
    'import_email_attachments',
    { message_id: 'm1', deal_identifier: '14 Sablewood' },
    { userId: ATTACKER },
  );

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'deal_not_found');
  const txUrl = log.urls.find((u) => u.includes('/transactions?'));
  assert.ok(txUrl, 'no transaction lookup was made');
  assert.ok(txUrl.includes(`user_id=eq.${ATTACKER}`), 'transaction lookup was not scoped to the session user');
  assert.ok(!txUrl.includes(VICTIM));
});

test('resolveOwnedTransaction never returns a row for a different user', async () => {
  harness({
    transactions: {
      [VICTIM]: [{ id: 'victim-tx', property_address: '14 Sablewood' }],
      [ATTACKER]: [],
    },
  });
  assert.equal(await resolveOwnedTransaction(ATTACKER, '14 Sablewood'), null);
  const mine = await resolveOwnedTransaction(VICTIM, '14 Sablewood');
  assert.equal(mine.id, 'victim-tx');
});

// ==========================================================================
// 5. No integration row means not_connected — never a fallback to another
//    member's row. This is the live-data trap: today exactly one set of
//    user_integrations rows exists, so an unfiltered lookup would hand that
//    one mailbox to every caller and look like it worked.
// ==========================================================================
test('a member with no connected inbox gets not_connected, not someone else mail', async () => {
  const log = harness({ entitled: [ATTACKER, VICTIM], connected: [VICTIM] });
  const res = await executeInboxTool('search_inbox', { query: 'sablewood' }, { userId: ATTACKER });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_connected');
  assert.deepEqual(log.mailClientUserIds, [ATTACKER]);
  assert.ok(!JSON.stringify(res).includes(VICTIM));
});

test('an unentitled member is stopped before the mailbox is ever touched', async () => {
  const log = harness({ entitled: [], connected: [ATTACKER] });
  const res = await executeInboxTool('search_inbox', { query: 'sablewood' }, { userId: ATTACKER });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_entitled');
  assert.deepEqual(log.mailClientUserIds, [], 'the mail client must not be constructed for an unentitled member');
});

test('not_connected and an empty result are distinguishable', async () => {
  // If these collapsed into the same shape, the agent would hear "no offer
  // came in" when the truth is "Dossie cannot see your mail".
  const connectedEmpty = harness({ connected: [ATTACKER] });
  __setTestDeps({
    ...({}),
    makeMailClient: async () => ({ provider: 'google', email: 'x', tokens: {}, client: async () => ({ messages: [] }) }),
    fetch: async (url) => ({ ok: true, status: 200, text: async () => (String(url).includes('/subscriptions?') ? JSON.stringify([{ user_id: ATTACKER }]) : '[]') }),
  });
  const empty = await executeInboxTool('search_inbox', { query: 'sablewood' }, { userId: ATTACKER });
  assert.equal(empty.ok, true);
  assert.equal(empty.count, 0);

  harness({ connected: [] });
  const disconnected = await executeInboxTool('search_inbox', { query: 'sablewood' }, { userId: ATTACKER });
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.reason, 'not_connected');
  void connectedEmpty;
});

// ==========================================================================
// 6. Logging redaction.
// ==========================================================================
test('redactForLog drops every sensitive field', () => {
  const realistic = {
    tool: 'read_email',
    provider: 'google',
    ok: true,
    count: 1,
    message_id: 'abc123',
    from_email: 'buyeragent@example.com',
    subject: 'Revised offer 14 Sablewood',
    body_text: 'SSN 123-45-6789 and wire instructions routing 111000025',
    attachments: [{ filename: 'contract.pdf', attachment_id: 'att-1' }],
    access_token: 'ya29.secret',
    tokens: { refresh_token: 'refresh-secret' },
  };
  const line = JSON.stringify(redactForLog(realistic));

  for (const secret of ['buyeragent@example.com', 'Revised offer', '123-45-6789', '111000025', 'ya29.secret', 'refresh-secret', 'contract.pdf']) {
    assert.ok(!line.includes(secret), `redacted log line leaked: ${secret}`);
  }
  assert.ok(line.includes('read_email'));
  assert.ok(line.includes('google'));
});

test('redactForLog is a whitelist, so a newly added field cannot leak by default', () => {
  const line = JSON.stringify(redactForLog({ tool: 'search_inbox', some_future_pii_field: 'leak-me' }));
  assert.ok(!line.includes('leak-me'));
});

// ==========================================================================
// 7. Query scoping — a tool that can dump a mailbox is a privacy problem as
//    much as a cost problem.
// ==========================================================================
test('search refuses a query with neither keywords nor a sender', async () => {
  harness();
  const res = await executeInboxTool('search_inbox', { days: 90 }, { userId: ATTACKER });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'query_too_broad');
});

test('date window and result count are clamped, not trusted', () => {
  assert.equal(clampInt(100000, LIMITS.DEFAULT_DAYS, 1, LIMITS.MAX_DAYS), LIMITS.MAX_DAYS);
  assert.equal(clampInt(-5, LIMITS.DEFAULT_DAYS, 1, LIMITS.MAX_DAYS), 1);
  assert.equal(clampInt('not a number', LIMITS.DEFAULT_DAYS, 1, LIMITS.MAX_DAYS), LIMITS.DEFAULT_DAYS);
  assert.equal(clampInt(9999, LIMITS.DEFAULT_MAX_RESULTS, 1, LIMITS.MAX_MAX_RESULTS), LIMITS.MAX_MAX_RESULTS);
});

test('the gmail query always carries a date bound and the folder exclusions', () => {
  const q = buildGmailQuery({ text: 'sablewood', from: '', days: 14, hasAttachment: true });
  assert.ok(q.includes('newer_than:14d'));
  assert.ok(q.includes('-in:spam'));
  assert.ok(q.includes('-in:trash'));
  assert.ok(q.includes('-in:chats'));
  assert.ok(q.includes('-in:drafts'));
  assert.ok(q.includes('has:attachment'));
});

// ==========================================================================
// 7b. Sent mail is reachable; spam/trash/drafts/chats are not.
//
//     Most of an agent's client addresses only ever appear as a RECIPIENT of
//     mail they sent (Marcus Thorne: no inbound message inside a year, but on
//     the To: line of a dozen sent ones). Excluding the sent folder made
//     "what is this person's address" unanswerable at any setting.
// ==========================================================================
test('sent mail is searchable', () => {
  assert.ok(!GMAIL_FOLDER_SCOPE.includes('-in:sent'), 'sent mail is excluded again');
  for (const q of [
    buildGmailQuery({ text: 'thorne', from: '', days: 30, hasAttachment: false }),
    buildGmailContactQuery({ variants: ['thorne'], days: 730 }),
  ]) {
    assert.ok(!q.includes('-in:sent'), `query still excludes sent mail: ${q}`);
  }
});

test('spam, trash, chats and drafts stay excluded from every gmail query', () => {
  const queries = [
    buildGmailQuery({ text: 'sablewood', from: '', days: 14, hasAttachment: false }),
    buildGmailQuery({ text: '', from: 'a@b.com', days: 730, hasAttachment: true }),
    buildGmailContactQuery({ variants: ['thorne', 'marcus'], days: 730 }),
    buildGmailContactQuery({ variants: ['thorne'], days: 1 }),
  ];
  for (const q of queries) {
    for (const excluded of ['-in:spam', '-in:trash', '-in:chats', '-in:drafts']) {
      assert.ok(q.includes(excluded), `query is missing ${excluded}: ${q}`);
    }
  }
});

// ==========================================================================
// 7c. The widened window is still a window.
// ==========================================================================
test('the date window is widened but still bounded', () => {
  assert.equal(LIMITS.DEFAULT_DAYS, 14, 'the recency default should not have moved');
  assert.ok(LIMITS.MAX_DAYS > 100, 'max window must reach a >100-day-old message — the real failing case');
  assert.ok(LIMITS.MAX_DAYS <= 730, 'max window must stay a bound, not an unlimited history');

  // Nothing can exceed it, by any route the model controls.
  assert.equal(clampInt(999999, LIMITS.DEFAULT_DAYS, 1, LIMITS.MAX_DAYS), LIMITS.MAX_DAYS);
  // A non-finite value is treated as unset and falls back to the default —
  // never to "unbounded".
  for (const bad of [Infinity, -Infinity, NaN, null, 'all', {}]) {
    const got = clampInt(bad, LIMITS.DEFAULT_DAYS, 1, LIMITS.MAX_DAYS);
    assert.ok(got >= 1 && got <= LIMITS.MAX_DAYS, `clampInt(${String(bad)}) escaped the bound: ${got}`);
  }
  assert.ok(buildGmailQuery({ text: 'x', from: '', days: LIMITS.MAX_DAYS, hasAttachment: false })
    .includes(`newer_than:${LIMITS.MAX_DAYS}d`));
});

test('contact lookup is bounded on every axis', () => {
  assert.equal(clampInt(999, LIMITS.DEFAULT_MAX_CONTACTS, 1, LIMITS.MAX_MAX_CONTACTS), LIMITS.MAX_MAX_CONTACTS);
  assert.equal(clampInt(9999, LIMITS.CONTACT_DEFAULT_DAYS, 1, LIMITS.MAX_DAYS), LIMITS.MAX_DAYS);
  assert.ok(LIMITS.MAX_CONTACT_MESSAGES <= 50, 'header scan must stay bounded');
  assert.ok(LIMITS.MAX_ADDRESSES_PER_HEADER <= 50, 'a single header cannot expand without limit');
  // A contact search with no name is refused — there is still no "list
  // everyone I have ever emailed" affordance.
  assert.ok(contactNameVariants('').length === 0);
  assert.ok(contactNameVariants('   ').length === 0);
});

test('free text cannot smuggle gmail operators that widen the scope', () => {
  const sneaky = sanitizeFreeText('sablewood in:anywhere -in:inbox label:secret has:attachment OR from:ceo@target.com');
  assert.ok(!sneaky.includes('in:'));
  assert.ok(!sneaky.includes('label:'));
  assert.ok(!sneaky.includes('from:'));
  assert.ok(sneaky.includes('sablewood'));

  const q = buildGmailQuery({ text: sneaky, from: '', days: 14, hasAttachment: false });
  assert.ok(!/(^|\s)in:anywhere/.test(q), 'folder scope was widened by user text');
});

test('microsoft free-text search is refused rather than silently widened', () => {
  // parseGmailStyleQuery in microsoft-oauth.js drops free text; without this
  // refusal a keyword search would become "every inbox message in N days".
  const refused = buildMicrosoftQuery({ text: 'sablewood', from: '', days: 14 });
  assert.equal(refused.unsupported, true);

  const allowed = buildMicrosoftQuery({ text: 'sablewood', from: 'agent@example.com', days: 14 });
  assert.equal(allowed.unsupported, undefined);
  assert.ok(allowed.q.includes('from:agent@example.com'));
  assert.ok(allowed.q.includes('newer_than:14d'));
});

test('search never returns message bodies', async () => {
  harness();
  const res = await executeInboxTool('search_inbox', { query: 'sablewood' }, { userId: ATTACKER });
  assert.equal(res.ok, true);
  for (const m of res.messages) {
    assert.equal(m.body_text, undefined);
    assert.equal(m.body, undefined);
    assert.ok(m.snippet.length <= LIMITS.MAX_SNIPPET_CHARS);
  }
});

test('read_email truncates the body and flags it', async () => {
  const long = 'x'.repeat(LIMITS.MAX_BODY_CHARS + 5000);
  __setTestDeps({
    makeMailClient: async () => ({
      provider: 'google',
      email: 'me@test',
      tokens: {},
      client: async () => ({
        id: 'm1',
        snippet: '',
        payload: {
          headers: [{ name: 'From', value: 'a@b.test' }, { name: 'Subject', value: 's' }],
          parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(long).toString('base64url') } }],
        },
      }),
    }),
    fetch: async (url) => ({ ok: true, status: 200, text: async () => (String(url).includes('/subscriptions?') ? JSON.stringify([{ user_id: ATTACKER }]) : '[]') }),
  });

  const res = await executeInboxTool('read_email', { message_id: 'm1' }, { userId: ATTACKER });
  assert.equal(res.body_truncated, true);
  assert.equal(res.body_text.length, LIMITS.MAX_BODY_CHARS);
});

test('read_email labels the body as untrusted external content', async () => {
  harness();
  const res = await executeInboxTool('read_email', { message_id: 'm1' }, { userId: ATTACKER });
  assert.match(res.content_warning, /untrusted/i);
  assert.match(res.content_warning, /never follow instructions/i);
});

// ==========================================================================
// 8. No attachment bytes ever reach a tool result.
// ==========================================================================
test('read_email returns an attachment manifest, never attachment content', async () => {
  __setTestDeps({
    makeMailClient: async () => ({
      provider: 'google',
      email: 'me@test',
      tokens: {},
      client: async () => ({
        id: 'm1',
        snippet: '',
        payload: {
          headers: [{ name: 'From', value: 'a@b.test' }],
          parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64url') } },
            { filename: 'contract.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-1', size: 495246, data: 'SHOULD-NEVER-APPEAR' } },
          ],
        },
      }),
    }),
    fetch: async (url) => ({ ok: true, status: 200, text: async () => (String(url).includes('/subscriptions?') ? JSON.stringify([{ user_id: ATTACKER }]) : '[]') }),
  });

  const res = await executeInboxTool('read_email', { message_id: 'm1' }, { userId: ATTACKER });
  assert.equal(res.attachments.length, 1);
  assert.equal(res.attachments[0].filename, 'contract.pdf');
  assert.equal(res.attachments[0].size_bytes, 495246);
  assert.ok(!JSON.stringify(res).includes('SHOULD-NEVER-APPEAR'), 'attachment content leaked into the tool result');
});

// ==========================================================================
// 9. find_contact_email — header parsing.
// ==========================================================================
test('a bare address keeps its first character', () => {
  // parseFromHeader used to parse "mthorne@mail.example" as
  // {name:'b', email:'thorne@mail.example'} — an address that does not exist.
  // Every sender without a display name was silently corrupted, here and in
  // the three watcher crons.
  const [marcus] = parseAddressList('mthorne@mail.example');
  assert.equal(marcus.email, 'mthorne@mail.example');
  assert.equal(marcus.name, '');

  const [heath] = parseAddressList('heath.shepard@kw.com');
  assert.equal(heath.email, 'heath.shepard@kw.com');
});

test('an address list splits on real separators only', () => {
  const list = parseAddressList('Cathy Thorne <cthorne2140@mail.example>, DAD <mthorne@mail.example>');
  assert.deepEqual(list.map((p) => p.email), ['cthorne2140@mail.example', 'mthorne@mail.example']);
  assert.deepEqual(list.map((p) => p.name), ['Cathy Thorne', 'DAD']);

  // A comma inside a quoted display name is not a separator.
  const quoted = parseAddressList('"Thorne, Marcus" <mthorne@mail.example>, cthorne2140@mail.example');
  assert.deepEqual(quoted.map((p) => p.email), ['mthorne@mail.example', 'cthorne2140@mail.example']);

  assert.deepEqual(parseAddressList(''), []);
  assert.deepEqual(parseAddressList(undefined), []);
  // Junk that is not an address is dropped rather than returned as a contact.
  assert.deepEqual(parseAddressList('undisclosed-recipients:;'), []);
});

test('a pluralised surname still matches the singular', () => {
  // "get me the Thornes' email addresses" is how this is actually spoken.
  const variants = contactNameVariants("the Thornes'");
  assert.ok(variants.includes('thorne'), `expected a singular variant, got ${JSON.stringify(variants)}`);
});

test('speech filler is dropped from the name so it cannot flood the result', () => {
  // A stopword inside the OR group matches nearly every message; live, "the
  // Thornes'" pulled back Vercel, LinkedIn and a games newsletter.
  const variants = contactNameVariants("the Thornes' email address");
  for (const junk of ['the', 'email', 'address']) {
    assert.ok(!variants.includes(junk), `"${junk}" survived into the query: ${JSON.stringify(variants)}`);
  }
  assert.ok(variants.includes('thorne'));
  // A name made only of filler is not a search.
  assert.equal(contactNameVariants('the email address for my client').length, 0);
});

test('direction is derived from the SENT label, with a from-address fallback', () => {
  const headers = [{ name: 'From', value: 'Heath Shepard <heath.shepard@kw.com>' }];
  assert.equal(messageDirection({ labelIds: ['SENT'], payload: { headers } }, 'heath.shepard@kw.com'), 'sent');
  assert.equal(messageDirection({ labelIds: ['INBOX'], payload: { headers } }, 'heath.shepard@kw.com'), 'received');
  // No labels (the Graph client returns none) — fall back to who sent it.
  assert.equal(messageDirection({ payload: { headers } }, 'heath.shepard@kw.com'), 'sent');
  assert.equal(messageDirection({ payload: { headers } }, 'someone.else@kw.com'), 'received');
});

// ==========================================================================
// 10. find_contact_email — the real failing case, in unit form.
//
//     Reproduces the live shape: the person asked about appears ONLY on the
//     To: line of mail the member sent, as a bare address, and their one
//     inbound message is older than the old 90-day ceiling.
// ==========================================================================
const MAILBOX = 'heath.shepard@kw.com';

function contactHarness({ messages, provider = 'google' } = {}) {
  const log = { queries: [], formats: [] };
  __setTestDeps({
    makeMailClient: async ({ userId }) => ({
      provider,
      email: MAILBOX,
      tokens: {},
      client: async (path, params = {}) => {
        if (path === 'messages') {
          log.queries.push(String(params.q || ''));
          return { messages: messages.map((m) => ({ id: m.id })) };
        }
        const hit = messages.find((m) => `messages/${m.id}` === path);
        if (!hit) throw new Error(`unexpected path ${path}`);
        log.formats.push(params.format);
        return hit;
      },
    }),
    fetch: async (url) => ({
      ok: true,
      status: 200,
      text: async () => (String(url).includes('/subscriptions?') ? JSON.stringify([{ user_id: ATTACKER }]) : '[]'),
    }),
    loadScanner: () => { throw new Error('scanner must not be reached'); },
  });
  return log;
}

const SENT_TO_BARRY = {
  id: 'sent-1',
  labelIds: ['SENT'],
  snippet: 'NEVER-A-SNIPPET',
  payload: {
    headers: [
      { name: 'From', value: 'heath.shepard@kw.com' },
      { name: 'To', value: 'mthorne@mail.example, cthorne2140@mail.example' },
      { name: 'Subject', value: '14 Sablewood - Full Price Offer + Net Sheet' },
      { name: 'Date', value: 'Sat, 19 Sep 2026 13:07:31 -0500' },
    ],
    parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('NEVER-A-BODY').toString('base64url') } }],
  },
};

const OLD_INBOUND_FROM_BARRY = {
  id: 'in-1',
  labelIds: ['INBOX'],
  snippet: 'NEVER-A-SNIPPET',
  payload: {
    headers: [
      { name: 'From', value: 'Marcus Thorne <mthorne@mail.example>' },
      { name: 'To', value: 'Heath Shepard <heath.shepard@kw.com>' },
      { name: 'Subject', value: 'Re: Sablewood Strategy Update' },
      { name: 'Date', value: 'Thu, 11 Jun 2026 22:25:55 +0000' },
    ],
    parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('NEVER-A-BODY').toString('base64url') } }],
  },
};

test('find_contact_email surfaces an address that only ever appears on a To: line', async () => {
  contactHarness({ messages: [SENT_TO_BARRY] });
  const res = await executeInboxTool('find_contact_email', { name: "the Thornes'" }, { userId: ATTACKER });

  assert.equal(res.ok, true);
  const marcus = res.contacts.find((c) => c.email === 'mthorne@mail.example');
  assert.ok(marcus, `Marcus was not found: ${JSON.stringify(res.contacts)}`);
  assert.equal(marcus.direction, 'sent');
  assert.equal(marcus.matched_name, true);
  // The other Thorne comes back too — "the Thornes" is two people.
  assert.ok(res.contacts.some((c) => c.email === 'cthorne2140@mail.example'));
});

test('find_contact_email reaches a message older than the old 90-day ceiling', async () => {
  const log = contactHarness({ messages: [OLD_INBOUND_FROM_BARRY] });
  const res = await executeInboxTool('find_contact_email', { name: 'Thorne' }, { userId: ATTACKER });

  assert.equal(res.ok, true);
  assert.equal(res.searched_days, LIMITS.CONTACT_DEFAULT_DAYS);
  assert.ok(res.searched_days > 101, 'the default window must reach the 101-day-old message');
  assert.ok(log.queries[0].includes(`newer_than:${LIMITS.CONTACT_DEFAULT_DAYS}d`));
  assert.equal(res.contacts[0].email, 'mthorne@mail.example');
  assert.equal(res.contacts[0].name, 'Marcus Thorne');
  assert.equal(res.contacts[0].direction, 'received');
});

test('find_contact_email returns addresses and never message content', async () => {
  const log = contactHarness({ messages: [SENT_TO_BARRY, OLD_INBOUND_FROM_BARRY] });
  const res = await executeInboxTool('find_contact_email', { name: 'Thorne' }, { userId: ATTACKER });

  const blob = JSON.stringify(res);
  assert.ok(!blob.includes('NEVER-A-BODY'), 'a message body reached the contact result');
  assert.ok(!blob.includes('NEVER-A-SNIPPET'), 'a snippet reached the contact result');
  for (const c of res.contacts) {
    assert.equal(c.body_text, undefined);
    assert.equal(c.snippet, undefined);
    assert.equal(c.attachments, undefined);
  }
  // Headers-only fetch is what makes that structural, not a policy.
  assert.ok(log.formats.length > 0);
  assert.ok(log.formats.every((f) => f === 'metadata'), `expected metadata-only fetches, got ${log.formats}`);
  assert.match(res.content_warning, /not verified|spoofed/i);
});

test('find_contact_email never hands back the member their own address', async () => {
  contactHarness({ messages: [SENT_TO_BARRY, OLD_INBOUND_FROM_BARRY] });
  const res = await executeInboxTool('find_contact_email', { name: 'Thorne' }, { userId: ATTACKER });
  assert.ok(!res.contacts.some((c) => c.email === MAILBOX), 'returned the mailbox owner as a contact');
});

test('find_contact_email caps what it returns and what it scans', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: `Person ${i} <person${i}@thorne-partners.example>` },
        { name: 'To', value: `heath.shepard@kw.com, extra${i}@thorne-partners.example` },
        { name: 'Subject', value: `subject ${i}` },
        { name: 'Date', value: 'Thu, 11 Jun 2026 22:25:55 +0000' },
      ],
    },
  }));
  const log = contactHarness({ messages: many });

  const res = await executeInboxTool('find_contact_email', { name: 'thorne', max_results: 9999 }, { userId: ATTACKER });
  assert.equal(res.ok, true);
  assert.ok(res.contacts.length <= LIMITS.MAX_MAX_CONTACTS, `returned ${res.contacts.length} contacts`);
  assert.ok(log.formats.length <= LIMITS.MAX_CONTACT_MESSAGES, `scanned ${log.formats.length} messages`);
  assert.equal(res.truncated, true);
});

test('find_contact_email refuses an empty name', async () => {
  contactHarness({ messages: [SENT_TO_BARRY] });
  for (const bad of [{ name: '' }, { name: '   ' }, {}, { name: 'a' }]) {
    const res = await executeInboxTool('find_contact_email', bad, { userId: ATTACKER });
    assert.equal(res.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(res.reason, 'query_too_broad');
  }
});

test('find_contact_email cannot smuggle gmail operators through the name', async () => {
  const log = contactHarness({ messages: [SENT_TO_BARRY] });
  await executeInboxTool(
    'find_contact_email',
    { name: 'thorne in:anywhere -in:drafts label:secret has:attachment' },
    { userId: ATTACKER },
  );
  const q = log.queries[0];
  assert.ok(!/(^|\s)in:anywhere/.test(q), `folder scope widened by caller text: ${q}`);
  assert.ok(!q.includes('label:'), q);
  assert.ok(q.includes('-in:spam') && q.includes('-in:drafts') && q.includes('-in:trash'), q);
});

test('find_contact_email refuses on Microsoft rather than dumping the mailbox', async () => {
  // Graph drops free text, so running this there would become "every message
  // in the last two years", and it reshapes no To:/Cc: headers to harvest.
  contactHarness({ messages: [SENT_TO_BARRY], provider: 'microsoft' });
  const res = await executeInboxTool('find_contact_email', { name: 'Thorne' }, { userId: ATTACKER });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unsupported_query_for_provider');
});

test('find_contact_email is subject to the same identity and access gates', async () => {
  // Identity injection.
  contactHarness({ messages: [SENT_TO_BARRY] });
  for (const inj of [{ user_id: VICTIM }, { email: 'victim@example.com' }, { mailbox: 'victim@example.com' }]) {
    await assert.rejects(
      () => executeInboxTool('find_contact_email', { name: 'Thorne', ...inj }, { userId: ATTACKER }),
      (err) => err instanceof InboxSecurityError && /identity_param_not_allowed/.test(err.message),
    );
  }
  // No session.
  await assert.rejects(
    () => executeInboxTool('find_contact_email', { name: 'Thorne' }, {}),
    (err) => err instanceof InboxSecurityError && /missing_session_user/.test(err.message),
  );
  // Not entitled — the mailbox is never touched.
  const log = harness({ entitled: [], connected: [ATTACKER] });
  const res = await executeInboxTool('find_contact_email', { name: 'Thorne' }, { userId: ATTACKER });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_entitled');
  assert.deepEqual(log.mailClientUserIds, []);
});

test('find_contact_email logs no address, name or subject', async () => {
  const line = JSON.stringify(redactForLog({
    tool: 'find_contact_email',
    provider: 'google',
    ok: true,
    count: 2,
    mailbox: MAILBOX,
    contacts: [{ name: 'Marcus Thorne', email: 'mthorne@mail.example', last_subject: '14 Sablewood - Full Price Offer' }],
  }));
  for (const secret of ['mthorne@mail.example', 'Marcus Thorne', 'Sablewood', MAILBOX]) {
    assert.ok(!line.includes(secret), `log leaked: ${secret}`);
  }
  assert.ok(line.includes('find_contact_email'));
});
