# Dossie Weekly Improvements — for Heath to post to socials + Founding Files

This file is a running customer-friendly changelog. Items go in **in plain English**, no engineering jargon — read like an email to a real estate agent who has never seen the codebase. Each Friday (or whenever Heath wants to post), he can copy-paste the week's section into Facebook / Instagram / LinkedIn / the Founding Files FB group.

**Voice rules:**
- Lead with the benefit, not the implementation. "Scanning works on your phone now" beats "fixed onChange handler in file input."
- No technical terms: no "bundle", "z-index", "API", "TypeScript", "useEffect", "Vercel", "Vite", etc.
- "We" instead of "I" — feels like a team.
- Keep each item to 1-2 sentences max.
- Mention WHO asked for it when relevant ("Brittney pointed out that…") — gives Founding members credit.

---

## Week of May 29, 2026 (fill-and-sign expansion)

**Fill-and-sign now works for land and new construction contracts**
- Tell Dossie "fill out a contract for [address]" on a land or new construction dossier and she picks the right TREC form automatically. Land purchases use TREC 9 (Unimproved Property Contract). Farm and ranch deals use TREC 25 (Farm and Ranch Contract). New construction uses TREC 23 (incomplete) or TREC 24 (completed) depending on where the build stands. No more downloading the wrong form.
- All four new forms are embedded and ready - no setup required.

---

## Week of May 29, 2026 (hotfix)

**Form Library cleaned up**
- The Land Purchase form package was carrying extra forms it didn't need (New Home Contract forms snuck in during the build). Cleaned up - it now contains exactly the right five forms: TREC 9, TREC 25, Financing Addendum, Buyer Rep Agreement, and Wire Fraud Warning.

---

## Week of May 29, 2026 (continued, late build)

**Residential Lease transactions - Landlord and Tenant**
- Dossie now tracks rental transactions, not just purchases. When you create a new dossier, choose "Residential Lease (Landlord)" if you represent the owner, or "Residential Lease (Tenant)" if you represent the renter.
- Every lease dossier gets its own Lease section with all the fields that matter: monthly rent, security deposit, pet policy and pet deposit, application fee, lease start and end dates, and an auto-calculated lease term.
- Key dates are tracked in one place: application submitted, application approved, lease signed, move-in, move-out, and a renewal deadline Dossie calculates automatically as 60 days before the lease ends.
- If you represent the landlord, Dossie tracks the tenant's contact info, number of occupants, and whether background and credit checks are complete. If you represent the tenant, Dossie shows the landlord's contact info instead.
- The Move-In Condition Report section lets you check it off as complete and note any pre-existing damage in writing - timestamped and saved.
- Three lease-specific reminder emails fire automatically: when the renewal deadline is 30 days and 7 days away, the day before move-in, and an urgent alert if HOA approval is required but not received within 7 days of lease start.
- The lease form package (TAR 2001 Residential Lease, TAR 2003 Move-In Condition Form, Wire Fraud Warning) attaches automatically when you create the dossier.
- Talk to Dossie understands lease updates: say "application approved," "lease signed," "tenant moves in June 1," "monthly rent is $1,500," or "background check complete" and Dossie records it instantly.

---

## Week of May 29, 2026 (continued, evening build)

**New Construction (Buyer) transaction type**
- Dossie now handles new construction purchases as a completely separate transaction type — not just a relabeled resale dossier. When you create a dossier for a new build, you get everything the resale flow has plus a full Builder section built specifically for how builders work.
- The Builder section tracks the builder company name, the sales rep's name, phone, and email, and the contract date with the builder. When you get the warranty document, you check it off and Dossie records it. If the builder warranty is expiring in the next 30 days, Dossie sends you a reminder email.
- The Construction Phase Tracker follows the home from Foundation through Certificate of Occupancy — seven phases total. Tap any phase and set it to Not Started, In Progress, or Complete. Dossie timestamps it when you mark it complete.
- CO and possession are tracked separately from the closing date so nothing gets confused. Set the expected completion date, and if the CO hasn't been received within 7 days of that date, Dossie sends you a warning email.
- The Punch List section gives you a free-text area to capture everything found on the final walkthrough. When all items are cleared, check "Punch list cleared" and Dossie records the date.
- The New Construction form package is now in the Form Library: TREC 23 (incomplete construction), TREC 24 (completed construction), Third Party Financing Addendum, Buyer Rep Agreement, and Wire Fraud Warning. Apply all five to a dossier in one tap.
- Talk to Dossie understands new construction updates: say "CO received," "builder warranty expires June 15," "punch list cleared," or "the builder rep is John Smith at 210-555-1234" and Dossie updates the dossier immediately.

