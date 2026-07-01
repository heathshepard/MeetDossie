# Weekly Blast Draft — Friday July 3, 2026

**Status:** DRAFT — awaiting Atlas APV Thursday July 2 noon CST, then send Friday July 3 8:30 AM CST.
**From:** heath@meetdossie.com
**Cadence:** Per `feedback_thursday_apv_friday_send.md`. Send via `api/cron-thursday-blast.js` (Resend) to active founding members only (`subscriptions.status='active'`, `profiles.is_demo=false`).
**Author:** Pierce
**Heath travel note:** On train Chamonix → Wengen Friday morning. Send is automatic.

---

## Subject line

**A few fixes worth knowing about**

(5 words. Plain. No urgency theater.)

## Pre-header

The TREC 20-18 checkboxes now print right, Talk-to-Dossie can fill your forms in chat, and a few more.

---

## Email body — plain text

```
{FirstName},

Quick mid-week note while I'm in the Alps. A handful of things shipped this week that you'll probably notice the next time you open a deal:

— TREC 20-18 checkboxes now print correctly. The "Accepts As Is" and financing-section checkboxes were rendering blank in some PDF viewers even when you'd selected them. Fixed everywhere now — Chrome, mobile, Adobe, all of it.

— Talk-to-Dossie can fill a form for you and show it in the chat. Ask her to fill the resale contract on your active deal and she'll pull the dossier details, fill the fields, and drop a preview right in the conversation. Open the PDF when it looks right.

— Multi-signer fill-and-sign works again. Contracts with both buyers and sellers (or co-buyers) were failing to prefill on the second signer's turn. That's fixed.

— Attach button shows your full files, not just the camera. If you tried to attach a photo from your library on your phone and it jumped straight to the camera, that's resolved. You'll see your gallery, files, and camera as options.

— Customer Activity and To-Do panels work on Samsung Z Fold. A few of you on foldables were seeing "Offline" on those panels even when you weren't. They show real data again.

— Founding page icons. Some of you saw little hamburger lines instead of icons on the founding page on certain phones. Fixed — every feature card and Texas badge renders properly across devices now.

If anything on your end is still off, reply to this email. I read every one — that's still the deal.

Heath
heath@meetdossie.com
```

