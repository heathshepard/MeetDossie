# Dossie Inbox Capability — Scope

**Written 2026-09-19. Status: scope agreed, tools built, demo blocked on one human action (see §8).**

The target sentence, spoken by a subscriber driving:

> "Hey Dossie, we received an offer on Nopalito. Compose a net sheet and offer summary,
> put all the documents together with the pre-approval, and send it to the sellers."

This document scopes the part of that sentence Dossie cannot do today at all: **reading the
member's own inbox.** Everything downstream of the read (net sheet, offer log, packet, send)
either exists or is named precisely in §7 as a remaining gap.

Nothing here may be filmed until §8 is green. Per `dossie-demo-must-match-real-capability.md`,
a demo of a feature that does not work is worse than any other fabrication, because the
prospect acts on it.

---

## 1. The reference implementation — what the manual run actually did

On 2026-09-19 this workflow was performed by hand for Heath. Working code and artifacts:
`/mnt/c/Users/Heath/Projects/MeetDossie/.tmp/nopalito-offer/` (`fetch.py`, `contract.txt`,
`tpfa.txt`, 12 PDFs).

The real sequence was:

1. Search Gmail for `nopalito` → one message from the buyer's agent (`1a0bac469e74746c`).
2. Read the message; recognise it **supersedes** an earlier offer.
3. Download 7 PDF attachments (`fetch.py` — walks `payload.parts` recursively for any part
   with both a `filename` and a `body.attachmentId`, then base64url-decodes each).
4. Extract text and read TREC 20-19 paragraph by paragraph: price, financing, option period,
   earnest money, ¶7D election, ¶12B compensation, closing date.
5. Pull relationship context (sellers own outright, who corresponds, price-cut history).
6. Build a net sheet + offer summary, send it to the sellers with the documents attached.

**Two things this run proves that change the tool design** (§3):

- Step 4 is not "read the attachment." It is *document identification followed by structured
  field extraction*, which `api/scan-contract.js` already does better than raw text would —
  it identifies the form, extracts ~40 TREC fields, and builds the deadline chain off
  `api/_lib/business-calendar.js`. Handing raw PDF text to the chat model would throw that
  away and re-derive deadlines by hand, which the `DEADLINE AUTHORITY` prompt block in
  `api/chat.js` explicitly forbids.
- Step 2 mattered. The correct answer depended on noticing an *earlier* offer existed. A tool
  that returns one message in isolation cannot support that; search has to return enough of a
  thread's shape for the model to notice supersession.

---

## 2. What already exists — verified, not assumed

Each row below was read in this repo or queried against the live database today.