---

## Week of May 29, 2026 (continued, afternoon build)

**Pre-Contract dossiers**
- You can now open a dossier before you have a signed contract. Choose "Pre-Contract" when creating a new file and Dossie tracks the three things that matter in the showing phase: IABS delivery, the buyer rep agreement, and the pre-approval letter. Check each one off as it lands. When all three are done, Dossie prompts you to advance the dossier straight to Under Contract.
- Every active dossier now shows a soft reminder if the IABS hasn't been recorded as delivered — the banner shows up in the Deadlines section so it's the first thing you see.

**Offer comparison (seller-side)**
- Seller-side dossiers now have an Offers tab. Log each offer as it comes in — price, financing type, earnest money, option fee, option days, closing date, escalation clause. Dossie color-codes each offer (green = over list price, yellow = near list, red = below) so you can read the room at a glance. Update each offer's status (Pending / Accepted / Rejected / Countered) with one tap.

**Seller's Net Sheet**
- Right inside the Offers tab, click "Net Sheet" and enter the commission, mortgage payoff, escrow fee, and title costs. Dossie calculates the seller's estimated net proceeds in real time — line by line. Hit Print to get a clean PDF you can hand the seller at the listing appointment.

**Lead Paint disclosure banner**
- If a property was built before 1978, Dossie now shows a red banner in the dossier telling you the Lead Paint Addendum (OP-L) is required. No more forgetting on older homes.

**Seller's Disclosure reminder**
- Seller-side dossiers now show a reminder if the Seller's Disclosure Notice (OP-H) hasn't been received yet. Tap to mark it received and Dossie timestamps it.

**More forms for fill-and-sign (DossieSign)**
- Five more forms are now available through Talk to Dossie: HOA Addendum, Lead Paint Addendum, Buyer Rep Agreement, TREC 49-1 (Appraisal Termination), and T-47 Affidavit. Note: these forms use placeholder PDFs until the official TREC/TAR versions are loaded by Heath — the structure is live, just needs the real PDFs dropped in.

**MLS number now shows in the dossier header**
- For seller-side transactions, the MLS number now appears prominently at the top of the dossier so you never have to dig for it.

---

## Week of May 29, 2026 (continued)

**Title commitment and survey tracking**
- Every dossier now has a Title Commitment and Survey section. Tap to record when the title commitment arrived, what the effective date is, when the survey was ordered, and when it came back. Check off "Survey clear" when the title company confirms it. Dossie tracks all of it in one place.
- You can also mark the loan as approved and flip the "Clear to close" toggle right from that section. If the loan approval deadline is three days away and the loan hasn't been confirmed, Dossie sends you a reminder email.

**HOA document tracking (expanded)**
- The HOA section now tracks when you requested the HOA documents and when they arrived. Check off "received" and Dossie timestamps it. If the HOA document deadline is three days away and the documents haven't come in, Dossie sends you an email reminder.

**Closing checklist**
- Each dossier now has a built-in pre-closing checklist so nothing slips through on closing day. Buyer-side dossiers get: CD reviewed, commission amounts verified, prorations verified, payoff confirmed, wire fraud warning acknowledged, final walkthrough, repairs verified, and fixtures confirmed. Seller-side dossiers get: CD reviewed, net proceeds match, payoff confirmed with lender, and keys ready. Check each item off as you go.

**Post-closing tracking**
- After the close, Dossie tracks the three things that always get dropped: recorded deed received, title policy delivered to the buyer, and CDA signed by the broker. Check all three and Dossie offers to archive the dossier automatically.
- CDA (Commission Disbursement Authorization) has been added to the Form Library so you can attach it to any dossier.
- T-47 Residential Real Property Affidavit has also been added to the Form Library.

