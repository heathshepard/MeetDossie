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
    const toolUse = (response.content || []).find((b) => b.type === 'tool_use');
    if (!toolUse || !SERVER_TOOL_NAMES.has(toolUse.name)) return response;

    calls += 1;

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
        // An identity-shaped parameter reached a tool call. Refuse the whole
        // turn rather than re-prompting — a retry would just teach the model
        // to rephrase the same attempt.
        console.error('[chat:server-tools] refusing turn:', err.message);
        return {
          content: [{
            type: 'tool_use',
            name: 'answer_question',
            input: { response: 'I ran into a problem with that just now. Try asking me again.' },
          }],
        };
      }
      throw err;
    }

    conversation.push({ role: 'assistant', content: response.content });
    conversation.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(toolResult),
      }],
    });

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
