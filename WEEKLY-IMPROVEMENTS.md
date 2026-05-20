# Dossie Weekly Improvements — for Heath to post to socials + Founding Files

This file is a running customer-friendly changelog. Items go in **in plain English**, no engineering jargon — read like an email to a real estate agent who has never seen the codebase. Each Friday (or whenever Heath wants to post), he can copy-paste the week's section into Facebook / Instagram / LinkedIn / the Founding Files FB group.

**Voice rules:**
- Lead with the benefit, not the implementation. "Scanning works on your phone now" beats "fixed onChange handler in file input."
- No technical terms: no "bundle", "z-index", "API", "TypeScript", "useEffect", "Vercel", "Vite", etc.
- "We" instead of "I" — feels like a team.
- Keep each item to 1-2 sentences max.
- Mention WHO asked for it when relevant ("Brittney pointed out that…") — gives Founding members credit.

---

## Week of May 13–20, 2026

**App + mobile**
- The Dossie app now works cleanly on your phone. Full mobile audit and redesign pass: forms stack one field per row, the right keyboard pops up automatically (numeric for prices, email keyboard for emails, phone keyboard for phone numbers), every button is now finger-friendly (44px minimum), modals scroll within the screen instead of getting cut off, and pinch-to-zoom now works if you want to take a closer look.
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

**Notes from Heath:**
- Pending: weekly post draft → copy specific items above into your Facebook Founding Files post.
