# Quinn -> Carter: Talk to Dossie tool dispatcher coverage gap — CRITICAL

**Severity:** CRITICAL — equivalent to the 401 bug. CLAUDE.md claims these features are LIVE; they are wired SERVER-side but NOT through Talk to Dossie. Agent says "draft an amendment" → Dossie confirms → nothing happens.

## Bug

`api/chat.js` defines 14 tools in action mode:

```
create_dossier, archive_deal, update_deal_field, advance_stage, get_deals,
get_deal_details, draft_email, send_email, draft_amendment, fill_forms,
send_wire_fraud_warning, log_offer, initiate_termination, answer_question
```

The frontend bundle (`assets/workspace-Cf4tXxlZ.js`) dispatcher `jh()` only
handles **9 of 14**:

```
✅ answer_question
✅ send_email
✅ create_dossier
✅ archive_deal
✅ update_deal_field
✅ advance_stage
✅ get_deals
✅ get_deal_details
✅ draft_email
❌ fill_forms            <-- TREC 20-19 contract drafting
❌ draft_amendment       <-- TREC 39-10 amendment
❌ send_wire_fraud_warning  <-- TAR 2517
❌ log_offer             <-- seller-side offer log
❌ initiate_termination  <-- TREC 38-7 termination
```

The fallthrough at end of dispatcher:

```js
return await j(G || "I heard you, but I'm not sure how to act on that yet.")
```

`G` is the AI's natural-language message — so Dossie SAYS something like
"Drafting the amendment now" but no API call to `/api/draft-amendment` or
`/api/fill-form` is ever made. The agent gets a verbal confirmation,
nothing actually gets drafted. **Silent inaction is worse than visible
failure.**

## Evidence

Bundle-side: `grep -c "fill_forms\|draft_amendment" workspace-Cf4tXxlZ.js`
returns 0 for both. No `fetch("/api/fill-form"` or `fetch("/api/draft-amendment"`
anywhere in the bundle.

I tested live on production (rate-limit confirmed via earlier batch):
- T1.3 "Draft an amendment to extend closing to next Friday on the Rilla Vista deal"
  → chat.js correctly returned `action: "draft_amendment"` with valid params
  → Frontend prints Dossie's message ("There are two Rilla Vista dossiers...
    I'll draft the amendment now") → **No /api/draft-amendment fetch fires**
- T1.1 "Fill out a contract for 123 Main St..." → action returned `fill_forms`
  → Frontend would say "Drafting the contract" → **No /api/fill-form fetch**

## Fix

In `Dossie` repo (React source), inside the `jh` (workspace dispatcher)
function, add cases for the 5 missing tools. Reference: the EXISTING
`draft_email` case is the closest model — it picks a transaction, opens
the Emails tab, and dispatches a templated workflow.

### `fill_forms` dispatcher

