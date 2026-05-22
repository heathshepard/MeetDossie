# Dossie Promise vs Reality Audit — 2026-05-21

Read-only audit. Files referenced are absolute paths.

---

## 🔴 UNBACKED — these claims need to be removed, qualified, or built ASAP

### 1. "Dossie sends emails from YOUR address" (agents page)
- **Where:** `C:\Users\Heath Shepard\Desktop\MeetDossie\agents\index.html:1068`
- **What it says:** "Auto Follow-Ups — Dossie sends emails from YOUR address - welcome notes, lender check-ins, title requests, closing reminders."
- **What's actually true:** `api/send-email.js:100` hardcodes `from: '<agent name> via Dossie <dossie@meetdossie.com>'`. Only `reply_to` is set to the agent's email. Native send-as-agent (Gmail/Outlook) is the "Coming Soon" item in `dossie-app.jsx:4615-4621`. Recipients see Dossie's domain, not the agent's.
- **Fix:** Change to "Dossie sends on your behalf — replies route to your inbox" until Gmail/Outlook connect ships.

### 2. "Reply Monitoring" sold as included in Solo TC tier
- **Where:** `C:\Users\Heath Shepard\Desktop\MeetDossie\coordinators\index.html:646-649, 702`
- **What it says:** Feature card "Reply Monitoring — Dossie watches your email threads and flags when a lender or title company hasn't responded." Then listed inside the **$79/mo Solo TC plan** as an included feature.
- **What's actually true:** No code exists for reply monitoring (Grep of `api/` finds zero matches for `reply.monitor|watch.email|inbox.monitor`). In-app it's correctly labeled "Coming Soon" + `$10/mo` add-on (`dossie-app.jsx:4226, 4646`, CLAUDE.md §5). Coordinators page is misaligned with reality.
- **Fix:** Remove the Reply Monitoring feature card and price-list line until shipped, OR add "Coming Q3 2026" badge.

### 3. Hero meta + comparison row still quote **$39/month** (agents page)
- **Where:** `C:\Users\Heath Shepard\Desktop\MeetDossie\agents\index.html:18` (meta description) and `:1025` (compare card) and `:1206` ("from $39/month per agent")
- **What it says:** "From $39/month - unlimited deals" / "from $39/month per agent"
- **What's actually true:** Solo is $79/mo per CLAUDE.md §5 (May 15 2026 price update). The same page shows $79 in the pricing grid at `:1156` — internal contradiction.
- **Fix:** Replace all three "$39" mentions with "$79" (or "$29 founding").

### 4. "Chat-to-Contract... hands you a ready-to-sign PDF"
- **Where:** `C:\Users\Heath Shepard\Desktop\MeetDossie\agents\index.html:1060`; `founding.html:240` "Talk to Dossie. Voice-driven deal updates."
- **What it says:** "Tell Dossie the deal details in plain English - or by voice. She fills out the TREC contract, asks for anything missing, and hands you a ready-to-sign PDF."
- **What's actually true:** There are Python PDF generators in `scripts/generate_resale_contract.py`, `generate_amendment.py`, `generate_third_party_financing_addendum.py`, but NO API endpoint calls them from the chat flow. Grep of `api/` finds no `generate.contract` / `fillTrec` route. Users can only SCAN existing PDFs (`api/scan-contract.js`), not generate filled ones. CLAUDE.md §8 confirms "Amendment drafting — NOT BUILT".
- **Fix:** Soften to "Tell Dossie the deal details — she'll capture every field and scan the PDF you upload." Drop the "hands you a ready-to-sign PDF" line until the API exists.

### 5. "Hey Dossie" Voice — labeled "Coming soon" inline but sold as a feature
- **Where:** `C:\Users\Heath Shepard\Desktop\MeetDossie\agents\index.html:1090-1093`
- **What it says:** Feature card titled `"Hey Dossie"` — "Voice-first design... Coming soon."
- **What's actually true:** Talk to Dossie voice IS built (`assistant-webhook.js`, `speak.js`). The "Coming soon" tag here is wrong / outdated; meanwhile founding.html sells it without a caveat. Inconsistent.
- **Fix:** Remove "Coming soon" from the agents page card — the feature ships today.