**Download ZIP improvements**
- The compliance ZIP download is now formatted for SkySlope and Dotloop. Documents are automatically sorted - contract first, then amendments, then addenda, then disclosures - and each file gets a numbered prefix (01-Contract.pdf, 02-Amendment.pdf, etc.) so your brokerage portal uploads them in the right order.
- Every ZIP now includes a cover sheet (00-COVER.txt) with the property address, buyer and seller names, and document count for easy reference.

**Land purchase dossiers**
- We added a full Land Purchase transaction type. When you open a file for vacant land, Dossie shows a dedicated Land Details section with everything a land deal needs: total acreage, legal description, parcel/tax ID, current zoning, deed restriction review, survey type (boundary, ALTA, fence), survey ordered/received dates, utilities confirmed (water, sewer, electric, gas, internet, road access), FEMA flood zone, wetlands flag, and Phase 1 environmental study tracking. The Land Purchase form set (TREC 9 Unimproved Property Contract, TREC 25 Farm and Ranch, Third Party Financing Addendum, Buyer Rep, and Wire Fraud Warning) is auto-attached when you create the dossier. You can also tell Dossie things like "survey received" or "flood zone is Zone X" and she updates the file automatically.

---

## Week of May 29, 2026

**Option period tracking**
- Dossie now tracks the option fee in detail: how much it was, who it was paid to, and when it was delivered. All editable right inside the dossier.
- Earnest money gets its own tracking section too: deposit amount, when it was sent to title, and when title confirmed they have it. If your option period is expiring soon and earnest money hasn't been confirmed, Dossie will warn you right on the screen and send you a reminder email.

**Inspection tracking**
- The Inspection section in every dossier now shows the inspector's name, phone, and email alongside the inspection date. You can record when the inspection happened and check off when the report came in. If the inspection isn't done three days before your option expires, Dossie will flag it.