| Thing | Status | Evidence |
|---|---|---|
| Per-member Google OAuth | **Shipped** | `api/google-oauth-init.js` (`PROVIDER='google_gmail'`), `api/google-oauth-callback.js`, `api/gmail-refresh.js` |
| `gmail.readonly` in the customer consent screen | **Yes** | `api/google-oauth-init.js:79-83` — `openid`, `email`, `gmail.readonly`, and a comment block forbidding the addition of `gmail.send`/`gmail.compose` |
| Per-member Microsoft OAuth | **Shipped** | `api/microsoft-oauth-init.js`, `api/microsoft-oauth-callback.js`, scope `Mail.Read` only |
| Provider-agnostic mail client | **Shipped** | `api/_lib/mail-client.js` → `makeMailClient({userId})` returns `{provider, email, tokens, client}`; the Graph side (`api/_lib/microsoft-oauth.js`) already reshapes Outlook messages into Gmail's `payload.headers` / `payload.parts` shape, so one code path serves both |
| Token refresh + persistence | **Shipped** | `api/_lib/gmail-oauth.js` `makeGmailClient` (401 → refresh → persist to the exact row id), same in `microsoft-oauth.js` |
| Message-body decoding (plain + HTML fallback, entity order) | **Shipped** | `api/_lib/gmail-oauth.js` `bodyOfMessage()` |
| Add-on entitlement lookup | **Shipped** | `api/_lib/email-integration-customers.js`, gate = `subscriptions.email_integration_enabled` AND a connected `user_integrations` row |
| Attachment fetch by id | **Shipped, both providers** | `client('messages/<id>/attachments/<aid>')` — Gmail native, Graph via `contentBytes` → base64url |
| Net sheet | **Shipped as code, not just a procedure** | `api/_lib/net-sheet-calc.js` (`calculateNetSheet`, `reconcileBreakdown`) + `api/net-sheet.js` (auth'd HTTP endpoint, prefills `sale_price`/`commission_pct`/`option_fee_credit` off the scanned contract, marks each input `contract` vs `manual`) |
| Contract identification + TREC field extraction from a PDF | **Shipped** | `api/scan-contract.js` exports `identifyDocument`, `scanContract`, `runFullScan`, `auditCompliance` |
| Multi-document email packet with attachments | **Shipped, but only to one fixed recipient** | `api/send-compliance-packet.js` — compiles every `documents` row on a transaction, downloads from the `documents` bucket, sends one Resend email with attachments. Recipient is hardcoded to `profiles.compliance_email` |
| Single plain email send | **Shipped** | `api/send-email.js` → Resend, `from: dossie@meetdossie.com`. **No attachment support** |
| `api/chat.js` action tools | **16, none can read mail** | `TOOLS` array, `api/chat.js:207-472` |

**I over-estimated the gap.** The honest size of the missing piece is **three read-only tools
and a server-side tool-resolve loop** — roughly 600 lines — not an inbox integration. The
integration was already built for the three watcher crons; it had simply never been exposed to
the conversational surface.

### 2b. The one real architectural gap in `api/chat.js`

`handleActionMode()` is **single-turn**. It calls the model once, takes the first `tool_use`
block, and returns `{action, params, message}` to the browser, which dispatches it. Only
`add_team_member` is executed server-side (`executeAddTeamMember`), and it collapses its result
into an `answer_question` so the client needs no new dispatch case.

Inbox work cannot fit that shape: search → read → import is inherently multi-step, and each
step's *result* is what the model needs in order to choose the next one. So this build adds a
bounded server-side resolve loop (§4). The client contract does not change — whatever the model
lands on at the end (`log_offer`, `draft_email`, `answer_question`, …) is returned exactly as
today.

---

## 3. The tools

The brief proposed `search_email`, `read_email`, `get_attachment`. The first two are right
(renamed `search_inbox` / `read_email`). **`get_attachment` is wrong and is not built.**

**Why not `get_attachment`.** A tool that returns attachment content to the model is the privacy
problem and the cost problem in a single call — a 500 KB TREC PDF is ~150k tokens of extracted
text per document, times seven documents, into a context that is then logged by the Anthropic
SDK metadata path. It is also strictly worse at the job: `scan-contract.js` already turns that
same PDF into identified form type + structured fields + a TREC deadline chain. So the third
tool moves the work to where the bytes already belong — the dossier — and returns only the
structured result:

### `search_inbox`

```jsonc
{
  "name": "search_inbox",
  "input_schema": {
    "type": "object",
    "properties": {
      "query":        { "type": "string",  "description": "Keywords to match — property address, street name, party name, 'offer', 'pre-approval'. Keep it to the distinguishing words." },
      "from":         { "type": "string",  "description": "Optional sender email address or domain to narrow to." },
      "days":         { "type": "integer", "description": "How many days back to look. Default 14, maximum 90." },
      "has_attachment": { "type": "boolean", "description": "Only messages carrying a file." },
      "max_results":  { "type": "integer", "description": "Default 10, maximum 20." }
    },
    "required": []
  }
}
```

Returns `{ok, provider, mailbox, count, messages:[{message_id, from_name, from_email, subject, date, snippet, attachment_count}]}`.
**Never returns a body.** `snippet` is the provider's own preview, hard-truncated to 200 chars.

### `read_email`

```jsonc
{
  "name": "read_email",
  "input_schema": {
    "type": "object",
    "properties": {
      "message_id": { "type": "string", "description": "A message_id returned by search_inbox in this same conversation." }
    },
    "required": ["message_id"]
  }
}
```

Returns `{ok, message_id, from_name, from_email, to, subject, date, body_text, body_truncated, attachments:[{attachment_id, filename, mime_type, size_bytes}]}`.
`body_text` is capped at 12,000 characters. **Attachment bytes are never returned.**

### `import_email_attachments`

```jsonc
{
  "name": "import_email_attachments",
  "input_schema": {
    "type": "object",
    "properties": {
      "message_id":      { "type": "string", "description": "The message whose attachments to file." },
      "deal_identifier": { "type": "string", "description": "Any part of the address or party name identifying the dossier to file them into." },
      "attachment_ids":  { "type": "array", "items": {"type":"string"}, "description": "Which attachments. Omit to take every PDF on the message." },
      "extract":         { "type": "boolean", "description": "Run contract identification + TREC field extraction on the primary contract. Default true." }
    },
    "required": ["message_id", "deal_identifier"]
  }
}
```

Returns `{ok, transaction_id, property_address, imported:[{filename, document_type, document_label, size_bytes, document_id}], extracted:{…TREC fields…}|null, skipped:[…], notes:[…]}`.

Behaviour: downloads each selected attachment → uploads to the `documents` Storage bucket under
`{userId}/{transactionId}/…` → inserts a `documents` row (`user_id` = session user, transaction
re-verified as the session user's) → calls `identifyDocument()` on each PDF → calls
`scanContract()` **once**, on whichever file identified as `trec-20-17`. That single-extraction
rule is a deliberate time/cost bound, not a limitation of the extractor.

---

## 4. How it hangs off what exists

```
browser (Talk to Dossie, mode:'action')
  │  Authorization: Bearer <supabase user JWT>
  ▼
api/chat.js  handler()
  │  verifySupabaseToken(req) → userId          ← the ONLY source of identity
  ▼
handleActionMode({ ..., userId })
  │  model turn 1 → tool_use: search_inbox
  │  ├─ INBOX_TOOL? → executeInboxTool(name, input, { userId })   ← userId passed positionally
  │  │                     │
  │  │                     ├─ assertInboxAccess(userId)
  │  │                     │     ├─ subscriptions.email_integration_enabled  (entitlement)
  │  │                     │     └─ makeMailClient({ userId })               (connection)
  │  │                     └─ client('messages', { q, maxResults })
  │  ├─ append tool_result, model turn 2 → read_email → …  (max 4 inbox turns)
  │  └─ model turn N → log_offer / draft_email / answer_question
  ▼
returned to the browser unchanged: { action, params, message }
```

`makeMailClient` handles the provider fork, token refresh and persistence. Nothing in this build
touches OAuth, token storage, or refresh.

### When a member has not connected an inbox

Three distinct states, three distinct spoken answers — never a generic failure, and never a
silent empty result (an empty search result and a disconnected mailbox must not look the same,
or the agent concludes "no offer came in" when the truth is "Dossie cannot see your mail"):

| State | Detection | What Dossie says |
|---|---|---|
| Not entitled | no `subscriptions` row with `email_integration_enabled=true` | "I can't read your inbox yet — Email Integration is an add-on. You can turn it on in Settings." |
| Entitled, not connected | entitled but `makeMailClient` returns `null` | "I don't have access to your inbox yet — connect Gmail or Outlook in Settings and I'll be able to pull that offer myself." |
| Connected, token dead | refresh throws `isInvalidGrant` | "Your inbox connection expired — reconnect Gmail in Settings and I'll pick it straight back up." |

All three return `{ok:false, reason}` as a `tool_result`, so the model turns them into one
natural spoken sentence rather than an error toast.

### Both providers from the start — with one honest asymmetry

Four of ten active customers are on Microsoft (MX audit, 2026-08-30, recorded in
`api/_lib/mail-provider-detect.js`). The design covers both, but they are not equal today:

`parseGmailStyleQuery()` in `api/_lib/microsoft-oauth.js` translates only `after:`,
`newer_than:Nd` and `from:`. It **drops free text on the floor.** For the watcher crons that is
harmless — they only ever search by sender. For `search_inbox` it is not: a free-text search on
a Microsoft account would silently become "every message in the inbox for the last N days."

That is precisely the mailbox-dump this build exists to prevent, so **`search_inbox` refuses it**
rather than degrading. Microsoft accounts get full function when the search carries a `from`
filter, and an explicit `unsupported_query_for_provider` result — "narrow it to a sender and I'll
find it" — when it carries only free text. Graph `$search` support is a contained follow-up
(§7); it is deliberately not in this change because `api/_lib/microsoft-oauth.js` is also
modified by the unmerged `carter/40-11-catastrophic-fixes` branch.

---

## 5. Security model

This is read access to a real estate agent's entire inbox: client financials, SSNs inside loan
documents, wire instructions, attorney correspondence. It is the most sensitive permission in
the product.

**5.1 Identity comes from the session and only the session.**
`userId` is set once, in `api/chat.js`'s handler, from `verifySupabaseToken(req)` — which
validates the bearer token against `${SUPABASE_URL}/auth/v1/user` and returns the id Supabase
resolves it to. It is then passed to `executeInboxTool` **as a separate positional argument**,
never merged into the tool input object.

The structural guarantee is that **no inbox tool schema has any identity-shaped property** — no
`user_id`, no `email`, no `mailbox`, no `account`, no `on_behalf_of`. There is nothing a caller,
a prompt injection in an email body, or the model itself can put in a tool call that changes
whose mailbox is read. This is the direct answer to the `_mt_acting_user` class of bug found in
this codebase today, where a caller-supplied parameter selected the acting identity: here the
parameter does not exist. `assertNoIdentityParams()` runs on every executor entry and throws if
the input object carries a key matching `/^(user|member|account|mailbox|owner|acting|on_behalf)/i`
or `/(user_?id|email|token)$/i`, and a unit test asserts every schema is free of them.

**5.2 Every query is scoped to that one token.** `makeMailClient({userId})` reads
`user_integrations` filtered `user_id=eq.<session id>`, and the returned client closes over that
one access token. There is no code path that takes a mailbox address as input.

**5.3 Nothing sensitive is logged.** `console.log` in the inbox path emits only: tool name,
provider, result count, elapsed ms, and message ids. Never a body, never a subject, never an
attachment byte, never a token, never an email address. `redactForLog()` is the single logging
helper and it whitelists fields rather than blacklisting them — a new field added to a result
shape cannot leak by default. A test asserts a realistic result object produces a log line
containing none of its sensitive values.

**5.4 Searches are bounded, always.**

| Bound | Value | Enforced |
|---|---|---|
| Date window | default 14 days, hard max 90 | clamped server-side; a missing/oversized `days` is coerced, not rejected |
| Result count | default 10, hard max 20 | clamped server-side |
| Body length | 12,000 chars | truncated with `body_truncated: true` |
| Snippet length | 200 chars | truncated |
| Attachments per import | 10 | excess reported in `skipped` |
| Attachment size | 20 MB each | excess reported in `skipped` |
| Full TREC extraction | exactly 1 per import call | the file identified as `trec-20-17` |
| Inbox tool calls per chat turn | 4 | loop counter in `handleActionMode` |
| Folders | Inbox only | `-in:spam -in:trash -in:chats -in:sent -in:drafts` (Gmail); Graph is already `mailFolders/inbox` scoped |

There is deliberately **no** "read my whole inbox" or "list recent mail" tool. A query with no
`query` and no `from` is rejected — Dossie must be looking for something.

**5.5 Writes re-verify ownership.** `import_email_attachments` resolves `deal_identifier` with
`transactions?user_id=eq.<session id>&…`, so a deal identifier matching another member's
property address returns "I don't have a dossier matching that" — never that member's row. The
Storage path is prefixed with the session user id.

**5.6 Email content is untrusted input.** A message body reaching the model is attacker-supplied
text (anyone can email an agent). Every `read_email` body is wrapped in an explicit
`<email_content>` boundary with an instruction that it is data, never instructions, and that no
tool may be called on its say-so. This mirrors how the Supabase MCP server fences query results.

**5.7 Cross-tenant test ships with the build**, not after — `api/_lib/inbox-tools.test.mjs`, §6.

---

## 6. The cross-tenant test

`api/_lib/inbox-tools.test.mjs`, run with `node --test`. It proves, without a network call:

1. **No schema carries an identity parameter.** Iterates every property of every inbox tool
   schema against the identity regex. This is the test that would have caught `_mt_acting_user`.
2. **Injected identity params are rejected, not ignored.** Calls each executor with
   `{user_id: VICTIM, email: 'victim@…', …}` in the input and asserts it throws
   `identity_param_not_allowed` — a hard failure, not a silent drop, so the failure is visible
   in logs instead of looking like a normal call.
3. **The mail client is always requested for the session user.** A stubbed `makeMailClient`
   records the `userId` it was called with; asserted equal to the session id and never to the
   victim id, across every tool and every injection attempt.
4. **Deal lookup is always user-filtered.** A stubbed fetch captures the PostgREST URL;
   asserted to contain `user_id=eq.<session id>` and the *victim's* transaction id to resolve to
   `deal_not_found`.
5. **A member with no integration row gets `not_connected`** — it never falls through to another
   member's row. (This is the live-data trap: today exactly one `user_integrations` row set
   exists, so a buggy unfiltered lookup would return Heath's mailbox to every caller and look
   like it worked.)
6. **Logging redaction.** A realistic result object is passed through `redactForLog()` and the
   output asserted not to contain the body, subject, sender address, attachment bytes or token.

---

## 7. What is genuinely missing after this build

Honest list. None of these are blocked by this change; all are separable.

| Gap | Size | Notes |
|---|---|---|
| **Packet send to an arbitrary recipient** | Small | `api/send-compliance-packet.js` already compiles every document on a transaction and sends one Resend email with attachments — but the recipient is hardcoded to `profiles.compliance_email`. "Send it to the sellers" needs that recipient parameterised and a `send_packet` chat tool. This is the largest remaining piece of the target sentence. |
| **`send_email` cannot attach anything** | Small | `api/send-email.js` sends text only. Either extend it or route attachment sends through the generalised packet sender. |
| **Net sheet is not a chat tool** | Small | `calculateNetSheet()` and `/api/net-sheet` both exist and are auth'd; nothing in `TOOLS` calls them. The model currently cannot produce a net sheet by voice. |
| **Offer summary has no renderer** | Medium | `log_offer` writes a comparison row. There is no "compose an offer summary document" path — the manual run wrote it by hand. |
| **Microsoft free-text search** | Small | Graph `$search` in `parseGmailStyleQuery`/`listMessages`. Deferred only to avoid colliding with `carter/40-11-catastrophic-fixes`. |
| **Thread awareness / supersession** | Medium | Step 2 of the manual run — noticing the revised offer replaced an earlier one. `search_inbox` returns enough for the model to *infer* it from subjects and dates, but nothing groups by thread or diffs two offers. |
| **Relationship context** | Medium | "Sellers own outright, here's the price-cut history" came from Heath's memory, not the dossier. Nothing in the product holds it. |
| **Entitlement is not purchasable end to end for this** | Unknown | `email_integration_enabled` is set on exactly one subscription row today; whether the Stripe add-on checkout reliably sets it was not verified in this pass. |

---

## 8. What blocks the demo right now

**Heath's two accounts have the inbox and the deals on opposite sides.** Verified against the
live database 2026-09-19:

| Account | auth user id | Transactions | Inbox connected | `email_integration_enabled` |
|---|---|---|---|---|
| `heath.shepard@kw.com` | `0cd05e2f-…` | **10, including 23 Nopalito** | **none** | **true** |
| `heath@meetdossie.com` | `598fec2f-…` | 0 | `heath.shepard@kw.com` via `google_gmail` | no subscription row |

He signs in as `heath.shepard@kw.com` (last sign-in 2026-09-05; the other account has not been
used since 2026-08-26). So on the account he would actually demo with, `makeMailClient()` returns
`null` and every inbox tool correctly answers "I don't have access to your inbox yet."

The security model forbids the shortcut. Reaching across to the other account's tokens is exactly
the cross-tenant read this build exists to prevent, and no amount of "but it's the same human"
makes that safe to ship — the code cannot tell the difference between Heath's two accounts and
two different customers.

**The fix is a 30-second human action and only Heath can do it:** sign in to
meetdossie.com as `heath.shepard@kw.com` and connect Gmail in Settings. That writes a
`user_integrations` row for `0cd05e2f-…` and the whole path lights up.

**Side effect worth knowing:** because entitlement and connection are currently on different
accounts, `listEmailIntegrationCustomers()` returns **zero rows today**, which means
`cron-email-to-dossier`, `cron-esign-events` and `cron-showingtime-feedback` have all been
no-ops. The same reconnect fixes all three. This is a live finding, not a consequence of this
change.

---

## 8b. What was proved, and how

Everything below was run against the **real** connected mailbox and the live database on
2026-09-19. No email was sent; nothing was written.

**The tools reproduce the manual run.** `search_inbox({query:'nopalito', days:30,
has_attachment:true})` returned 4 messages, top hit `1a0bac469e74746c` from
`jojohnson@purehomeriver.com` with 7 attachments — the exact message the manual run found — and
also surfaced the earlier "Fwd: 23 Nopalito" from the day before, which is what lets the model
notice supersession. `read_email` returned a 3,209-character body and the 7-file manifest; the
whole result was 7,925 characters with **no attachment bytes in it**.

**The import pipeline works.** With only the Storage PUT and the `documents` INSERT intercepted,
the real Gmail download and the real `scan-contract.js` identified all seven files correctly —
`trec-20-17`, `trec-financing-addendum`, `trec-hoa-addendum`, `iabs-form`, `onsite-sewer-form`,
`trec-sellers-disclosure`, and one `other` — and extracted 69 contract fields off the contract:
buyer Christopher & Monica Bryan, seller Barry & Jennifer Whyte, $999,000, $10,000 earnest
money, $250 option fee, closing 2026-10-22, Upward Title and Closing. That matches the hand-read
contract.

**It took 32.7 seconds**, which is why `api/chat.js` now declares `maxDuration: 120` and why
`import_email_attachments` carries its own internal deadlines: filing always completes, and
understanding the documents degrades with a spoken note rather than a timeout.

**A different member cannot reach that mailbox.** Same query, a real second member's session
(`44ad23d1-…`, a paying customer): `{ok:false, reason:'not_connected'}`, no `mailbox` field, and
the string `heath.shepard@kw.com` absent from the result. Injecting `user_id` or `email` into the
tool input threw `InboxSecurityError: identity_param_not_allowed` both times. On live data,
`resolveOwnedTransaction('23 Nopalito')` returned the row for the owning account and `null` for
both other accounts.

**28 automated tests pass** — `npm run test:inbox`.

---

## 9. Which parts of the spoken sentence work after this build

| Clause | After this build |
|---|---|
| "Hey Dossie" (voice input) | **Built, not verified.** Voice capture is the browser's own `webkitSpeechRecognition` (`dossie-app.jsx` `runVoiceLoop`/`toggleMic`) — client-side, no server STT endpoint. Chrome/Edge/Safari only; Firefox gets an explicit "type your command instead". The 401 that broke `mode:'action'` entirely was fixed 2026-06-20. But no test or artifact in either repo exercises microphone → transcript, there are no iOS-Safari workarounds in the voice code (unlike the upload code, which is full of them), and `MOBILE-TESTING-CHECKLIST.md` §8 still has "Voice input button works" unchecked. **Must be confirmed on the actual demo phone before filming.** |
| "we received an offer on Nopalito" | **Works** — `search_inbox` finds it |
| "…" (open it, understand it) | **Works** — `read_email` + `import_email_attachments` file the PDFs into the dossier and return identified form types plus extracted TREC fields |
| "compose a net sheet" | **Backend works, not reachable by voice** — `calculateNetSheet()` / `/api/net-sheet` exist; no chat tool calls them |
| "and offer summary" | **Partial** — `log_offer` records the terms; nothing composes a document |
| "put all the documents together with the pre-approval" | **Works, into the dossier** — every attachment lands as a `documents` row on the transaction, which is what `send-compliance-packet` compiles from |
| "and send it to the sellers" | **Does not work** — the packet sender only sends to the brokerage compliance address |

Two build items stand between this and a filmable demo: parameterise the packet recipient, and
expose the net sheet as a chat tool. Both are small, and both are independent of the inbox work.
