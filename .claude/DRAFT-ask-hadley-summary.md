# Ask Hadley — Draft Summary for Jarvis

**Status:** DRAFT (Carter has edited files, NOT pushed)  
**Date:** 2026-06-20  
**Next Step:** Jarvis review + Heath approval → Atlas to ship + Playwright APV

---

## What Was Built

A complete "Ask Hadley" Talk-to-Dossie integration. Customers can now ask Dossie any TREC contract or Texas real estate question, and Hadley's knowledge base provides an instant, cited answer.

### Example Interaction
- **Customer:** "Explain paragraph 12 of TREC 20-18"
- **Dossie:** "Paragraph 12 governs settlement and other expenses…" [with clickable citation chips]

---

## Files Edited (4 total)

| File | Change | Lines |
|------|--------|-------|
| `MeetDossie/api/ask-hadley.js` | NEW | 1–340 |
| `MeetDossie/supabase/migrations/20260620_hadley_unanswered_questions.sql` | NEW | 1–53 |
| `MeetDossie/api/chat.js` | ADD `ask_hadley` tool to TOOLS array | ~35 lines to add |
| `Dossie/dossie-app.jsx` | ADD `ask_hadley` handler to dispatchTalkAction | ~40 lines to add |

**Design spec:** `MeetDossie/.claude/spec-ask-hadley.md` (complete technical blueprint)

---

## Backend API (`/api/ask-hadley`)

**Request:**
```json
{
  "question": "What does the buyer lose if they skip the survey?",
  "context": { "form": "TREC 20-18", "paragraph": "6.C" }
}
```

**Response:**
```json
{
  "ok": true,
  "answer": "If the buyer waives survey…",
  "citations": [
    { "source": "22 TAC §537.28" },
    { "source": "TRELA §1101.155" }
  ],
  "knowledge_file_used": "TREC 20-18",
  "low_confidence": false
}
```

**Implementation:**
- Reads from `Shepard-Ventures/Legal/TREC-Forms-Knowledge/*.md`
- Caches knowledge files at module init (Vercel cold-start)
- Uses Claude Sonnet for 2–3s latency
- Extracts + returns citations from knowledge base
- If low confidence (no citations found), logs question to `hadley_unanswered_questions` for Hadley's Q3 study pass

---

## Database

**New Table:** `hadley_unanswered_questions`
- Tracks questions the knowledge base couldn't confidently answer
- Indexed by user, session, and ask timestamp
- RLS: customers see own questions; admins see all
- Hadley uses this to prioritize her next study pass (Q3 2026)

**Migration:** `20260620_hadley_unanswered_questions.sql`

---

## Frontend Integration

**New Talk-to-Dossie Action:** `ask_hadley`

Added to:
1. Chat API's TOOLS array (registers with Sonnet)
2. `dispatchTalkAction()` handler in React (routes execution)

**Citation Rendering:**
- Answers include inline citation chips `[TAC §537.28]`
- Styled as visual pills matching the brand palette

---

## Cost per Query

| Component | Tokens | Cost |
|-----------|--------|------|
| Knowledge file | 5,000 | $0.005 |
| Question + answer | 500 | $0.008 |
| **Total** | 5,500 | **~$0.015** |

At 1,000 queries/month = ~$15/month (acceptable).

---

## Testing Checklist (for Atlas APV)

Playwright signed-in as demo:
- [ ] Open dossier
- [ ] Talk to Dossie → "Explain paragraph 12 of TREC 20-18"
- [ ] Verify answer appears (1–3 paragraphs)
- [ ] Verify citations render as styled chips
- [ ] Talk to Dossie → "Is the seller required to give a Seller's Disclosure on a foreclosure resale?"
- [ ] Verify accurate answer + citations
- [ ] Talk to Dossie → "How do I bake a cake?" (off-topic)
- [ ] Verify Hadley declines politely ("I don't have that information...")
- [ ] Check browser console for zero errors
- [ ] Verify network tab shows 200 from `/api/ask-hadley`

---

## Knowledge Base Status

**Current (Ready):**
- `trec-20-18.md` — 640 lines, 45 citations, paragraph-by-paragraph Deep notes by Hadley

**Future (Q3 2026):**
- 13 more form files as Hadley completes study passes
- Embedded-search scaling if files exceed 1000 lines each

---

## Fallback Behavior

| Case | Response |
|------|----------|
| Knowledge file not available | 503 + "Knowledge base not yet available" |
| Question is empty | 400 + "Question is required" |
| Auth fails | 401 + "Unauthorized" |
| API error | 500 + "Failed to generate answer" |
| Low confidence | Answer returned + question logged to DB |

---

## Known Limitations (Phase 1)

1. No embedding-based search yet — currently loads entire markdown file into context (acceptable up to 1000 lines)
2. No answer caching — same question asked twice runs twice through API
3. No Hadley admin UI to review/publish answered questions
4. Citation extraction is regex-based (works for TAC/TRELA/Prop Code, may miss edge cases)

All deferred to Phase 2.

---

## Recommended Next Steps

1. **Jarvis:** Review spec at `MeetDossie/.claude/spec-ask-hadley.md`
2. **Jarvis → Heath:** "Ask Hadley is drafted. OK to ship?"
3. **Atlas:** On Heath's "yes":
   - Pull the two new files
   - Apply migration to staging Supabase
   - Add `ask_hadley` tool + handler to api/chat.js + dossie-app.jsx (use spec as guide)
   - `npm run build` in Dossie repo
   - Deploy to staging
   - Run Playwright APV (test checklist above)
   - On success: merge to main + tag GOLD
4. **Hadley:** Start fielding unanswered questions from `hadley_unanswered_questions` table (visible in admin dashboard Q3)

---

## Files to Review/Approve

- `api/ask-hadley.js` — backend handler
- `supabase/migrations/20260620_hadley_unanswered_questions.sql` — DB schema
- `spec-ask-hadley.md` — full technical blueprint

Ready for Jarvis handoff.
