# Dossie Email Audit
**Conducted:** 2026-05-29
**Files scanned:** api/stripe-webhook.js, api/complete-onboarding.js, api/_lib/founding-approval.js, api/esign-create.js, api/esign-webhook.js, api/cron-activation-drip.js, api/cron-deadline-reminders.js, api/cron-email-digest.js, api/cron-weekly-newsletter.js, api/cron-followup.js, api/send-compliance-packet.js, api/cancel-subscription.js, api/send-jen-second-touch.js, api/admin-send-email.js, api/send-email.js, api/support.js
**Total emails found:** 17 distinct email types across 14 files

---

## Email 1: Welcome Email (checkout flow — complete-onboarding path)
**File:** api/complete-onboarding.js
**Trigger:** Agent submits the post-payment onboarding form at meetdossie.com after completing Stripe checkout
**From:** `Dossie <dossie@meetdossie.com>`
**To:** New founding member
**Subject:** `Welcome to Dossie — let's get you set up`
**Personalization:** `full_name` from onboarding form (title-cased). Falls back to "there" if blank.
**Body summary:** Welcomes agent as founding member, confirms $29/month-for-life lock, introduces Dossie as AI TC, directs to "Set Your Password" email, invites to Founding Files Facebook group with a CTA button, lists three first actions to try, explains the daily digest and deadline reminders, closes with invitation to reply.

**Issues found:**
- [ ] **Body references "check your inbox for our Set Your Password email"** — but both emails are sent within seconds of each other by the same function call. The password email lands first in most clients because it is sent second (SMTP queue ordering). Telling the user to "check your inbox" for a second email that may arrive simultaneously or before this one is confusing. The welcome email should simply say "Your next step is to set your password using the link below" and embed the password reset link directly instead of sending two emails. Sending two emails in rapid succession also increases spam-filter risk.
- [ ] **Duplicate template** — the `welcomeEmailHtml` function is copy-pasted verbatim in both `api/complete-onboarding.js` (lines 202-230) and `api/stripe-webhook.js` (lines 257-285). If anyone edits one, the other drifts silently. This is a maintenance bug waiting to happen.
- [ ] **"I'll email you a daily digest at 8am"** — the actual digest cron runs at 13:00 UTC (8 AM CDT during DST, 7 AM CST in winter). This is correct in summer but wrong by one hour in winter. Not a showstopper but a small trust erosion.

---

## Email 2: Set Password Email (checkout flow — complete-onboarding path)
**File:** api/complete-onboarding.js
**Trigger:** Same trigger as Email 1 — fires immediately after the welcome email in the same onboarding handler
**From:** `Dossie <dossie@meetdossie.com>`
**To:** New founding member
**Subject:** `Welcome to Dossie — Set Your Password`
**Personalization:** None — no name used
**Body summary:** Confirms founding member access, one CTA button "Set Your Password" linking to the Supabase recovery link. Footer note that the link expires in 24 hours.

**Issues found:**
- [ ] **Subject line conflict** — subject is "Welcome to Dossie — Set Your Password" which duplicates the word "Welcome" from Email 1's subject "Welcome to Dossie — let's get you set up". In an inbox these two emails arrive within seconds and look like duplicates. The password email subject should be something unambiguous like "Action required: set your Dossie password" or "Set up your Dossie login".
- [ ] **No name in greeting** — the email opens with "Welcome to Dossie." (no name at all). The welcome email has "Hi Sarah," but this one has no personalization. At minimum it should greet by first name.
- [ ] **Link expiry mismatch** — footer says "This link expires in 24 hours." Supabase recovery links actually expire based on the project's "OTP expiry" setting (default 3600 seconds = 1 hour, not 24 hours). If Supabase is configured at default, this statement is incorrect and agents clicking a link 2 hours later will get an expired-link error.
- [ ] **Duplicate template** — same as Email 1: `setPasswordEmailHtml` is copy-pasted in both `complete-onboarding.js` (lines 232-240) and `stripe-webhook.js` (lines 287-295).

---