### 6. "Heath... responds within the hour" (welcome email SLA)
- **Where:** `C:\Users\Heath Shepard\Desktop\MeetDossie\api\complete-onboarding.js:202` (and identical text in `stripe-webhook.js`)
- **What it says:** "Heath reads every email personally and responds within the hour."
- **What's actually true:** No SLA infrastructure, no auto-routing, no on-call coverage. Heath is one human running multiple businesses. Realistic at 4 customers, unrealistic at 50.
- **Fix:** "Heath reads every email personally — usually responds same day."

### 7. "SLA & compliance reporting" — Enterprise tier (coordinators)
- **Where:** `C:\Users\Heath Shepard\Desktop\MeetDossie\coordinators\index.html:737`
- **What it says:** Enterprise tier includes "SLA & compliance reporting."
- **What's actually true:** No SLA-reporting or compliance-reporting code exists. `send-compliance-packet.js` is a one-time email packet, not a report.
- **Fix:** Acceptable if labeled "Custom" tier (everything is bespoke), but explicitly contact-sales gated — make sure Heath knows not to promise this without scoping.

### 8. "Compliance reporting" — Brokerage tier (agents)
- **Where:** `C:\Users\Heath Shepard\Desktop\MeetDossie\agents\index.html:1196`
- **What it says:** Brokerage tier feature: "Compliance reporting"
- **What's actually true:** Same as above — does not exist. The "Send to Compliance" button is a per-deal packet send, not aggregate reporting. Brokerage tier is "Custom / Contact Sales" so the risk is lower, but the bullet implies an off-the-shelf capability.
- **Fix:** Rename to "Compliance packet send (per deal)" or remove.

### 9. "document QA" — repeated across 10 guides + 5 answers + calculator footer
- **Where:** Every `guides/*/index.html:140` and `answers/*/index.html`, plus meta descriptions; e.g. `guides\ai-transaction-coordinator-texas\index.html:7,12,22`
- **What it says:** "Dossie tracks every TREC deadline... plus follow-ups, document QA, and contract scanning."
- **What's actually true:** "Contract scanning" exists. "Document QA" (auditing uploaded docs against the contract for missing fields/errors) is not a wired feature. `scan-contract.js` extracts data, doesn't audit completeness.
- **Fix:** Bulk replace "document QA" → "document scanning" across `guides/` + `answers/` + `marketing/` data JSON files (43 occurrences in 25 files).

### 10. Roadmap line: "2027 — Mobile app"
- **Where:** `C:\Users\Heath Shepard\Desktop\Dossie\dossie-app.jsx:4249`
- **What it says:** "Q3 2026 — Reply Monitoring + AI Autopilot; 2027 — Mobile app"
- **Status:** This is correctly framed as roadmap (in "Coming soon" panel). Mobile app is honestly labeled as 2027. **Acceptable as-is** — leaving here for visibility, not flagging as unbacked.

---

## 🟡 PARTIAL — works in part but has gaps users will notice

### A. Daily 8am email digest
- **Where:** `api/complete-onboarding.js:201` welcome email: "I'll email you a daily digest at 8am whenever you have email drafts waiting"
- **Reality:** `cron-email-digest.js` and `vercel.json:104` schedule exist and work. BUT it ONLY fires for users with rows in `email_queue` where `status != 'sent'`. Current draft_email tool drafts emails in chat — verify these get written to `email_queue`. Heath flagged this gap in the prompt. If `email_queue` stays empty, no digest emails go out and the welcome email's promise reads false on day 1.
- **Fix:** Verify that the chat `draft_email` tool path actually writes to `email_queue`. Today's task list already lists this as flagged.

### B. "Texas Holiday Rollover"
- **Where:** `founding.html:299` "Deadlines that land on weekends or Texas holidays roll forward automatically"
- **Reality:** `Dossie\src\utils\trec-deadline-engine.js` implements rollover. **Backed if test suite passes** — `trec-deadline-engine.test.mjs` exists. Needs human verification that Texas-specific holidays (not just federal) are coded.

