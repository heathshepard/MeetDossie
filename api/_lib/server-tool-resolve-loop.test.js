// api/_lib/server-tool-resolve-loop.test.js
//
// Tests the generalized resolve loop that lets api/chat.js's action mode
// resolve inbox tools AND member-memory tools server-side within one turn,
// including a turn that calls one of each in sequence — the composition case
// that motivated generalizing api/_lib/inbox-resolve-loop.js instead of
// chaining two independent loops (see the header of this module).
//
// Run with: node --test api/_lib/server-tool-resolve-loop.test.js
//
// No network: both the model and the tool executors are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runServerToolResolveLoop, MAX_SERVER_TOOL_CALLS } = require('./server-tool-resolve-loop.js');
const { MemorySecurityError } = require('./member-memory-tools.js');

const USER = '00000000-1111-4111-8111-000000000001';

const toolUse = (name, input = {}, id = `tu-${name}`) => ({ type: 'tool_use', id, name, input });
const baseArgs = () => ({
  model: 'claude-sonnet-5',
  tools: [
    { name: 'answer_question' }, { name: 'log_offer' },
    { name: 'search_inbox' }, { name: 'read_email' },
    { name: 'remember_preference' }, { name: 'remember_fact' },
  ],
  messages: [{ role: 'user', content: 'hi' }],
});

test('a turn that never touches a server tool is returned untouched', async () => {
  let modelCalls = 0;
  const first = { content: [toolUse('log_offer', { deal_identifier: 'Nopalito' })] };
  const out = await runServerToolResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: first,
    userId: USER,
    createMessage: async () => { modelCalls += 1; return { content: [] }; },
    executeInboxTool: async () => { throw new Error('must not run'); },
    executeMemoryTool: async () => { throw new Error('must not run'); },
  });
  assert.equal(out, first);
  assert.equal(modelCalls, 0);
});

test('remember_preference resolves server-side and the model continues to a client action', async () => {
  const executed = [];
  const script = [
    { content: [toolUse('remember_preference', { category: 'preference', title: 'Title co', content: 'Uses Independence Title' })] },
    { content: [toolUse('answer_question', { response: 'Got it.' })] },
  ];
  let i = 0;
  const out = await runServerToolResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: script[0],
    userId: USER,
    createMessage: async () => script[++i],
    executeMemoryTool: async (name, input, ctx) => {
      executed.push({ name, input, ctx });
      return { ok: true, action: 'saved' };
    },
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, 'remember_preference');
  assert.equal(executed[0].ctx.userId, USER);
  assert.equal(out.content[0].name, 'answer_question');
});

test('an inbox call followed by a memory call in the SAME turn both resolve, in order', async () => {
  const order = [];
  const script = [
    { content: [toolUse('search_inbox', { query: 'Nopalito' })] },
    { content: [toolUse('remember_fact', { category: 'financial_fact', title: 'Payoff lender', content: 'Chase, ~$210k' })] },
    { content: [toolUse('answer_question', { response: 'Found it and noted the payoff.' })] },
  ];
  let i = 0;
  const out = await runServerToolResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: script[0],
    userId: USER,
    createMessage: async () => script[++i],
    executeInboxTool: async (name) => { order.push(`inbox:${name}`); return { ok: true, results: [] }; },
    executeMemoryTool: async (name) => { order.push(`memory:${name}`); return { ok: true, action: 'saved' }; },
  });
  assert.deepEqual(order, ['inbox:search_inbox', 'memory:remember_fact']);
  assert.equal(out.content[0].name, 'answer_question');
});

test('an identity-shaped field reaching a memory tool collapses the turn instead of retrying', async () => {
  const first = { content: [toolUse('remember_fact', { category: 'other', title: 'x', content: 'y', user_id: 'forged' })] };
  const out = await runServerToolResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: first,
    userId: USER,
    createMessage: async () => { throw new Error('must not retry'); },
    executeMemoryTool: async () => { throw new MemorySecurityError('identity-shaped field'); },
  });
  assert.equal(out.content[0].name, 'answer_question');
});

test('a non-security failure still propagates rather than being swallowed', async () => {
  const first = { content: [toolUse('remember_preference', { category: 'preference', title: 'x', content: 'y' })] };
  await assert.rejects(
    runServerToolResolveLoop({
      anthropicArgs: baseArgs(),
      firstResponse: first,
      userId: USER,
      createMessage: async () => { throw new Error('must not be called'); },
      executeMemoryTool: async () => { throw new Error('db down'); },
    }),
    /db down/
  );
});

test('the shared call budget is hard-capped across both tool groups', async () => {
  const first = { content: [toolUse('search_inbox', {})] };
  let calls = 0;
  const out = await runServerToolResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: first,
    userId: USER,
    createMessage: async (args) => {
      calls += 1;
      // A real model can only return a tool_use for a tool still present in
      // the schema it was given — mirror that here rather than a mock that
      // ignores withdrawal, which would prove nothing about the cap.
      const serverToolsStillOffered = args.tools.some((t) => t.name === 'search_inbox' || t.name === 'remember_preference');
      if (!serverToolsStillOffered) return { content: [toolUse('answer_question', { response: 'done' })] };
      return { content: [toolUse(calls % 2 === 0 ? 'search_inbox' : 'remember_preference', { category: 'preference', title: 'x', content: 'y' })] };
    },
    executeInboxTool: async () => ({ ok: true }),
    executeMemoryTool: async () => ({ ok: true }),
  });
  assert.ok(calls <= MAX_SERVER_TOOL_CALLS);
  // Final response must not itself be a server tool — the last iteration
  // withdraws both tool groups so the model is forced to conclude.
  const finalName = out.content[0] && out.content[0].name;
  assert.ok(!['search_inbox', 'remember_preference', 'remember_fact'].includes(finalName));
});