## Email 3: Welcome Email (invoice.paid path — direct invoice customers)
**File:** api/stripe-webhook.js
**Trigger:** Stripe `invoice.paid` event where no auth user exists (direct-invoice provisioning — Terry Katz / Lisa Nilsson pattern)
**From:** `Dossie <dossie@meetdossie.com>`
**To:** New founding member
**Subject:** `Welcome to Dossie — let's get you set up`
**Personalization:** `full_name` from Stripe customer object (title-cased). Falls back to "there".
**Body summary:** Identical to Email 1 body.

**Issues found:**
- Same issues as Email 1 (duplicate template, two-email confusion, winter DST timing).
- [ ] **Name quality risk** — name comes from Stripe customer metadata which Heath sets manually when creating invoices. If he forgets to enter the name, the agent gets "Hi there," instead of their real name. The checkout flow captures name from the agent themselves; the invoice flow depends on Heath filling it in.

---

## Email 4: Set Password Email (invoice.paid path)
**File:** api/stripe-webhook.js
**Trigger:** Fires immediately after Email 3, same invoice.paid handler
**From:** `Dossie <dossie@meetdossie.com>`
**To:** New founding member
**Subject:** `Welcome to Dossie — Set Your Password`
**Personalization:** None
**Body summary:** Identical to Email 2.

**Issues found:**
- Same issues as Email 2 (subject conflict, no name, 24-hour expiry claim).

---

## Email 5: Founding Application Approval Email
**File:** api/_lib/founding-approval.js
**Trigger:** Heath taps Approve in Telegram (via api/telegram-webhook.js) or hits api/admin-approve-founding
**From:** `Heath at Dossie <heath@meetdossie.com>`
**To:** Approved applicant
**Subject:** `You're in — claim your Dossie founding spot`
**Personalization:** First name extracted from application name field.
**Body summary:** Tells applicant they're approved, confirms $29/month-for-life lock, includes a "Claim my founding spot" button linking to the Stripe Payment Link with the applicant's email pre-filled. Provides the URL as plain text below the button. Closes with an invitation to reply if anything breaks.

**Issues found:**
- [ ] **None — this is the cleanest email in the system.** Warm, personal, one clear action, correct from address, reply_to set, Resend tags for analytics. The only minor note: the button text "Claim my founding spot" is good but could specify the price ("Claim my $29 founding spot") so there is zero ambiguity about what they are claiming.

---

## Email 6: Activation Drip — Email 1 (day 4)
**File:** api/cron-activation-drip.js
**Trigger:** Cron at 3 PM UTC daily. Fires for founding members who have not uploaded any document, signed up 4+ days ago, and haven't received Email 1 yet.
**From:** `heath@meetdossie.com` (bare address, no display name)
**To:** Inactive founding member
**Subject:** `Quick question about your first deal`
**Personalization:** First name from `full_name`. Falls back to "there".
**Body summary:** Brief personal check-in from Heath. Asks if they've added a first transaction. Offers to fix anything broken personally. One link "Open Dossie" to meetdossie.com/app. Plain text style, no HTML styling.

**Issues found:**
- [ ] **Plain-text HTML with no styling** — the email body is a bare HTML `<p>` block with no brand styling (no Cormorant heading, no Dossie wordmark, no brand colors). Every other customer-facing email in the system uses the `BRAND_BG / BRAND_NAVY / BRAND_CORAL` token set with a max-width container. This email looks like a different product.
- [ ] **From address has no display name** — `from: FROM_EMAIL` where `FROM_EMAIL = 'heath@meetdossie.com'`. This sends as a bare email address with no display name. Most email clients show `heath@meetdossie.com` rather than "Heath at Dossie". Should be `'Heath at Dossie <heath@meetdossie.com>'`.
- [ ] **"Hey [name] --"** — double-hyphen is technically ASCII but displays inconsistently across clients. Some render it as two hyphens, some auto-convert to an em-dash. Consistent use of a single hyphen or comma would be cleaner.
- [ ] **Link text is generic** — "Open Dossie" with no context. Should be "Add your first deal" or "Try it now — takes 2 minutes" to match the action described.

---

