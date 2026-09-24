// api/_lib/inbox-resolve-loop.js
//
// The server-side tool-resolve loop that makes the inbox tools usable from
// api/chat.js's action mode.
//
// api/chat.js has always been single-turn: one model call, take the first
// tool_use block, hand it to the browser to dispatch. Inbox work cannot fit
// that shape — search, read and import are only useful when each step's RESULT
// feeds the next choice. So those three tools (and only those three) are
// executed here and fed back as tool_result blocks until the model concludes
// with something the client already knows how to dispatch.
//
// The client contract does not change. Whatever non-inbox tool the model lands
// on at the end (log_offer, draft_email, answer_question, ...) is returned in
// exactly the shape the browser has always received.
//
// Lives in _lib rather than inline in chat.js so it is testable: chat.js mixes
// CJS require() with ESM export syntax and cannot be imported by node --test.
//
// Built 2026-09-19 — docs/DOSSIE-INBOX-CAPABILITY-SCOPE.md §4.

const { INBOX_TOOL_NAMES, executeInboxTool: defaultExecuteInboxTool, InboxSecurityError } = require('./inbox-tools');

// Maximum inbox tool calls resolved server-side within a single chat turn.
// search -> read -> import is three; the fourth is headroom for one widened
// re-search. A hard cap, not a heuristic: without it a model loop could walk a
// mailbox one message at a time, which is a data-exfil shape as much as a cost
// problem.
const MAX_INBOX_TOOL_CALLS = 4;

/**
 * @param {object}   args
 * @param {object}   args.anthropicArgs   the exact args used for the first model call
 * @param {object}   args.firstResponse   that call's result
 * @param {string}   args.userId          verified-session user id — NEVER from tool input
 * @param {Function} args.createMessage   (args) => Promise<response>
 * @param {Function} [args.executeInboxTool]  overridable for tests
 */
async function runInboxResolveLoop({
  anthropicArgs,
  firstResponse,
  userId,
  createMessage,
  executeInboxTool = defaultExecuteInboxTool,
}) {
  let response = firstResponse;
  const conversation = [...anthropicArgs.messages];
  let inboxCalls = 0;

  while (inboxCalls < MAX_INBOX_TOOL_CALLS) {
    // tool_choice: 'auto' lets the model return more than one tool_use block
    // per turn (e.g. two search_inbox calls in parallel). Every tool_use
    // block must get a matching tool_result in the next message or the
    // following createMessage call is rejected by the API outright — see the
    // identical, and live, defect this was generalized into at
    // server-tool-resolve-loop.js (2026-09-24 incident). This loop is not
    // currently wired into api/chat.js (superseded), but is fixed the same
    // way since it is still exported and tested.
    const allToolUses = (response.content || []).filter((b) => b.type === 'tool_use');
    const inboxToolUses = allToolUses.filter((b) => INBOX_TOOL_NAMES.has(b.name));
    if (inboxToolUses.length === 0) return response;

    conversation.push({ role: 'assistant', content: response.content });

    const resultBlocks = [];
    let refused = false;

    for (const toolUse of allToolUses) {
      if (!INBOX_TOOL_NAMES.has(toolUse.name)) {
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ ok: false, deferred: true, reason: 'other tool calls in this turn are still resolving — reissue this call on its own once you have their results' }),
        });
        continue;
      }

      let toolResult;
      try {
        // userId is passed as its own argument. It is deliberately NOT merged
        // into toolUse.input — see the header of api/_lib/inbox-tools.js.
        toolResult = await executeInboxTool(toolUse.name, toolUse.input || {}, { userId });
      } catch (err) {
        if (err instanceof InboxSecurityError) {
          // An identity-shaped parameter reached a tool call. Refuse the
          // whole turn rather than re-prompting — a retry would just teach
          // the model to rephrase the same attempt.
          console.error('[chat:inbox] refusing turn:', err.message);
          resultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ ok: false, error: 'refused' }), is_error: true });
          refused = true;
          break;
        }
        console.error('[chat:inbox] tool error, appending error result:', toolUse.name, err && err.message);
        resultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ ok: false, error: (err && err.message) || 'tool_failed' }), is_error: true });
        continue;
      }

      inboxCalls += 1;
      resultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(toolResult) });
    }

    if (refused) {
      return {
        content: [{
          type: 'tool_use',
          name: 'answer_question',
          input: { response: 'I ran into a problem reading your inbox just then. Try asking me again.' },
        }],
      };
    }

    conversation.push({ role: 'user', content: resultBlocks });

    const isLastAllowed = inboxCalls >= MAX_INBOX_TOOL_CALLS;
    response = await createMessage({
      ...anthropicArgs,
      messages: conversation,
      // On the final permitted iteration, withdraw the inbox tools entirely so
      // the model must conclude with a client-dispatchable action instead of
      // reaching for a fifth read.
      tools: isLastAllowed
        ? anthropicArgs.tools.filter((t) => !INBOX_TOOL_NAMES.has(t.name))
        : anthropicArgs.tools,
    });
  }

  return response;
}

module.exports = { runInboxResolveLoop, MAX_INBOX_TOOL_CALLS };