**Appraisal tracking**
- Dossie now tracks when the appraisal was ordered, when it came back, and the appraised value. If the home appraises below the sale price, a red banner appears right in the dossier telling you exactly how big the gap is and reminding you about the TREC 49-1 option.
- TREC 49-1 (Right to Terminate Due to Lender's Appraisal) is now in the Form Library so you can attach it to any transaction in one tap.
- If the appraisal deadline is two days away and no appraisal has been received, Dossie sends you an email reminder.

**Repair amendments**
- You can now ask Dossie to "draft a repair amendment for the HVAC filter and the leaking faucet in the master bath, deadline June 15" and she'll fill out TREC 39-10 with a numbered list of repairs and the completion deadline. No more typing it out by hand.

---

## Week of May 13–20, 2026

**App + mobile**
- The Dossie app now works cleanly on your phone. Full mobile audit and redesign pass: forms stack one field per row, the right keyboard pops up automatically (numeric for prices, email keyboard for emails, phone keyboard for phone numbers), every button is now finger-friendly (44px minimum), modals scroll within the screen instead of getting cut off, and pinch-to-zoom now works if you want to take a closer look.
- The section tabs at the top of each deal (Deadlines / Deal / Property / Title / etc.) now have a soft fade at the right edge so you can tell at a glance that there's more to swipe through.
- Talk to Dossie is always one tap away on mobile. As soon as you start scrolling, the top bar transforms into a big, full-width "📞 Talk to Dossie" button that follows you down the page — never have to scroll back up to get to her.
- The Talk to Dossie button on mobile now sits right next to your avatar at the top, instead of floating in the middle of the screen.
- The Pipeline icon in the bottom navigation now correctly takes you back to your full pipeline view when you're inside a deal (used to get stuck on the deal screen).
- Switching between Brief / Pipeline / Emails / Settings remembers where you scrolled on each tab — no more jumping back to the top every time.
- Removed those subtle outline borders around the sidebar that made the app feel cluttered.

**Compliance card redesign**
- The contract scan report got a friendly facelift. Instead of a harsh red "compliance issues" warning, you now see "A few things to check" with each finding grouped into collapsible sections (Missing initials, Missing addenda, etc.) — so you can expand only what matters to you.
- New "Everything looks good ✓" section shows you what passed (signatures, initials, blank fields, etc.) so you can see the wins, not just the gaps.
- The full AI summary is now tucked behind a "See full details" toggle — collapsed by default so the report doesn't read like a wall of text.

**Scanning improvements**
- Scanning an Executed Contract now auto-fills five more deadline dates that were getting missed before: Possession Date, Appraisal Deadline, Survey Deadline, HOA Document Deadline, and Loan Approval Deadline. So your dossier comes pre-loaded with the dates that matter the moment you upload the signed contract.
- Mobile scan now gives you clear feedback at every step — when the file is received, when it's uploading, when it's working, and exactly what went wrong if something fails (instead of silently doing nothing).
- Clearer error message if a PDF is too big to scan, so you know to compress and re-upload instead of waiting forever.
- Softer wording when the scan finds items to review — "a few notes to review below" instead of "has compliance issues."

## Week of May 21–27, 2026

**Follow-up emails are clearer now**
- When Dossie sends an automatic follow-up on a task you haven't heard back on, the email now shows which deal it's about — the property address shows up in the subject line and at the top of the message. No more "wait, which file is this?" when you've got three deals open.

**Notes from Heath:**
- Pending: weekly post draft → copy specific items above into your Facebook Founding Files post.

## Week of May 28, 2026

**DossieSign — fill it, sign it, send it**
- You can now send contracts for digital signature right inside Dossie. Upload any PDF, Dossie routes it to buyer 1, then buyer 2, then you — in order, automatically. No more DocuSign tab-switching.
- After the last signature lands, Dossie emails the fully executed contract to the seller's agent automatically. One workflow, zero manual forwarding.
- You can fill out a TREC contract just by talking to Dossie — tell her "write a contract to purchase 123 Main St for $425,000" and she fills in the form fields from the conversation. The filled PDF lands in your dossier instantly.

**Form Library**
- Every standard TREC form is now inside Dossie — browse all 12 forms by category, search by name or form number, and attach any form to a deal in one click. No more downloading from the TREC website.

**Form Packages**
- New deals start faster. Apply the full Buyer Transaction or Seller Transaction package in one click and all the right forms land in the dossier together. You can also build your own custom package and save it.

**Desktop layout**
- The document buttons in each deal (Upload, E-sign, Form Library, Packages) now sit in a clean horizontal row on desktop instead of stacking vertically. Easier to scan, faster to use.

---

## Week of May 29, 2026 (final lifecycle build — Blocks 13 and 14)

**Talk to Dossie understands every stage of the deal now**
- Ask Dossie to "send the wire fraud warning to Sarah Martinez" and she triggers the TAR 2517 form + routes it to the buyer for signature — no hunting for the form yourself.
- Tell Dossie "we got an offer for $415,000 with $5,000 earnest money and a 7-day option, closing July 15" and she logs it in the offer comparison table for that listing. No manual entry.
- Say "buyer wants to terminate" and Dossie surfaces TREC 38-7 (Buyer Termination of Contract) immediately — prefilled with the deal details and ready to send.
- When the buyer's pre-approval letter comes in, tell Dossie "pre-approval received" — she marks it confirmed and prompts you to upload the document to the dossier.

**Smarter reminder emails**
- If an inspection is scheduled for tomorrow, Dossie now emails you the night before to confirm the inspector and access — includes the inspector name and phone number in the message.
- Loan approval reminders now fire at both T-3 (three days out) and T-1 (the day before the deadline), not just T-3. You'll always get a second warning if nothing has been confirmed.
- If no wire fraud warning has been sent for an active deal, Dossie now sends a one-time alert so nothing falls through the cracks on this legally sensitive document.

**Full buyer-side transaction lifecycle — complete**
- The full buyer-side residential resale workflow is now covered from pre-contract through post-closing: pre-approval, buyer rep agreement, IABS delivery, contract fill and sign, wire fraud warning, option period tracking, earnest money confirmation, inspection scheduling, repair amendments, appraisal tracking, title commitment, loan approval, HOA documents, pre-closing checklist, closing, and post-closing deed and CDA tracking. Every phase. Every document. Every deadline.

