# zipForm Offer E-Sign Packet — Send Runbook

Built 2026-08-30 from a live practice run: **"PRACTICE - 507 Ridge Blf - TRAINING"**,
buyer/sole signer Heath Shepard (heath.shepard@kw.com), TID 123775065. Sent successfully —
Gmail message `1a054ce8a8147647`, subject "507 Ridge Blf - Offer for Signature (PRACTICE)",
from `secure@authentisign.com`, received 2026-08-30 22:33 UTC (17:33 CDT).

**Goal of this doc:** nobody should ever again spend hours rediscovering this click path. If a
step here stops matching the live UI, fix this doc in the same session you find the drift.

**Companion script:** `scripts/send-trec-offer-packet.js` — parameterized version of everything
below. Run it with a deal-values object; see its header for usage. It automates through
Finalize Signing Setup + Customize Invites + Send. A few steps below are still coordinate-based
(documented as such) because zipForm's Angular UI doesn't expose stable text/role selectors for
them — that's it own kind of finding, not a gap to "eventually fix."

---

## Prerequisites

- A zipForm transaction already exists with: Parties added (buyer/sellers/agents/escrow), and
  the TREC forms already filled and saved as Documents on the transaction (contract, TPFA,
  49-1/appraisal addendum, etc.) — via zipForm's own **Forms** editor, filled and saved, NOT the
  local `api/_lib/fill-trec-20-19.js` engine. See
  `~/.claude/projects/.../memory/feedback_required-contract-fields-checklist.md` for the full
  paragraph-by-paragraph fill checklist and why zipForm's native fill UI is the standing rule.
- Browser: `launchBrokerageContext()` from `scripts/_lib/brokerage-browser.js`, with
  `BROKERAGE_PROFILE_DIR` pinned to `C:\Users\Heath\.brokerage-browser-profile` (NOT a
  throwaway per-script profile dir — use the one real persistent profile so the zipForm/Chrome
  saved-password autofill is present).
- Chrome's saved password autofills the zipForm login form automatically once the profile has
  logged in before. **You still have to click "Sign In" on every fresh browser launch** — the
  session is not silently resumed by cookie alone; the password field shows pre-filled and a
  `Sign In` button click is required. This is a a few-second step, not a blocker. Never type the
  credential — only check `input[type=password]`'s value length > 0, then click Sign In.
- **Chrome launch is occasionally flaky.** `launchPersistentContext` throws
  `Target page, context or browser has been closed` (`exitCode=21`) roughly 1 in 5 launches
  against this profile, for no discernible reason. Retry once; it succeeds on the second try in
  every case observed so far. Not worth debugging further unless it starts happening every time.

---

## Step-by-step click path (as of 2026-08-30, zipForm Transactions Edition / zipFormPlus.com)

### 1. Login + open the transaction

```js
await page.goto('https://www.zipformplus.com/', { waitUntil: 'domcontentloaded' });
const pw = page.locator('input[type="password"]').first();
if (await pw.isVisible().catch(() => false)) {
  const len = await pw.evaluate(el => (el.value || '').length).catch(() => 0);
  if (len > 0) {
    await page.getByRole('button', { name: /sign in/i }).first().click();
    await page.waitForTimeout(6000);
  }
}
```

From the Dashboard (transaction list is right there, no need to use the search box), click the
transaction by its row text:

```js
await page.locator(`text=${TXN_ROW_TEXT}`).first().click();
```

`TXN_ROW_TEXT` just needs to be a unique substring of the transaction name shown in the list
(e.g. `"PRACTICE - 507 Ridge Blf -"`).

### 2. Open the E-Sign tab — GOTCHA: a hidden decoy exists

The obvious `page.getByText('E-Sign', { exact: true })` or `locator('text=E-Sign')` will often
resolve to a **hidden** `<span data-lang="Notifications-data5">E-Sign notifications</span>`
inside the bell-icon dropdown (its `textContent.trim()` is NOT "E-Sign", but Playwright's
`hasText` substring match still matches it first in DOM order) or otherwise picks a non-visible
node. Fix: filter to actually-visible leaf elements with EXACT text, in-page:

```js
async function clickExactVisible(page, text) {
  await page.evaluate((t) => {
    const els = Array.from(document.querySelectorAll('*')).filter((e) =>
      e.childElementCount === 0 && e.textContent.trim() === t && e.offsetParent !== null
    );
    if (els.length) (els[0].closest('a,button') || els[0]).click();
  }, text);
}
await clickExactVisible(page, 'E-Sign');
```

This same helper is the reliable pattern for every other exact-text nav click in this flow too.

### 3. Open the existing draft packet card — coordinate click, not text

If an e-sign packet draft already exists for this transaction (check first — the E-Sign tab
lists existing packets as cards with a DRAFT/SENT status pill), open it by clicking the card
body. **The card's `<h4>` title text is not a usable Playwright target** — zipForm renders it
behind an SVG card-graphic overlay, so `getByText(...).click()` times out with "element is not
visible" even though the text resolves fine. Click by fixed coordinate instead:

```js
await page.mouse.click(124, 344); // first/only card position at 1400x1000 viewport
```

If there is no existing draft, click **New** (top-left icon button) instead, which opens a
"Create Signing" modal pre-filled with the transaction name as the Signing Name — click
**Create**.

### 4. Add documents — "My Transaction" tab, per-row Add button

```js
await page.getByText('Add a Document or Form', { exact: false }).first().click();
await page.getByText('My Transaction', { exact: false }).first().click();
```

This lists every form already saved on the transaction, each with its own **Modified**
timestamp — cross-check that timestamp against when you last edited/filled the form, so you're
attaching the current version, not a stale one (per the standing e-sign playbook rule).

**GOTCHA:** don't loop a bare `page.locator('button:has-text("Add")')` across the whole page —
it also matches unrelated toolbar buttons (e.g. "Zoom In") once the modal's own Add buttons run
out, and Playwright will happily click those instead, silently doing nothing useful. Scope the
locator to the modal:

```js
const modal = page.locator('.add-documents-modal, ngb-modal-window').first();
for (let i = 0; i < N; i++) {
  const btns = modal.locator('button:has-text("Add")');
  if (await btns.count() === 0) break;
  await btns.first().click();
  await page.waitForTimeout(2000);
}
```

Close the modal after (`Close` button) and confirm the Docs panel lists all N documents.

### 5. Signers — check the buyer's box, GOTCHA: checkbox isn't the label

Signers tab → **Add Participants** → **Add from Transaction** opens a list of every party/role
on the transaction (buyer, sellers, agents, escrow officer) as checkbox rows. Find the target
row by its label text, then click ~20px to the LEFT of the label's bounding box (that's where
the actual checkbox glyph sits — clicking the label text itself does not toggle it):

```js
const row = page.locator('text=Heath Shepard (Buyer One)').first();
const box = await row.boundingBox();
await page.mouse.click(box.x - 20, box.y + box.height / 2);
await page.getByText('Select', { exact: true }).first().click();
```

