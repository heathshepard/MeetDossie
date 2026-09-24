// api/_lib/server-tool-resolve-loop.js
//
// Generalizes api/_lib/inbox-resolve-loop.js to cover every tool group that
// gets resolved server-side inside api/chat.js's action mode, in one pass —
// today that's the inbox tools (search_inbox/read_email/find_contact_email/
// import_email_attachments), the member-memory tools (remember_preference/
// remember_fact), and the Form Library tools (list_form_library/
// attach_form_to_deal). A single model turn may call tools from more than one
// group (or the same group repeatedly) before landing on whatever
// client-dispatchable action it concludes with; one shared conversation/
// tool-count loop is what keeps that composable — independent loops each
// reconstructing `conversation` from scratch would silently drop whichever
// group's exchange ran first.
//
// api/_lib/inbox-resolve-loop.js is left in place and untouched (still
// exported, still covered by its own test) — this module supersedes it as
// what api/chat.js actually calls, but nothing needed to change there.
//
// Owner: Carter, 2026-09-21.

const { INBOX_TOOL_NAMES, executeInboxTool: defaultExecuteInboxTool, InboxSecurityError } = require('./inbox-tools');
const { MEMORY_TOOL_NAMES, executeMemoryTool: defaultExecuteMemoryTool, MemorySecurityError } = require('./member-memory-tools');
const { FORM_LIBRARY_TOOL_NAMES, executeFormLibraryTool: defaultExecuteFormLibraryTool, FormLibrarySecurityError } = require('./form-library-tools');
const { CONTRACT_EXTRACTION_TOOL_NAMES, executeContractExtractionTool: defaultExecuteContractExtractionTool, ContractExtractionSecurityError } = require('./contract-extraction-tools');

// 4 inbox calls (search -> read -> import, +1 headroom, per
// inbox-resolve-loop.js's own reasoning) + a couple of memory writes + a
// form library list/attach pair is enough for any real turn without giving a
// runaway loop room to walk any one surface indefinitely.
const MAX_SERVER_TOOL_CALLS = 6;

const SERVER_TOOL_NAMES = new Set([...INBOX_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...FORM_LIBRARY_TOOL_NAMES, ...CONTRACT_EXTRACTION_TOOL_NAMES]);

/**
 * @param {object}   args
 * @param {object}   args.anthropicArgs   the exact args used for the first model call
 * @param {object}   args.firstResponse   that call's result
 * @param {string}   args.userId          verified-session user id — NEVER from tool input
 * @param {Function} args.createMessage   (args) => Promise<response>
 * @param {Function} [args.executeInboxTool]        overridable for tests
 * @param {Function} [args.executeMemoryTool]       overridable for tests
 * @param {Function} [args.executeFormLibraryTool]  overridable for tests
 */