## Email 7: Activation Drip — Email 2 (day 7)
**File:** api/cron-activation-drip.js
**Trigger:** Cron at 3 PM UTC daily. Fires for founding members who received Email 1 and still haven't uploaded a document 7+ days in.
**From:** `heath@meetdossie.com`
**To:** Inactive founding member
**Subject:** `The fastest way to get value from Dossie`
**Personalization:** First name.
**Body summary:** Tells the agent to add one live deal (just address and close date). Promises TREC deadline calculation. CTA "Try it now" to meetdossie.com/app.

**Issues found:**
- Same styling issues as Email 6 (no brand treatment, bare from address).
- [ ] **Subject is slightly misleading** — "The fastest way to get value from Dossie" implies there are slower ways. It could just say "This takes 5 minutes and changes everything" (which is literally what the body says).

---

## Email 8: Activation Drip — Email 3 (day 14)
**File:** api/cron-activation-drip.js
**Trigger:** Cron. Fires for founding members who received Emails 1 and 2 and still haven't uploaded a document 14+ days in.
**From:** `heath@meetdossie.com`
**To:** Inactive founding member
**Subject:** `Your founding spot -- want me to help you get started?`
**Personalization:** First name.
**Body summary:** Acknowledges agent hasn't added a deal. Offers a quick call to walk them through it. Soft exit offer: "if Dossie isn't the right fit right now, no hard feelings."

**Issues found:**
- Same styling issues as Emails 6-7.
- [ ] **Double-hyphens in subject line** — `Your founding spot -- want me to help you get started?` The `--` in a subject line renders as `--` in most clients and as an em-dash in Apple Mail. Inconsistent across clients.
- [ ] **Missing urgency hook** — this email is a last-chance intervention at day 14. It is the most critical email in the sequence to retain an at-risk subscriber. It is also the blandest: no mention of founding spot scarcity, no mention of what they are missing, no concrete example of a problem Dossie solves. Compare to Email 5 (approval) which has real specificity and urgency.

---

## Email 9: Referral Ask Email (day 14-21)
**File:** api/cron-activation-drip.js
**Trigger:** Cron. Fires for founding members who HAVE uploaded a doc, are 14-21 days old, and haven't received a referral ask yet.
**From:** `heath@meetdossie.com`
**To:** Activated founding member
**Subject:** `Know another agent who needs this?`
**Personalization:** First name. Live remaining spot count pulled from `subscriptions` table.
**Body summary:** Thanks the agent for using Dossie over the past couple of weeks, provides the founding URL, states remaining spots with live count, clarifies no referral commission, closes with gratitude.

**Issues found:**
- Same styling issues as Emails 6-8.
- [ ] **"You've been running deals through Dossie for a couple weeks now"** — this fires based only on signup date, not actual usage. An agent who signed up 14 days ago but never used the product will receive this sentence as a lie. The query checks that they have at least one document uploaded, but "running deals" implies active use beyond a single upload. The phrasing should be hedged: "If Dossie has been saving you time on your deals..."
- [ ] **No concrete ask** — "send them here" is a weak ask. Stronger: "Forward this email to one agent you think would benefit."

---

## Email 10: Deadline Reminder Emails
**File:** api/cron-deadline-reminders.js
**Trigger:** Cron at 13:05 UTC daily. Multiple variants: T-7, T-1, T-0 for each deadline type, plus conditional reminders (earnest money not confirmed, inspection not completed, appraisal not received, loan approval pending, HOA docs not received, inspection tomorrow, wire fraud warning not sent, new construction completion, land survey, builder warranty, lease renewal, lease move-in, HOA approval).
**From:** `Dossie <dossie@meetdossie.com>`
**To:** Agent with active dossier
**Subject (T-7):** `Heads up: [deadline label] in 7 days for [property_address or "your dossier"]`
**Subject (T-1):** `Tomorrow: [deadline label] for [property_address or "your dossier"]`
**Subject (T-0):** `Today: [deadline label] for [property_address or "your dossier"]`
**Personalization:** First name from profile, property address from transaction.
**Body summary:** Names the specific deadline and property, states days remaining in natural language, links to meetdossie.com/app with a coral button. Closes as "- Dossie" with a footer explaining how to stop reminders.