## Email body — simple HTML

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Georgia, serif; font-size: 16px; line-height: 1.6; color: #1A1A2E; max-width: 560px; margin: 0 auto; padding: 32px 16px; }
  a { color: #C9A96E; }
  p { margin: 0 0 16px; }
  .bullet { margin: 0 0 14px; padding-left: 12px; border-left: 2px solid #F5E6E0; }
</style>
</head>
<body>
<p>${firstName},</p>

<p>Quick mid-week note while I'm in the Alps. A handful of things shipped this week that you'll probably notice the next time you open a deal:</p>

<p class="bullet"><strong>TREC 20-18 checkboxes now print correctly.</strong> The "Accepts As Is" and financing-section checkboxes were rendering blank in some PDF viewers even when you'd selected them. Fixed everywhere now — Chrome, mobile, Adobe, all of it.</p>

<p class="bullet"><strong>Talk-to-Dossie can fill a form for you and show it in the chat.</strong> Ask her to fill the resale contract on your active deal and she'll pull the dossier details, fill the fields, and drop a preview right in the conversation. Open the PDF when it looks right.</p>

<p class="bullet"><strong>Multi-signer fill-and-sign works again.</strong> Contracts with both buyers and sellers (or co-buyers) were failing to prefill on the second signer's turn. That's fixed.</p>

<p class="bullet"><strong>Attach button shows your full files, not just the camera.</strong> If you tried to attach a photo from your library on your phone and it jumped straight to the camera, that's resolved. You'll see your gallery, files, and camera as options.</p>

<p class="bullet"><strong>Customer Activity and To-Do panels work on Samsung Z Fold.</strong> A few of you on foldables were seeing "Offline" on those panels even when you weren't. They show real data again.</p>

<p class="bullet"><strong>Founding page icons.</strong> Some of you saw little hamburger lines instead of icons on the founding page on certain phones. Fixed — every feature card and Texas badge renders properly across devices now.</p>

<p>If anything on your end is still off, reply to this email. I read every one — that's still the deal.</p>

<p>Heath<br>heath@meetdossie.com</p>

<p style="font-size:13px; color:#888; margin-top:32px;">Heath Shepard | Dossie | <a href="https://meetdossie.com">meetdossie.com</a></p>
</body>
</html>
```

---

## APV checklist — Atlas runs this Thursday July 2 noon CST

Sign in as the demo account at `meetdossie.com/app` (DEMO_PASSWORD in env). Capture a screenshot for each row showing the EXPECTED visible behavior. Items that fail APV are removed from the email OR fixed before Friday 8:30am send.

| # | Feature | URL | Action | Expected visible behavior | Pass/Fail |
|---|---|---|---|---|---|
| 1 | TREC 20-18 checkboxes render in PDF | `meetdossie.com/app` → open any buyer-side dossier with TREC 20-18 attached → fill at least one "Accepts As Is" or financing checkbox → generate PDF | Generated PDF opens in browser; the checked checkboxes show an X (or equivalent mark) visibly inside the box. NOT blank. View in Chrome PDF viewer specifically (this was the failure mode). | |
| 2 | Talk-to-Dossie fills form in chat | `meetdossie.com/app` → open any active buyer-side dossier → open Talk-to-Dossie → say or type "Fill out the resale contract" | Chat shows Dossie acknowledged the request, extracted the fields, and rendered a preview/link to the filled PDF inline. No error toast. | |
| 3 | Multi-signer fill-and-sign | `meetdossie.com/app` → open dossier with 2+ buyers configured → click E-sign / DossieSign on a TREC 20-18 → send to signers | DocuSeal submission created without error. Both signer rows show "Pending" status (not error/failed). Field prefill shows both buyer names in the document preview. | |
| 4 | Attach button shows full file picker (mobile) | `meetdossie.com/app` on a phone (Atlas: simulate iPhone Safari + Android Chrome user agents) → open Talk-to-Dossie chat → tap paperclip/attach icon | Native file picker opens with options for Photo Library / Files / Camera (NOT camera-only). Capture screenshot of file picker dialog. | |
| 5 | Z Fold Customer Activity panel | `meetdossie.com/app` on simulated 717x768 viewport (Z Fold cover screen) → load Today/dashboard view | Customer Activity panel + To-Do panel both load with real data. Neither shows "Offline" badge. Capture screenshot. | |
| 6 | Founding page emoji icons | `meetdossie.com/founding` on (a) desktop Chrome, (b) iPhone Safari simulation, (c) Android Chrome simulation | All 8 feature card icons render as proper emoji (not hamburger lines / boxes / question marks). All 3 Texas badge icons render properly. Capture one screenshot per platform (3 total). | |

**Risk flags Atlas should hit hardest:**
- Items 1, 2, 3 all touch the TREC 20-18 / fill-form / DocuSeal stack which had 5+ overnight loop iterations 2026-06-27/28 (commits `0d9afca`, `5ed5e58`, `3841222`, `e07d135`, `61718a6`, `ea192b2`). If APV fails on any of these, REMOVE from email — do not delay send.
- Item 4 fix is `9d1047f` (removed `capture="environment"` from attach input). Verify on actual UA strings, not just desktop devtools.
- Item 5 panels fix is `051905d` + `98ef2a0` (SW cache v7→v8 + defensive panel renders). Atlas should hard-refresh or open in incognito to ensure no stale SW cache.

**Fallback bullet list** (if any of 1-3 fails APV and gets pulled): keep 4, 5, 6 plus drop these from the WEEKLY-IMPROVEMENTS backlog as replacements (only if needed):
- "Faster voice responses in Talk-to-Dossie" — verify by timing a question-to-answer round trip.
- "Larger orb and clearer agent status display" — verify orb size + status colors visible.

---

## Send mechanics

- Pre-flight check: confirm `subscriptions.status='active'` count matches the 13-founder roster in CLAUDE.md Section 6 / `docs/CUSTOMERS.md`.
- Send at Friday July 3, 8:30 AM CST (13:30 UTC) via `api/cron-thursday-blast.js` — Atlas/Cole reroute the cron payload to use this draft's HTML and subject before send.
- BCC: none (per `feedback_customer_emails_minimize_problem` — operational emails stay clean).
- Reply-to: `heath@meetdossie.com`.

---

## Customer-issue check

No open founder-reported bug in memory that's affected by what we promote here. Brittney/Miki issues from earlier marathon sessions are resolved. If a fresh customer email lands Thu/Fri morning that contradicts any bullet, pull that bullet.
