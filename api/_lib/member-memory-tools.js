// api/_lib/member-memory-tools.js
//
// The two memory-write tools exposed to api/chat.js's action mode, resolved
// server-side inside the same tool-resolve loop that already handles the
// inbox tools (api/_lib/server-tool-resolve-loop.js) — the model calls one
// of these, gets a result back in the SAME turn, and continues toward
// whatever real answer/action it was already building. No client dispatch
// required; nothing here reaches the browser as a tool_use the UI has to
// handle.
//
// Two tools, two trust levels — this split is Heath's and is not
// negotiable (see supabase/migrations/20260921_member_memory.sql header):
//   remember_preference — workflow habits / preferences. Learned silently.
//   remember_fact       — a fact about a person, money, or a file. Always
//                          starts pending_confirmation; never reused until
//                          the member confirms it in the memory view.
//
// SECURITY: userId is passed as its own argument from api/chat.js (derived
// from verifySupabaseToken), exactly like the inbox tools — never merged
// into the tool's own input, and there is no user-id-shaped field in either
// tool's schema below.
//
// Owner: Carter, 2026-09-21.

const {
  VALID_CATEGORIES, SILENTLY_LEARNABLE_CATEGORIES,
  sbPost, embedText, toPgVectorLiteral, findDuplicate, bumpUsage,
} = require('./member-memory');

const MEMORY_TOOLS = [
  {
    name: 'remember_preference',
    description:
      "Silently note a workflow preference or habit for THIS member so future conversations already know it — a preferred title company, a typical option fee/period, wanting a net sheet before an offer summary, an email tone preference. Use when the agent states or clearly repeats a preference about HOW they like to work, not a fact about a specific client or deal. Call this quietly alongside whatever else you're doing — never announce that you're remembering something, never ask permission first. Do NOT use for a fact about a person, money, or a file (a payoff, a lender, a client's deadline) — use remember_fact for that instead.",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['preference', 'workflow', 'communication_style'],
          description: 'preference = a standing default (title company, option terms). workflow = an order-of-operations habit. communication_style = tone/formality.',
        },
        title: { type: 'string', description: 'Short label, e.g. "Preferred title company".' },
        content: { type: 'string', description: 'The preference itself, in one clear sentence, as a fact about the member (not addressed to them).' },
      },
      required: ['category', 'title', 'content'],
    },
  },
  {
    name: 'remember_fact',
    description:
      "Note a stated fact about a person, money, or a file for THIS member, for possible reuse in a LATER conversation — a payoff amount, a lender name, a client's personal deadline, something about a specific contact. This is NOT how you record something onto the current deal (that is still update_deal_field/capture_seller_intake) — it is a side memory for Dossie herself to recall later. It is saved as unconfirmed and will not be reused anywhere until the member confirms it themselves, so do not treat it as verified once saved, and do not tell the member it is now a known fact — a brief, un-fussy acknowledgment that you noted it is fine, nothing more.",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['contact', 'financial_fact', 'deal_fact', 'other'],
        },
        title: { type: 'string', description: 'Short label, e.g. "Nopalito payoff lender".' },
        content: { type: 'string', description: 'The fact itself, in one clear sentence, as a fact about the member/their file (not addressed to them).' },
      },
      required: ['category', 'title', 'content'],
    },
  },
];

const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name));

class MemorySecurityError extends Error {}

async function executeMemoryTool(name, input, { userId }) {
  if (!userId) throw new MemorySecurityError('member-memory tool called without a verified user id');
  // Defense in depth against a future edit that adds a user-id-shaped field
  // to one of the schemas above by mistake.
  if (input && (input.user_id || input.userId)) {
    throw new MemorySecurityError('memory tool input carried an identity-shaped field');
  }

  const category = VALID_CATEGORIES.has(input.category) ? input.category : 'other';
  const title = String(input.title || '').trim().slice(0, 200);
  const content = String(input.content || '').trim().slice(0, 4000);
  if (!title || title.length < 3) return { ok: false, error: 'title too short' };
  if (!content || content.length < 5) return { ok: false, error: 'content too short' };

  const isPreference = name === 'remember_preference';
  // A preference tool call is still forced into the silently-learnable set
  // even if the model mis-picks a category — and a fact call is NEVER
  // silently active, regardless of what category it picked. The tool
  // choice, not the category field, is what decides the trust level.
  const source = isPreference ? 'inferred' : 'stated';
  const status = (isPreference && SILENTLY_LEARNABLE_CATEGORIES.has(category)) ? 'active' : (
    isPreference ? 'active' : 'pending_confirmation'
  );

  const embedSource = `${title}\n\n${content}`;
  let embedding = null;
  try {
    embedding = await embedText(embedSource);
  } catch (err) {
    console.warn('[member-memory-tools] embed failed, saving without embedding:', err.message);
  }

  // Dedupe only within the same trust tier — merging a new pending fact into
  // an old confirmed one would silently upgrade an unconfirmed claim.
  if (embedding) {
    try {
      const dup = await findDuplicate(userId, category, embedding, 0.90);
      if (dup && ((dup.status === 'active') === (status === 'active'))) {
        await bumpUsage([dup.id]);
        return { ok: true, action: 'merged', memory_id: dup.id, status: dup.status };
      }
    } catch (err) {
      console.warn('[member-memory-tools] dedupe check failed, inserting anyway:', err.message);
    }
  }

  const row = {
    user_id: userId,
    category,
    title,
    content,
    source,
    status,
    embedding: embedding ? toPgVectorLiteral(embedding) : null,
  };

  try {
    const inserted = await sbPost('member_memory', row);
    const saved = Array.isArray(inserted) ? inserted[0] : inserted;
    return { ok: true, action: 'saved', memory_id: saved && saved.id, status };
  } catch (err) {
    console.error('[member-memory-tools] insert failed:', err.message);
    return { ok: false, error: 'could not save that' };
  }
}

module.exports = { MEMORY_TOOLS, MEMORY_TOOL_NAMES, executeMemoryTool, MemorySecurityError };