**Issues found:**
- [ ] **CTA button goes to meetdossie.com/app (no deep link)** — agent must navigate to the specific dossier themselves. The button should ideally deep-link to the specific transaction. Even linking to `meetdossie.com/app#dossier-{transactionId}` would be better than dropping them at the pipeline top level when they are mid-deadline.
- [ ] **"your active dossier" fallback** — when property_address is null, subjects read "Today: Closing date for your dossier" which is generic and confusing if the agent has multiple dossiers. The property address should be required data; if missing, the reminder could be suppressed or the subject should say "one of your dossiers" to signal ambiguity.
- [ ] **Wire fraud reminder uses buildEmailHtml with `daysOut: 0`** — the rendered email header says "DOSSIE · TODAY" even though the wire fraud warning may have been owed for weeks. The eyebrow "TODAY" is inaccurate and alarmist for a catch-all check. The wire fraud reminder should have its own template that explains the issue, not just a date-reminder layout.
- [ ] **Conditional reminders reuse the standard deadline layout** — the conditional reminder for "earnest money not confirmed" shows the option expiration date and says "The Option period expires — earnest money not yet confirmed for [property] is in 2 days." This is grammatically broken. The `deadlineLabel` string becomes the subject of "The ... is in N days" sentence. With compound labels like "Inspection tomorrow with your inspector — confirm access and readiness", the sentence "The Inspection tomorrow with your inspector — confirm access and readiness is in 1 days" is unreadable.

---

## Email 11: Email Draft Digest
**File:** api/cron-email-digest.js
**Trigger:** Cron at 13:00 UTC daily (8 AM CDT). Fires for active customers who have at least one non-sent email in their queue.
**From:** `Dossie <dossie@meetdossie.com>`
**To:** Agent with pending email drafts
**Subject:** `Dossie - you have N draft(s) waiting`
**Personalization:** First name from profile. Per-draft: property address, subject, recipient name/email, status, age.
**Body summary:** "Good morning, [name]." header, count of pending drafts, one card per draft showing property, subject, recipient, status, age, and a "Review and send" CTA. Master "View all in Dossie" button at the bottom. Footer explains why they receive this.

**Issues found:**
- [ ] **Subject line uses a hyphen instead of an em-dash** — `Dossie - you have 3 drafts waiting`. A branded subject like "3 email drafts waiting in Dossie" or "Your Dossie queue: 3 drafts ready to send" is cleaner and more specific.
- [ ] **"Good morning, [name]."** — this fires at 8 AM CDT but agents in Central time who read at night (email delay) will see "Good morning" at 11 PM. Low severity but worth noting.
- [ ] **Per-draft CTA links to meetdossie.com/app#emails** — this is a fragment link that jumps to the email section, but does not deep-link to the specific draft. If the agent has 5 drafts they must identify which one by subject. Better would be a per-draft link to the specific dossier's email view.
- [ ] **Clean — no critical issues.** The structure, voice, and formatting are all good. The card layout is the best-designed template in the system.

---

## Email 12: Weekly Newsletter
**File:** api/cron-weekly-newsletter.js
**Trigger:** Cron at 15:00 UTC Fridays (10 AM CDT). Reads WEEKLY-IMPROVEMENTS.md, rewrites via Claude Haiku, sends to all active customers + heath@meetdossie.com.
**From:** `Dossie <dossie@meetdossie.com>`
**To:** All active paying customers + heath@meetdossie.com
**Subject:** `Dossie weekly update — [May 22-28]`
**Personalization:** None — same email sent to every recipient (no personalization by name).
**Body summary:** AI-rewritten changelog section of WEEKLY-IMPROVEMENTS.md, formatted into header/paragraph pairs. Includes CTA to open Dossie and a footer link to the Founding Files Facebook group.

**Issues found:**
- [ ] **No name personalization** — every customer receives "What's new in Dossie this week" with no greeting and no name. The greeting field from the AI rewrite is used as a `<p>` under the headline, but there is no "Hi Sarah," opener. This is the one email in the system that uses `escapeHtml(greeting)` as body text — if Haiku returns an empty greeting string (which happens when there are no customer-facing items), the greeting block is blank.
- [ ] **Sent as one-to-one emails to each address** — the loop calls `sendResend(email, subject, html)` individually for each customer. With 12 customers this is fine. At 100+ customers this will hit Resend rate limits and slow down significantly. No issue right now but worth flagging for scale.
- [ ] **`ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'`** — this model ID format looks non-standard (the current Haiku model is `claude-haiku-4-5`). Verify this resolves correctly against Anthropic's API or the newsletter will silently fail.