### C. "I work nights, weekends, and holidays"
- **Where:** `api/complete-onboarding.js:184` welcome email + `chat.js:304` system prompt
- **Reality:** True for cron-driven deadline reminders, email digest, morning brief — they run 24/7. False if interpreted as "Dossie autonomously sends messages overnight while you sleep" — she only acts on agent input or scheduled summaries.
- **Fix:** Acceptable framing, but be aware customers may expect proactive overnight actions that don't happen.

### D. "I've drafted an email to the buyer's agent... Tap to approve"
- **Where:** `agents\index.html:1118` Morning Brief demo
- **Reality:** Draft-email tool exists. Whether the Morning Brief actually surfaces a "Tap to approve" CTA inline is **needs human verification** — the audio brief speaks counts, but inline approval flow from the brief itself isn't obvious in the React app code I reviewed.

### E. "Auto follow-up emails" (Solo $79 plan)
- **Where:** `agents\index.html:1163`, `coordinators\index.html:699`
- **Reality:** `cron-followup.js` exists and emails agents about overdue action items. This is internal pings to the AGENT, not customer-facing emails Dossie auto-sends to lender/title/buyer. Many readers will assume the latter. Same gap as #1 above.

---

## 🟢 BACKED — verified working

- TREC deadline auto-calculation + paragraph citation (`Dossie/src/utils/trec-deadline-engine.js`)
- Morning Brief audio (`cron-morning-brief.js`, `generate-brief-script.js`, ElevenLabs Luna voice)
- Talk to Dossie / voice (`assistant-webhook.js`, `speak.js`, system prompts in `chat.js`)
- Contract scanning from PDF (`api/scan-contract.js` — TREC 20-17 extraction)
- Email drafting tool (`draft_email` in `chat.js:329, 385`)
- Send compliance packet (per-deal, not "vault") (`api/send-compliance-packet.js`)
- Closing milestone cards (`dossier_milestones` table, share flow)
- Founding application flow (`founding-approval.js` + Stripe Payment Link + Resend approval email)
- Deadline reminders cron at T-7d / T-1d / T-0 (`cron-deadline-reminders.js` + `vercel.json` cron)
- Welcome + set-password emails (`complete-onboarding.js` + `stripe-webhook.js`)
- Weekly newsletter from `WEEKLY-IMPROVEMENTS.md` (`cron-weekly-newsletter.js`)
- Share Dossie button (sidebar + mobile, `share_events` tracking)
- TREC calculator at `meetdossie.com/calculator` (email capture)
- 10 SEO guides + 5 AEO answers live
- Scarcity counter live (`api/founding-count.js` + `index.html:218-229`)
- In-app "Coming Soon" badges on Reply Monitoring, AI Autopilot, E-Signatures, Mobile app, Gmail/Outlook connect — honest framing (`dossie-app.jsx:4226-4249, 4615-4621, 4754-4760`)

---

## Recommended actions (priority order)

1. **Today:** Fix the three `$39/month` stale-price mentions on agents page (`agents/index.html:18, 1025, 1206`). One-line fix, immediate credibility win.
2. **Today:** Remove "Reply Monitoring" from coordinators page Solo $79 tier and from feature grid (or add "Coming Soon"). This is the single biggest mismatch — selling an unbuilt $10/mo add-on as included.
3. **This week:** Rewrite "Auto Follow-Ups - Dossie sends emails from YOUR address" to match `dossie@meetdossie.com` reality, OR ship Gmail/Outlook connect.
4. **This week:** Soften the "ready-to-sign PDF" Chat-to-Contract claim, OR wire up `scripts/generate_*.py` to an API endpoint.
5. **This week:** Bulk replace "document QA" → "document scanning" across guides + answers + marketing JSON (script-able, 43 occurrences).
6. **This week:** Verify the chat `draft_email` tool actually writes to `email_queue` so the daily 8am digest cron has something to send.
7. **Next week:** Soften "Heath responds within the hour" to "usually same day" in welcome email.
8. **Next week:** Remove "Coming soon" from "Hey Dossie" voice card on agents page — voice ships today.
9. **When scoping enterprise deals:** Either build SLA + compliance aggregate reporting or strip those bullets from the Enterprise / Brokerage tier feature lists.
