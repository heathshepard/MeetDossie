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

test('a non-security failure is appended as an error tool_result, not thrown — the member keeps the turn', async () => {
  const first = { content: [toolUse('remember_preference', { category: 'preference', title: 'x', content: 'y' })] };
  let seenResult = null;
  const out = await runServerToolResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: first,
    userId: USER,
    createMessage: async (args) => {
      const lastMsg = args.messages[args.messages.length - 1];
      seenResult = lastMsg.content[0];
      return { content: [toolUse('answer_question', { response: 'Ran into a snag saving that, but here is what I can tell you.' })] };
    },
    executeMemoryTool: async () => { throw new Error('db down'); },
  });
  assert.equal(seenResult.type, 'tool_result');
  assert.equal(seenResult.is_error, true);
  assert.match(seenResult.content, /db down/);
  assert.equal(out.content[0].name, 'answer_question');
});

test('two parallel tool_use blocks in one turn BOTH get a tool_result — the 2026-09-24 prod defect', async () => {
  const first = {
    content: [
      toolUse('remember_preference', { category: 'preference', title: 'a', content: 'b' }, 'tu-1'),
      toolUse('remember_fact', { category: 'other', title: 'c', content: 'd' }, 'tu-2'),
    ],
  };
  let seenResultBlocks = null;
  const out = await runServerToolResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: first,
    userId: USER,
    createMessage: async (args) => {
      const lastMsg = args.messages[args.messages.length - 1];
      seenResultBlocks = lastMsg.content;
      return { content: [toolUse('answer_question', { response: 'done' })] };
    },
    executeMemoryTool: async (name) => ({ ok: true, saved: name }),
  });
  assert.equal(seenResultBlocks.length, 2);
  assert.deepEqual(seenResultBlocks.map((b) => b.tool_use_id), ['tu-1', 'tu-2']);
  assert.ok(seenResultBlocks.every((b) => b.type === 'tool_result'));
  assert.equal(out.content[0].name, 'answer_question');
});

test('a parallel turn mixing a server tool with a client-dispatchable action never leaves a tool_use without a result', async () => {
  const first = {
    content: [
      toolUse('remember_preference', { category: 'preference', title: 'a', content: 'b' }, 'tu-server'),
      toolUse('answer_question', { response: 'premature' }, 'tu-client'),
    ],
  };
  let seenResultBlocks = null;
  const out = await runServerToolResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: first,
    userId: USER,
    createMessage: async (args) => {
      const lastMsg = args.messages[args.messages.length - 1];
      seenResultBlocks = lastMsg.content;
      return { content: [toolUse('answer_question', { response: 'now for real' })] };
    },
    executeMemoryTool: async () => ({ ok: true }),
  });
  assert.equal(seenResultBlocks.length, 2);
  const clientResult = seenResultBlocks.find((b) => b.tool_use_id === 'tu-client');
  assert.ok(clientResult, 'the client-action block must still get a tool_result');
  assert.match(clientResult.content, /deferred/);
  assert.equal(out.content[0].input.response, 'now for real');
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

test('every message sent to the model has a tool_result for every prior tool_use — no orphans, even when the last turn overshoots the call budget with parallel blocks', async () => {
  // MAX_SERVER_TOOL_CALLS is 6. Drive the budget to exactly 5 with single
  // calls, then land a FINAL response with 2 parallel server tool_use
  // blocks — the exact shape that broke prod (find_contact_email x2 in one
  // turn). Assert every createMessage call this test makes is internally
  // valid: every tool_use id in an assistant message has a matching
  // tool_result in the very next message.
  function assertNoOrphanedToolUse(messages) {
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      const toolUseIds = msg.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
      if (toolUseIds.length === 0) continue;
      const next = messages[i + 1];
      const resultIds = (next && Array.isArray(next.content))
        ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)
        : [];
      for (const id of toolUseIds) {
        assert.ok(resultIds.includes(id), `tool_use ${id} has no tool_result in the following message`);
      }
    }
  }

  let turn = 0;
  const out = await runServerToolResolveLoop({
    anthropicArgs: baseArgs(),
    firstResponse: { content: [toolUse('remember_preference', { category: 'preference', title: 'x', content: 'y' }, 'tu-0')] },
    userId: USER,
    createMessage: async (args) => {
      assertNoOrphanedToolUse(args.messages);
      turn += 1;
      if (turn < 4) return { content: [toolUse('remember_preference', { category: 'preference', title: 'x', content: 'y' }, `tu-${turn}`)] };
      // Turn 4: two parallel server tool_use blocks land while only 1-2
      // budget slots remain (5 calls already spent by turns 0-3... this
      // response adds 2 more = 7, over budget — must still resolve both).
      return {
        content: [
          toolUse('remember_preference', { category: 'preference', title: 'x', content: 'y' }, 'tu-parallel-a'),
          toolUse('remember_fact', { category: 'other', title: 'x', content: 'y' }, 'tu-parallel-b'),
        ],
      };
    },
    executeMemoryTool: async () => ({ ok: true }),
  });
  assertNoOrphanedToolUse([...baseArgs().messages]); // sanity: helper works on empty case
  assert.ok(out.content[0]); // loop terminated with a real response, not a throw
});