---

## Email 13: DossieSign Signing Email (to buyer/seller)
**File:** api/esign-create.js
**Trigger:** Agent initiates a signature request in the Dossie app. Fires for each non-agent signer.
**From:** `Dossie <sign@meetdossie.com>`
**To:** Buyer or seller (external party, not the agent)
**Subject:** `Action Required: Please sign [documentName] for [property address]`
**Personalization:** Signer name from signers array. Document name. Property address from transaction.
**Body summary:** Addresses signer by name, explains their agent sent a document for review and signature. Shows document name and property address. Coral "Review & Sign Document" button linking to DocuSeal slug URL. Fallback URL as plain text. Footer mentions questions can go to heath@meetdossie.com.

**Issues found:**
- [ ] **Footer says "Questions? Reply to heath@meetdossie.com"** — the signing email goes to an external third party (buyer or seller). That person's questions about the document should go to their agent, not to Heath personally. This exposes Heath to direct contact from strangers about deals he has no context on. Should be "Questions? Contact your agent directly."
- [ ] **No fallback text for missing property address** — if `propertyAddress` is empty, the subject becomes "Action Required: Please sign [documentName]" (no "for [address]" suffix, which is fine). The body conditionally hides the property line, which is correct. But if `documentName` is also generic (e.g., "Document.pdf"), both lines are unhelpful. Low risk since document names are set at upload.
- [ ] **No mention of who sent the document** — the email says "Your agent has sent you a document." It does not say which agent or which brokerage. External signers who receive this from an unknown `sign@meetdossie.com` address have no way to verify legitimacy without the agent name. Should include "Sent by [Agent Name]" or "Requested by [Agent Name]."

---

## Email 14: DossieSign Completion Email (to agent)
**File:** api/esign-webhook.js
**Trigger:** DocuSeal webhook `form.completed` event when all signers have signed.
**From:** `Dossie <heath@meetdossie.com>`
**To:** Agent (Dossie user who initiated the signature request)
**Subject:** `All signatures complete: [fileName]`
**Personalization:** Agent name from profile. File name.
**Body summary:** "Hi [name]," confirms all parties have signed, tells agent the signed copy is saved to their Dossie document library. Link to meetdossie.com/app.

**Issues found:**
- [ ] **From address is `heath@meetdossie.com` not `dossie@meetdossie.com`** — this is an automated system email (DocuSeal webhook fires it, not Heath). It should come from `dossie@meetdossie.com` like every other system notification. Using `heath@meetdossie.com` is misleading — agents will reply to Heath expecting him to have context on the specific document.
- [ ] **No name fallback is "there"** — `Hi ${agentName || 'there'},` — correct pattern, consistent with the codebase standard.
- [ ] **No mention of which transaction or property** — subject is just `All signatures complete: Document.pdf`. If the agent has 3 active transactions, they cannot tell at a glance which one completed. Should include property address if available.
- [ ] **No unsubscribe or "why am I getting this"** footer.

---

## Email 15: DossieSign Seller Agent Email (executed PDF delivery)
**File:** api/esign-webhook.js
**Trigger:** Same `form.completed` webhook, when `seller_agent_email` is set on the signature request.
**From:** `Dossie <heath@meetdossie.com>`
**To:** Seller's agent (external — opposing agent in the deal)
**Subject:** `Executed contract: [property address]` or `Executed contract: [fileName]`
**Personalization:** `sellerAgentName` from signature request. Falls back to "there".
**Body summary:** "Hi [name], Please find the fully executed purchase contract attached. All parties have signed. Sent via DossieSign." Small tagline "Dossie — Your deals. Her job."