Only check the signer(s) who should actually sign this packet — for a buyer-side offer, that's
the buyer(s), not the sellers or listing agent (see the e-sign playbook: "only the intended
parties as signers").

### 6. Map Signers → Assign Signature Blocks (auto-layout — it actually works)

```js
await page.getByText('Map Signers', { exact: true }).first().click();
```

Opens "Set Signing Layout Mappings" — a Signer Role → Signer dropdown table (Buyer One, Buyer
Two, Seller One, Seller Two, Escrow Officer). zipForm **auto-fills the correct dropdown** for any
role that matches a checked signer (e.g. "Buyer One" → "Heath Shepard") and leaves the rest on
"Ignore". Nothing to touch here if the signer selection in step 5 was correct.

```js
await page.getByRole('button', { name: 'Assign Signature Blocks' }).first().click();
```

**Use `getByRole` with an exact name here, not a loose `getByText` click** — a loose click
attempt against this button silently no-opped once during testing (page state looked unchanged
after the click). The role-scoped click worked reliably every time.

**Confirmed by visual + DOM inspection: auto-layout correctly places, with zero manual
drag-and-drop:**
- An initials tag (signer's initials, e.g. "HS") at every page's
  *"Initialed for identification by Buyer ___ and Seller ___"* line, across every attached
  document that has one (the main contract runs ~12 pages; confirmed placed on at least 2
  different pages, consistent pattern expected on all).
- A full **"[initials]-Sign Here"** signature tag at the actual Buyer signature line on the
  contract's own Executed/signature page, and at each addendum's own buyer signature block
  (confirmed on the TPFA/40-11 form).

Do **not** assume you need to manually drag fields onto the canvas — that's not how this UI
works day-to-day; auto-layout via Map Signers → Assign Signature Blocks is the whole job.

### 7. Verify field count before sending — one DOM query, no scrolling needed

zipForm keeps every page of every attached document mounted in the DOM simultaneously (it does
**not** lazy-unmount off-screen pages the way some PDF viewers do), so a single unfiltered query
right after Assign Signature Blocks gives the true total placed-tag count with no scrolling:

```js
const tags = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('*')).filter((e) =>
    e.childElementCount === 0 && /^HS(\s|-|$)/.test(e.textContent.trim()) // swap "HS" for signer initials
  );
  return els.map(e => e.textContent.trim());
});
console.log('placed field count:', tags.length);
```

**GOTCHA — do not use `.signer-field` as your selector.** That class belongs to the floating
**Tools** palette (the drag-source icons: Full Name, Email Address, Auto Date, MM/dd/yyyy, etc.)
which is always on-screen regardless of scroll position and has nothing to do with placed tags.
Querying it will always return the same small constant count (4-7 in testing) and looks
deceptively like "field count didn't change" — it's not measuring what you think.

Sanity-check the total against `(pages with an initial line) + (signature blocks across all
attached documents)` per the required-fields checklist — a real packet should be in the low
double digits for a 12+ page contract + addenda, not single digits.

### 8. Next → Finalize Signing Setup

```js
await page.mouse.click(1332, 32); // "Next" button, top-right, fixed position across this flow
```

Opens **Finalize Signing Setup**: expiration date (defaults to **+30 days**, editable),
reminder cadence, and three buttons — **CANCEL**, **CUSTOMIZE INVITES**, **SEND**. If the modal
doesn't appear after one click (Angular render lag), click Next again and re-check.

### 9. Customize Invites — GOTCHA: two different "Save" buttons

```js
await page.getByText('Customize Invites', { exact: false }).first().click();
```

Per-signer modal with `Email` (their address, read from the transaction, not editable here),
`Subject` (plain `input[placeholder="Email Subject"]` — safe to `.fill()`), and `Message` (a
rich-text `div[contenteditable="true"]` editor with a **B / I / U / bullets / numbering /
undo / redo** toolbar and a live `Characters: N / 5000` counter below it).

**Per the standing rule, the rich-text editor does not reliably register a pasted/`.fill()`
value — type character-by-character and verify the counter:**

```js
await page.locator('input[placeholder="Email Subject"]').first().fill(SUBJECT);
const editor = page.locator('div[contenteditable="true"]').first();
await editor.click();
await page.keyboard.type(MESSAGE, { delay: 20 });
const counterText = await page.getByText(/Characters:\s*\d+\s*\/\s*5000/).first().textContent();
if (!counterText.includes(String(MESSAGE.length))) throw new Error('counter mismatch, stop');
```

**GOTCHA, found the hard way:** this modal has TWO buttons whose accessible name contains
"Save" — a `Save Message` button up near the toolbar (opens an unrelated **"Custom Message
Editor"** sub-modal for saving a reusable named template — has its own required "Custom Message
Name" field, and will NOT save your subject/message if you fill it out) and the real
modal-footer **Save** button that actually commits the subject/message to the invite. A loose
`page.getByRole('button', { name: 'Save' })` (no `exact: true`) matches "Save Message" FIRST in
DOM order and opens the wrong modal. Use an exact match, or scope to the modal footer:

```js
const saveBtn = page.getByRole('button', { name: 'Save', exact: true }).last();
await saveBtn.click();
```

**Also confirmed:** if you do hit the wrong Save button and back out, the subject/message you
typed do **not** persist on reopening the Customize Invites modal (fields come back blank) — you
have to retype. Don't assume anything you typed survived a wrong click; re-verify by reading the
input value / editor text back before trusting it.

### 10. Send

Back on Finalize Signing Setup, click **SEND** (case-insensitive substring match is safest,
zipForm's button label casing has been observed both ways):

```js
await page.getByRole('button', { name: 'SEND', exact: false }).first().click();
```

The page redirects to the transaction's **Documents** tab after send (not a dedicated
confirmation screen) — that redirect alone is not proof of success; verify per step 11.

### 11. Verify it actually sent

Reopen the E-Sign tab. The packet card's status pill should now read **SENT** (was **DRAFT**),
with the correct participant count shown under it (e.g. "1 participants"). Click the card for
full detail: Created/Modified/Expiration timestamps and a Signers table with
Name / Role / Signer Type / Authenticated / Approved columns.

**zipForm does not surface a distinct alphanumeric "packet/envelope ID"** anywhere in this UI —
the closest stable reference is the transaction's own **TID** (shown in the transaction header,
e.g. `TID 123775065`) plus the packet's Created timestamp.

**Also verify delivery at the actual inbox**, not just the zipForm UI — email arrives from
`secure@authentisign.com` (zipForm's native e-sign is Authentisign-branded under the hood; this
is NOT the same thing as choosing the separate "Set Authentisign as my default signing service"
checkbox on packet creation, which is an alternate/legacy path — don't be confused by the shared
branding). Subject line is exactly whatever was typed into Customize Invites.

**Also worth knowing:** the transaction's Summary tab "Recent Activity" feed logs a line reading
*"Created e-sign packet '[name]' using Authentisign®"* every time the draft packet is reopened
into the editor — not just on first creation. Seeing several of these in the log does **not**
mean duplicate packets were created; the E-Sign tab's card list is the authoritative count of
actual packets.

---

## Timing observed (this practice run, resuming from an already-filled/party-added transaction)

| Phase | Elapsed |
|---|---|
| Add 3 documents from transaction | ~4 min |
| Select buyer signer, Map Signers, Assign Signature Blocks | ~4 min |
| Field-count verification (scroll + DOM inspection) | ~7 min — almost entirely selector-discovery overhead (see `.signer-field` gotcha above); a script that already knows the right selector does this in seconds |
| Finalize → Customize Invites → Send | ~4 min — included one wrong-button detour (Save Message vs Save) |
| Verify sent + confirm email delivery | ~2 min |
| **Total, this discovery run** | **~21 min** |

With the gotchas above already known (i.e. running `scripts/send-trec-offer-packet.js` against a
transaction whose forms are already filled and saved), the realistic repeat time is close to
Heath's own **3-5 minutes** — the script has no discovery overhead left to pay.

---

## What still needs a human / is genuinely per-deal

- Filling the actual TREC forms (contract terms, addenda) — separate from this runbook, see the
  required-fields checklist memory doc.
- Adding transaction Parties (buyer/seller/agent/escrow contact records) — one-time setup per
  transaction, not part of the repeatable e-sign send.
- Deciding who the actual signers are for a given packet (buyer-only vs both sides, etc.).
- Reviewing the exact invite subject/message wording before Send — never send boilerplate
  without reading it first, per the correspondence rules.