async function runServerToolResolveLoop({
  anthropicArgs,
  firstResponse,
  userId,
  createMessage,
  executeInboxTool = defaultExecuteInboxTool,
  executeMemoryTool = defaultExecuteMemoryTool,
  executeFormLibraryTool = defaultExecuteFormLibraryTool,
  executeContractExtractionTool = defaultExecuteContractExtractionTool,
}) {
  let response = firstResponse;
  const conversation = [...anthropicArgs.messages];
  let calls = 0;

  while (calls < MAX_SERVER_TOOL_CALLS) {
    // Claude's tool use is NOT limited to one tool_use block per turn — with
    // tool_choice: 'auto' (the only mode this loop is ever called with) the
    // model is free to return several tool_use blocks in the same response,
    // e.g. two find_contact_email calls to resolve two different recipients
    // in one turn. The Anthropic API requires EVERY tool_use block to have a
    // matching tool_result in the immediately following message — miss one
    // and the *next* createMessage call is rejected outright with a 400
    // ("tool_use ids were found without tool_result blocks"), which is
    // exactly what took prod down on 2026-09-24: this loop used to grab only
    // the first tool_use via .find(), so the second block in a parallel
    // response was silently left without a result.
    const allToolUses = (response.content || []).filter((b) => b.type === 'tool_use');
    const serverToolUses = allToolUses.filter((b) => SERVER_TOOL_NAMES.has(b.name));

    // Nothing left for this loop to resolve — either a plain text reply, or
    // every tool_use block in this turn is a client-dispatchable action
    // (the terminal case chat.js's handleActionMode already knows how to
    // dispatch). Hand the response back untouched.
    if (serverToolUses.length === 0) return response;

    conversation.push({ role: 'assistant', content: response.content });

    const resultBlocks = [];
    let refused = false;

    // Resolve EVERY tool_use block in this turn, not just the server ones —
    // a client-dispatchable action riding alongside a server tool call in
    // the same parallel turn still needs a tool_result or the next model
    // call is malformed exactly the same way.
    for (const toolUse of allToolUses) {
      if (!SERVER_TOOL_NAMES.has(toolUse.name)) {
        // Can't execute a client action here, and can't hand a
        // half-resolved response back to the browser mid-turn either — park
        // it with a result telling the model to reissue it once its
        // sibling calls have resolved.
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ ok: false, deferred: true, reason: 'other tool calls in this turn are still resolving — reissue this call on its own once you have their results' }),
        });
        continue;
      }

      let toolResult;
      try {
        if (INBOX_TOOL_NAMES.has(toolUse.name)) {
          toolResult = await executeInboxTool(toolUse.name, toolUse.input || {}, { userId });
        } else if (MEMORY_TOOL_NAMES.has(toolUse.name)) {
          toolResult = await executeMemoryTool(toolUse.name, toolUse.input || {}, { userId });
        } else if (FORM_LIBRARY_TOOL_NAMES.has(toolUse.name)) {
          toolResult = await executeFormLibraryTool(toolUse.name, toolUse.input || {}, { userId });
        } else {
          toolResult = await executeContractExtractionTool(toolUse.name, toolUse.input || {}, { userId });
        }
      } catch (err) {
        if (err instanceof InboxSecurityError || err instanceof MemorySecurityError || err instanceof FormLibrarySecurityError || err instanceof ContractExtractionSecurityError) {
          // An identity-shaped parameter reached a tool call. Refuse the
          // whole turn rather than re-prompting — a retry would just teach
          // the model to rephrase the same attempt. Every block already
          // queued (including this one) still gets a result so nothing here
          // is ever reused malformed, even though we're about to discard
          // `conversation` and return a synthetic response instead.
          console.error('[chat:server-tools] refusing turn:', err.message);
          resultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ ok: false, error: 'refused' }), is_error: true });
          refused = true;
          break;
        }
        // A real (non-security) tool failure. Appending an error result and
        // letting the model see it beats throwing here: throwing loses the
        // entire turn and the member sees a generic "failed to generate a
        // response, try again" — misleading, since retrying resends the
        // exact same request and fails the exact same way. An error
        // tool_result gives the model a chance to apologize, retry a
        // different way, or ask a clarifying question instead.
        console.error('[chat:server-tools] tool error, appending error result:', toolUse.name, err && err.message);
        resultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ ok: false, error: (err && err.message) || 'tool_failed' }), is_error: true });
        continue;
      }

      calls += 1;
      resultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(toolResult) });
    }

    if (refused) {
      return {
        content: [{
          type: 'tool_use',
          name: 'answer_question',
          input: { response: 'I ran into a problem with that just now. Try asking me again.' },
        }],
      };
    }

    conversation.push({ role: 'user', content: resultBlocks });

    const isLastAllowed = calls >= MAX_SERVER_TOOL_CALLS;
    response = await createMessage({
      ...anthropicArgs,
      messages: conversation,
      // On the final permitted iteration, withdraw the server-resolved tools
      // entirely so the model must conclude with a client-dispatchable action.
      tools: isLastAllowed
        ? anthropicArgs.tools.filter((t) => !SERVER_TOOL_NAMES.has(t.name))
        : anthropicArgs.tools,
    });
  }

  return response;
}

module.exports = { runServerToolResolveLoop, MAX_SERVER_TOOL_CALLS, SERVER_TOOL_NAMES };