**Issues found:**
- [ ] **From address is `heath@meetdossie.com`** — same issue as Email 14. An external agent receiving the executed contract will see it from "Heath" and may try to correspond with Heath rather than the buyer's agent. Should be `Dossie <dossie@meetdossie.com>` with `reply_to` set to the buying agent's email.
- [ ] **No reply_to set** — the seller's agent cannot easily reply to the buying agent. This is a real workflow need in Texas RE — seller's agent often replies to contract delivery to confirm receipt or ask questions. A reply should route to the buying agent, not to Heath or Dossie.
- [ ] **Uses em-dash `&mdash;`** — the tagline `"Dossie &mdash; Your deals. Her job."` uses an HTML entity em-dash. Per CLAUDE.md content rules, no em-dashes in any email content. This should be a hyphen: "Dossie - Your deals. Her job."

---

## Email 16: Cancellation Confirmation Email
**File:** api/cancel-subscription.js
**Trigger:** Agent clicks Cancel Subscription in the app settings. Sends after Stripe subscription is set to cancel_at_period_end.
**From:** `Dossie <dossie@meetdossie.com>`
**To:** Cancelling agent
**Subject:** `Subscription Cancelled — Access Until [date]`
**Personalization:** Access end date from Stripe. No name used.
**Body summary:** Confirms cancellation, states access end date, lists what happens after (account locked, data retained 30 days, reactivation via email). Invitation to reply if cancelled by mistake.

**Issues found:**
- [ ] **No greeting with name** — email opens with "We've cancelled your Dossie subscription..." with no "Hi Sarah," opener. Every other major email in the system uses a personalized greeting.
- [ ] **"We've" voice is wrong** — all other Dossie emails use Dossie's first-person voice ("I work nights and weekends...") or sign off as "— Dossie" or "— Heath." This email uses corporate "we" which breaks the brand voice entirely.
- [ ] **Signed off as "Heath & the Dossie team"** — implies there is a team when there isn't. Should be "— Heath" or "— Dossie" consistent with other emails.
- [ ] **End date accuracy** — if Stripe's `cancel_at` is null (unlikely but possible for some cancellation modes), the end date shows as "the end of your billing period" which is vague. The agent should know the exact date.
- [ ] **No reactivation CTA or link** — tells agent they can reactivate by emailing heath@meetdossie.com within 30 days but provides no link and no prefilled email link. Given this is a high-stakes moment (churned customer), a "Changed your mind? Reactivate here" button pointing to the app or to a mailto link would be appropriate.

---

## Email 17: Follow-up Email (action item escalation)
**File:** api/cron-followup.js
**Trigger:** Cron at noon UTC daily. Fires for action items that are 48+ hours overdue and have an `assigned_to_email` set, with a 24h throttle.
**From:** `Dossie <dossie@meetdossie.com>`
**To:** Counterparty (lender, title officer, inspector, or whoever the action item is assigned to)
**Subject:** `Re: [original email subject]` or `Following up — [property address]`
**Personalization:** `assigned_to_name` from action item. Deal address from linked transaction.
**Body summary:** Sends the email body from the action item's `email_body` field (the full drafted email Dossie wrote). Falls back to a generic "wanted to check in" message. Signed "- Dossie" with a spam-folder tip footer.

**Issues found:**
- [ ] **Sent from `dossie@meetdossie.com` but body is signed "- Dossie"** — the follow-up goes to an external third party (lender, title, etc.) who has no relationship with Dossie. The email appears to come from an AI assistant acting autonomously on the agent's behalf without the counterparty's knowledge. This is potentially confusing or off-putting for professionals receiving unsolicited follow-ups from "Dossie." Should include "Sent on behalf of [agent name]" context.
- [ ] **Subject `Re: [email_subject]`** — if `email_subject` is null, the subject becomes `Following up` with no context. The `dealTag` appends ` — [property]` but only if propertyAddress is set. An agent with multiple deals involving the same lender cannot distinguish which deal this follow-up relates to.
- [ ] **Generic fallback body** — the fallback `"I wanted to check in regarding [deal]. Is there anything you need from me to keep things moving?"` is signed as Dossie sending to an external party. This presumes the external party knows what Dossie is and why they are receiving this.

---