```js
if (I === "fill_forms") {
  // 1) Resolve or create transaction
  let tx = A.deal_identifier ? Ti(b, A.deal_identifier) : null;
  // 2) Call /api/extract-form-fields with form_type + agent message
  const formType = A.form_type_override || "resale-contract";
  const session = (await supabase.auth.getSession()).data.session;
  const extractResp = await fetch("/api/extract-form-fields", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({
      form_type: formType,
      message: A.message || u,
      transaction: tx || {},
    }),
  });
  const extracted = await extractResp.json();
  if (!extracted.ok) return await m("Couldn't extract the contract details — try again with more specifics.");

  // 3) If no transaction yet, create it from extracted fields
  if (!tx) {
    // Use create_dossier flow but auto-populate from extracted.field_values
    tx = await createDossierFromExtract(extracted.field_values);
  }

  // 4) Call /api/fill-form to generate PDF
  const fillResp = await fetch("/api/fill-form", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({
      transaction_id: tx.id,
      form_type: formType,
      field_values: extracted.field_values,
    }),
  });
  const filled = await fillResp.json();
  if (!filled.ok) return await m(`Couldn't fill the form — ${filled.error || "try again"}`);

  return await C(
    `Filled ${filled.formName || "the contract"} for ${tx.propertyAddress}. Review it in the Documents tab.`,
    tx.propertyAddress
  );
}
```

### `draft_amendment` dispatcher

```js
if (I === "draft_amendment") {
  const tx = Ti(b, A.deal_identifier);
  if (!tx) return await m("I couldn't find that deal — can you give me more of the address?");
  const session = (await supabase.auth.getSession()).data.session;
  const resp = await fetch("/api/draft-amendment", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session?.access_token || ""}`,
    },
    body: JSON.stringify({
      transaction_id: tx.id,
      amendment_type: A.amendment_type,
      new_value: A.new_value,
      notes: A.notes,
    }),
  });
  const data = await resp.json();
  if (!data.ok) return await m(`Couldn't draft the amendment — ${data.error || "try again"}`);
  return await C(
    `Amendment drafted for ${tx.propertyAddress}. It's in the Documents tab, ready to send.`,
    tx.propertyAddress
  );
}
```

### `send_wire_fraud_warning` dispatcher

```js
if (I === "send_wire_fraud_warning") {
  const tx = Ti(b, A.deal_identifier);
  if (!tx) return await m("I couldn't find that deal.");
  const buyerEmail = A.buyer_email || tx.buyerEmail;
  if (!buyerEmail) return await m(`I need an email for the buyer to send the wire fraud warning.`);
  // Call /api/dossiesign-prepare or /api/esign-create
  const resp = await fetch("/api/esign-create", { /* ... */ });
  // ...
}
```

### `log_offer` dispatcher

```js
if (I === "log_offer") {
  const tx = Ti(b, A.deal_identifier);
  if (!tx) return await m("I couldn't find that listing.");
  // POST to a /api/log-offer endpoint OR upsert directly into offers table
  // ...
}
```

### `initiate_termination` dispatcher

Same pattern — POST to whichever termination endpoint exists; fall back
to /api/fill-form with `form_type: 'termination-notice'`.

## How to verify

After deploy:
1. Log in as `demo@meetdossie.com`
2. Type "Draft an amendment to extend closing to next Friday on the 311 Rilla Vista deal" into Talk to Dossie
3. Network panel should show:
   - POST /api/chat → 200 with `action: "draft_amendment"`
   - POST /api/draft-amendment → 200 with PDF URL
4. Documents tab should show the new amendment PDF
5. Repeat with "Fill out a contract for 123 Main St for John Smith, $300k, conventional 20 down, 10 option, close June 30"
   - Network should show /api/extract-form-fields then /api/fill-form
   - Documents tab should show TREC 20-19

## Why this matters

CLAUDE.md says:
> **Fill-and-sign Phase 1 — voice → filled TREC contract (2026-05-28):**
> Talk to Dossie integration: agent says "fill out a contract..."
> → extract-form-fields → fill-form → document created

This is **structurally not true**. The backend exists. The chat tool is
defined. But the React dispatcher never connects the two. The flow works
ONLY if a developer directly POSTs to /api/extract-form-fields and
/api/fill-form by hand. From the agent's perspective using voice or text:
nothing happens. Dossie SOUNDS like she's filling the contract but the
PDF never appears.

This is the single most embarrassing demo bug. Brittney records herself
saying "fill out a contract for 123 Main St" — Dossie says "drafting now"
— and 30 seconds later the agent says "where is it" and Heath has to
say "...still being built."

Fix priority: AFTER the 401 fix (Carter spec
`quinn-spec-carter-talk-to-dossie-401.md`), because there's no point
dispatching tools if /api/chat is still 401-ing.

## Sequencing

1. Carter ships the 401 fix (`Authorization` header on /api/chat).
2. Carter ships these 5 dispatcher cases.
3. Quinn re-runs the test matrix end-to-end on staging.
4. If all 5 fire correctly and produce PDFs, Heath gets a working
   "voice command → TREC PDF in 30 seconds" demo.
