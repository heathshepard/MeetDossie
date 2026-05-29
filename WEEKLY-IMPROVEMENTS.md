# Dossie Weekly Improvements — for Heath to post to socials + Founding Files

This file is a running customer-friendly changelog. Items go in **in plain English**, no engineering jargon — read like an email to a real estate agent who has never seen the codebase. Each Friday (or whenever Heath wants to post), he can copy-paste the week's section into Facebook / Instagram / LinkedIn / the Founding Files FB group.

**Voice rules:**
- Lead with the benefit, not the implementation. "Scanning works on your phone now" beats "fixed onChange handler in file input."
- No technical terms: no "bundle", "z-index", "API", "TypeScript", "useEffect", "Vercel", "Vite", etc.
- "We" instead of "I" — feels like a team.
- Keep each item to 1-2 sentences max.
- Mention WHO asked for it when relevant ("Brittney pointed out that…") — gives Founding members credit.

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