## Email 18: Compliance Packet Email
**File:** api/send-compliance-packet.js
**Trigger:** Agent clicks "Send Compliance Packet" in app. Sends all documents attached to a dossier to the agent's brokerage compliance email.
**From:** `[Agent Name] via Dossie <heath@meetdossie.com>`
**To:** Agent's brokerage compliance department (from profile.compliance_email)
**Reply-to:** Agent's email
**Subject:** `Closing packet — [property address or "Dossie deal"]`
**Personalization:** Agent name from profile, brokerage, transaction type, closing date, document list.
**Body summary:** Cover letter listing agent info, transaction type, closing date, document count, and named list of attachments. Closes with "Sent via Dossie on behalf of [agent]. Reply to this email to reach the agent directly."

**Issues found:**
- [ ] **Subject is generic when property_address is null** — `Closing packet — Dossie deal` is meaningless to a compliance officer processing hundreds of files. Property address should be required before the send is allowed, not silently defaulted to "Dossie deal".
- [ ] **Clean overall** — the cover letter is functional, professional, and includes all necessary context. The `reply_to` routing to the agent is correct behavior. The from-address pattern `[Agent Name] via Dossie <heath@meetdossie.com>` is the right approach for now.

---

## Email 19: Support Ticket Notification (to Heath)
**File:** api/support.js
**Trigger:** Agent submits a support ticket from the in-app feedback modal.
**From:** `Dossie Support <dossie@meetdossie.com>`
**To:** heath.shepard@kw.com
**Subject:** `[Dossie Bug] from agent@email.com` (type in brackets, agent email in subject)
**Personalization:** Ticket type label, agent email, ticket ID, message content.
**Body summary:** Internal notification to Heath. Shows ticket type, from address, ticket ID, and message verbatim.

**Issues found:**
- [ ] **Internal email only — no customer-facing issues.** Heath receives this in his inbox. No issues.
- [ ] **No customer acknowledgment email** — the agent submits a support ticket and receives no confirmation that it was received. They have no ticket ID, no expected response time, nothing. This creates support anxiety. A simple "Got your message — Heath will respond within 24 hours" reply would reduce follow-up tickets.

---

## Email 20: Weekly Newsletter Model ID Risk (already flagged under Email 12)
Covered above. The ANTHROPIC_MODEL string `claude-haiku-4-5-20251001` should be verified against Anthropic's current model IDs.

---

## Emails NOT Found (from the original checklist)
- **cron-calculator-deadline-reminders.js** — read the file, confirmed it does NOT send email (sends Telegram only, or is a duplicate check only). No email.
- **cron-followup.js alert section** — the near-deadline alerts at the bottom of the function compute `alerts[]` but DO NOT send email. They are returned in the JSON response only. Not a customer email.

---

## Priority Fix List

### Must fix before next customer signup:

1. **Set Password email — subject conflict** (Emails 2 and 4): Change subject from "Welcome to Dossie — Set Your Password" to "Set your Dossie password" so inbox threading is unambiguous and the two simultaneous emails look distinct.

2. **Set Password email — link expiry claim** (Emails 2 and 4): Change "This link expires in 24 hours" to "This link expires in 1 hour" to match Supabase default, OR update the Supabase project OTP expiry to 24 hours in the dashboard to match the claim. Either is acceptable; they must agree.

3. **DossieSign signing email — footer contact** (Email 13): Change "Questions? Reply to heath@meetdossie.com" to "Questions? Contact your agent directly." External parties should not be directed to Heath.

4. **DossieSign completion email — wrong from address** (Emails 14 and 15): Change `Dossie <heath@meetdossie.com>` to `Dossie <dossie@meetdossie.com>` for both the agent completion email and the seller agent delivery email. Add `reply_to` on the seller agent email pointing to the buying agent's email.

5. **Seller agent email — em-dash** (Email 15): Change `&mdash;` to ` - ` in the tagline. Violates CLAUDE.md content rules.

### Should fix this week:

6. **Activation drip emails — no brand styling** (Emails 6, 7, 8, 9): Add the standard brand wrapper (BRAND_BG container, BRAND_NAVY text, Dossie wordmark, Cormorant heading) to match the rest of the system. Plain `<p>` tags look like spam compared to the welcome email.

