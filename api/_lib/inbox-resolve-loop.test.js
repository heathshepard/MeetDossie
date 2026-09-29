// api/_lib/inbox-resolve-loop.test.js
//
// Tests the server-side inbox resolve loop — the part that makes "we received
// an offer on Nopalito, put it all together" a single spoken turn instead of
// three round trips through the browser.
//
// Run with:  node --test api/_lib/inbox-resolve-loop.test.js
//
// No network: both the model and the tool executor are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runInboxResolveLoop, MAX_INBOX_TOOL_CALLS } = require('./inbox-resolve-loop.js');
const { INBOX_TOOLS, InboxSecurityError } = require('./inbox-tools.js');

const USER = '00000000-1111-4111-8111-000000000001';

// Stand-in for chat.js's TOOLS: a few of the real client-dispatched tools plus
// the inbox tools, which is the shape the loop actually sees.
const TOOLS = [
  { name: 'log_offer', input_schema: { type: 'object', properties: {} } },
  { name: 'draft_email', input_schema: { type: 'object', properties: {} } },
  { name: 'answer_question', input_schema: { type: 'object', properties: {} } },
  ...INBOX_TOOLS,
];

const toolUse = (name, input = {}, id = `tu-${name}`) => ({ type: 'tool_use', id, name, input });
const baseArgs = () => ({
  model: 'claude-sonnet-5',
  tools: TOOLS,
  messages: [{ role: 'user', content: 'we received an offer on Nopalito' }],
});

test('a turn that never touches the inbox is returned untouched and costs nothing', async () => {
  let modelCalls = 0;
  const first = { content: [toolUse('log_offer', { deal_identifier: 'Nopalito', offer_price: 999000 })] };

  const out = await runInboxResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: first,
    userId: USER,
    createMessage: async () => { modelCalls += 1; return { content: [] }; },
    executeInboxTool: async () => { throw new Error('must not run'); },
  });

  assert.equal(out, first);
  assert.equal(modelCalls, 0, 'a non-inbox turn must not cost an extra model call');
});

test('search -> read -> import resolves server-side and ends on a client action', async () => {
  const executed = [];
  const sessionsSeen = [];
  const script = [
    { content: [toolUse('read_email', { message_id: 'm1' })] },
    { content: [toolUse('import_email_attachments', { message_id: 'm1', deal_identifier: '23 Nopalito' })] },
    {
      content: [
        { type: 'text', text: 'Revised offer at $999,000 — I filed all seven documents.' },
        toolUse('log_offer', { deal_identifier: '23 Nopalito', offer_price: 999000 }),
      ],
    },
  ];
  let step = 0;
  let lastArgs = null;

  const out = await runInboxResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: { content: [toolUse('search_inbox', { query: 'nopalito' })] },
    userId: USER,
    createMessage: async (args) => { lastArgs = args; return script[step++]; },
    executeInboxTool: async (name, input, session) => {
      executed.push(name);
      sessionsSeen.push(session.userId);
      return { ok: true, tool: name };
    },
  });

  assert.deepEqual(executed, ['search_inbox', 'read_email', 'import_email_attachments']);
  // Identity is threaded from the verified session on every single hop.
  assert.deepEqual(sessionsSeen, [USER, USER, USER]);

  const final = out.content.find((b) => b.type === 'tool_use');
  assert.equal(final.name, 'log_offer');
  assert.equal(final.input.offer_price, 999000);

  const results = lastArgs.messages.filter(
    (m) => Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result',
  );
  assert.equal(results.length, 3, 'every resolved call must be fed back for the model to reason over');
});

test('the inbox call budget is hard-capped and the model is forced to conclude', async () => {
  let calls = 0;
  let sawInboxToolsOnLastCall = null;

  const out = await runInboxResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: { content: [toolUse('search_inbox', { query: 'a' }, 'tu-0')] },
    userId: USER,
    // A model that would happily keep searching forever.
    createMessage: async (args) => {
      calls += 1;
      sawInboxToolsOnLastCall = args.tools.some((t) => t.name === 'search_inbox');
      return { content: [toolUse('search_inbox', { query: 'a' }, `tu-${calls}`)] };
    },
    executeInboxTool: async () => ({ ok: true }),
  });

  assert.equal(calls, MAX_INBOX_TOOL_CALLS);
  assert.equal(sawInboxToolsOnLastCall, false, 'inbox tools must be withdrawn on the final permitted turn');
  assert.ok(out);
});

test('an attempted identity override collapses the turn, it does not retry', async () => {
  let modelCalls = 0;

  const out = await runInboxResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: { content: [toolUse('search_inbox', { query: 'x', user_id: 'someone-else' })] },
    userId: USER,
    createMessage: async () => { modelCalls += 1; return { content: [] }; },
    executeInboxTool: async () => { throw new InboxSecurityError('identity_param_not_allowed:user_id'); },
  });

  assert.equal(out.content[0].name, 'answer_question');
  assert.equal(modelCalls, 0, 'a refused turn must not be re-prompted — that just teaches a rephrase');
  assert.ok(!JSON.stringify(out).includes('someone-else'));
});

test('a non-security tool failure still propagates rather than being swallowed', async () => {
  await assert.rejects(
    () => runInboxResolveLoop({
      anthropicArgs: baseArgs(),
      firstResponse: { content: [toolUse('search_inbox', { query: 'x' })] },
      userId: USER,
      createMessage: async () => ({ content: [] }),
      executeInboxTool: async () => { throw new Error('upstream_exploded'); },
    }),
    /upstream_exploded/,
  );
});

test('a not_connected result still reaches the model as a tool_result', async () => {
  let seen = null;
  const out = await runInboxResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: { content: [toolUse('search_inbox', { query: 'nopalito' })] },
    userId: USER,
    createMessage: async (args) => {
      seen = args.messages.at(-1).content[0].content;
      return { content: [toolUse('answer_question', { response: 'Connect your inbox in Settings.' })] };
    },
    executeInboxTool: async () => ({ ok: false, reason: 'not_connected', message: 'connect Gmail' }),
  });

  assert.match(seen, /not_connected/);
  assert.equal(out.content[0].name, 'answer_question');
});
