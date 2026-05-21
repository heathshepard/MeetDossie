# Release Announcement Template

Fill in the 3 blanks at the top, then copy/paste the 3 versions to email, FB group, and in-app banner.

---

## INPUTS (fill these in)

- **Feature name:** [e.g., "Amendment Drafting"]
- **One-sentence value:** [e.g., "Auto-fill TREC amendment forms from natural language"]
- **Specific example:** [e.g., "Say 'add 7 days to option period on 1847 Vintage Way' and get a signed-ready PDF in 10 seconds"]

---

## 1. EMAIL BLAST (send via Resend to all active customers)

**Subject:** New in Dossie: [Feature name]

**Body:**

Hi [Name],

Just shipped something I'm excited about: **[Feature name]**.

[One-sentence value]. [Specific example].

It's live now in your account — try it next time you're in a dossier. Reply if you have questions or feedback.

— Heath
heath@meetdossie.com
Founder, Dossie

---

## 2. FOUNDING FILES FB GROUP POST (post in the group)

Hey founders — just shipped **[Feature name]**.

[One-sentence value]. For example: [specific example].

It's live in your account right now. Try it and tell me what works / what doesn't. Your feedback drives what gets built next.

— Heath

---

## 3. IN-APP BANNER (add to Morning Brief page for 7 days after release)

**Banner text (one line, ~60 chars max):**

✨ NEW: [Feature name] is live — try it on your next dossier

**Action button:** "See how it works" → links to either the feature directly OR a 30-sec Loom you record showing it

**Auto-dismiss:** 7 days after launch date, or when user dismisses

---

## CADENCE

- Email + FB post: same day, within 30 min of each other
- In-app banner: same day, runs for 7 days then auto-hides

## V2 (when shipping more than 1 feature/month)

Build `/api/announce-release` endpoint that takes the 3 inputs, generates all 3 channels via Claude Haiku, and queues each for one-tap-send. Until then, this template is fast enough.