7. **Activation drip emails — from address display name** (Emails 6, 7, 8, 9): Change `from: 'heath@meetdossie.com'` to `from: 'Heath at Dossie <heath@meetdossie.com>'` to show a display name.

8. **Cancellation email — voice and greeting** (Email 16): Add personalized "Hi [name]," opener. Replace "We've" with first-person Dossie voice or Heath voice. Change sign-off from "Heath & the Dossie team" to "— Heath" or "— Dossie."

9. **Set Password email — add name greeting** (Emails 2 and 4): Add "Hi [name]," opener. The welcome email does this; the password email should too.

10. **DossieSign completion email — add property address to subject** (Email 14): Change subject from "All signatures complete: Document.pdf" to "All signatures complete: Document.pdf — 1247 Sample Way" so the agent can identify the deal at a glance.

11. **Duplicate welcome/password template** (Emails 1-4): Extract `welcomeEmailHtml` and `setPasswordEmailHtml` into `api/_lib/email-templates.js` shared module. Right now any edit to one file silently diverges from the other.

12. **Welcome email — two-email confusion** (Emails 1 and 3): The welcome email instructs agents to "check your inbox for our Set Your Password email." Consider merging both emails or at minimum reordering so password email fires first, then welcome, so the instruction makes sense in inbox order.

### Polish (nice to have):

13. **Weekly newsletter — add personalized greeting** (Email 12): Personalize each customer's email with "Hi [name]," opener before the newsletter body.

14. **Deadline reminder — deeper link** (Email 10): Link the "Open dossier" button to the specific dossier URL rather than the app homepage.

15. **Email digest — per-draft deep links** (Email 11): Link each "Review and send" button to the specific dossier's email view rather than the generic #emails fragment.

16. **Referral ask email — phrasing** (Email 9): Change "You've been running deals through Dossie for a couple weeks now" to a conditional phrasing that doesn't assume heavy usage.

17. **Support ticket — customer acknowledgment** (Email 19): Send a brief confirmation email to the agent who submitted the ticket confirming receipt and setting response-time expectations.

18. **Follow-up email — counterparty context** (Email 17): Add "Sent on behalf of [agent name]" to the follow-up body so external parties know who this assistant is acting for.

---

## Summary

| Email | Status |
|---|---|
| Welcome (complete-onboarding) | Issues — two-email confusion, duplicate template, DST timing |
| Set Password (complete-onboarding) | Issues — subject conflict, no name, wrong expiry claim, duplicate template |
| Welcome (invoice.paid) | Issues — same as above + name quality risk |
| Set Password (invoice.paid) | Issues — same as Email 2 |
| Founding approval | CLEAN |
| Activation drip Email 1 | Issues — no brand styling, no from display name |
| Activation drip Email 2 | Issues — no brand styling, no from display name |
| Activation drip Email 3 | Issues — no brand styling, no from display name, weak urgency |
| Referral ask | Issues — no brand styling, phrasing assumes heavy usage |
| Deadline reminders | Issues — no deep link, wire fraud tone wrong, broken sentence pattern |
| Email digest | Minor issues — subject hyphen, generic per-draft links |
| Weekly newsletter | Issues — no name personalization, model ID string to verify |
| DossieSign signing | Issues — footer contact is Heath, no sender identity |
| DossieSign completion (agent) | Issues — wrong from address, no property in subject |
| DossieSign seller agent | Issues — wrong from address, no reply_to, em-dash violation |
| Cancellation | Issues — no name, wrong voice, vague end date |
| Follow-up | Issues — external party context missing |
| Compliance packet | Minor — null property address fallback |
| Support notification (internal) | CLEAN (internal only; no customer ACK sent) |

**Total emails: 19 types**
**Clean: 2** (founding approval, support notification to Heath)
**Issues: 17**

**Top 3 most urgent fixes:**
1. DossieSign seller agent / completion emails from `heath@meetdossie.com` — external parties and agents getting emails "from Heath" on automated events will create direct Heath contact and confusion
2. Set password email expiry claim — if Supabase default is 1 hour and the email says 24 hours, agents will hit expired links and be unable to access their accounts
3. DossieSign signing email footer — directing buyers/sellers to contact heath@meetdossie.com creates direct Heath exposure to deals he has no context on
