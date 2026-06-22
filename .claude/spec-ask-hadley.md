# Ask Hadley — Spec & Design Doc

**Date:** 2026-06-20  
**Author:** Carter (Product Engineering)  
**Status:** DRAFT (no code shipped)

---

## Summary

Add a new Talk-to-Dossie action (`ask_hadley`) that lets customers ask Hadley any TREC-contract or Texas-real-estate question and get an instant, cited answer drawn from Hadley's knowledge base.

---

## Customer Flow

1. Customer taps Talk to Dossie → enters question
2. Dossie sends to `/api/chat?mode=action`
3. Chat API routes to `/api/ask-hadley` (via `ask_hadley` tool)
4. Hadley answers using knowledge file (markdown) + Claude API
5. Answer + citations render in the Talk-to-Dossie panel with citation chips

---

## Architecture

### Backend: `/api/ask-hadley`

**Endpoint:** `POST /api/ask-hadley`

**Request:**
```json
{
  "question": "Explain paragraph 12 of TREC 20-18",
  "context": {
    "form": "TREC 20-18",
    "paragraph": "12.A.(1)(b)"
  }
}
```

**Response (200 OK):**
```json
{
  "ok": true,
  "answer": "Paragraph 12 governs settlement and other expenses. Section 12.A.(1)(b)...",
  "citations": [
    { "source": "22 TAC §537.28", "section": "537.28" },
    { "source": "TRELA §1101.155", "section": "1101.155" }
  ],
  "knowledge_file_used": "TREC 20-18",
  "low_confidence": false
}
```

**Response (503 Service Unavailable):**
```json
{
  "ok": false,
  "error": "Knowledge base for TREC 20-18 is not yet available."
}
```

**Auth:** Bearer token (Supabase JWT)

**Implementation Details:**
- Reads markdown files from `Shepard-Ventures/Legal/TREC-Forms-Knowledge/`
- Caches knowledge files at module init (Vercel cold-start optimization)
- Uses Claude Sonnet (not Opus) for ~2s latency + cost efficiency
- System prompt: "You are Hadley. Answer ONLY from knowledge base. Cite every claim."
- Extracts citations via regex pattern matching (TAC §, TRELA §, Tex. Prop. Code §)
- If `low_confidence === true` (no citations found), inserts question into `hadley_unanswered_questions` table for Hadley's Q3 study pass

**Cost Estimate:**
- Per-query tokens: ~5K (knowledge file) + ~500 (answer)
- Cost at Sonnet pricing (~$3/$15): ~$0.015/query
- 1000 queries/month = ~$15/month (acceptable)

---

### Database: `hadley_unanswered_questions` Table

**Schema:**
```sql
CREATE TABLE hadley_unanswered_questions (
  id UUID PRIMARY KEY,
  customer_user_id UUID,
  question_text TEXT,
  form_context TEXT,          -- "TREC 20-18 12.A.(1)(b)"
  asked_at TIMESTAMP,
  answered_at TIMESTAMP,      -- Filled by Hadley post-research
  hadley_answer TEXT,         -- Hadley's follow-up answer
  study_session_id UUID,      -- Links batch of answers
  created_at TIMESTAMP,
  updated_at TIMESTAMP
)
```

**RLS:**
- Customers see own questions only
- Admins see all
- Customers can insert their own questions
- Admins can update/answer questions

**Insertion Trigger:**
- `/api/ask-hadley` calls `insertUnansweredQuestion()` when `low_confidence === true`
- No blocking — happens async, logged on error

---

### Frontend: `dossie-app.jsx`

**Integration Point:** `dispatchTalkAction()` function (line ~3100)

**New Handler:**
```javascript
if (tool === "ask_hadley") {
  const question = String(params.question || "").trim();
  if (!question) {
    return await reportError("I need a question to ask Hadley.");
  }

  // Optionally capture context from the current dossier
  let context = null;
  if (currentOpenDeal && params.form) {
    context = {
      form: String(params.form),
      paragraph: params.paragraph ? String(params.paragraph) : null,
    };
  }

  const body = { question, context };
  const response = await fetch("/api/ask-hadley", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) {
    const msg = json?.error || "I couldn't reach Hadley. Try again.";
    return await reportError(msg);
  }

  const answer = json.answer || "";
  const citations = json.citations || [];

  // Format citations as chips
  let answerWithCitations = answer;
  if (citations.length > 0) {
    const citStr = citations
      .map((c) => `[${c.source}]`)
      .join(" ");
    answerWithCitations = `${answer}\n\nCitations: ${citStr}`;
  }

  return await reportInfo(answerWithCitations);
}
```

**Chat API System Prompt Addition:**
Add `ask_hadley` to the TOOLS array in `/api/chat.js`:
```javascript
{
  name: 'ask_hadley',
  description: 'Ask Hadley about TREC contracts, Texas real estate law, and closing procedures. Use when agent says: ask Hadley, what does TREC say about, explain paragraph, is the seller required to...',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The TREC/Texas real estate question' },
      form: {
        type: 'string',
        enum: ['TREC 20-18', 'TREC 20-17', 'TREC 40-11', 'TREC 36-11'],
        description: 'Optional: which form this question relates to',
      },
      paragraph: { type: 'string', description: 'Optional: paragraph reference like "12.A.(1)(b)"' },
    },
    required: ['question'],
  },
},
```

**Citation Rendering:**
Render citations as visual chips in the talkLog:
```javascript
// In talkLog rendering loop, detect citation strings and render as pills
const citationPattern = /\[([^\]]+)\]/g;
const withCitations = (text) => {
  const parts = [];
  let lastIdx = 0;
  let match;
  while ((match = citationPattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push({
        type: 'text',
        content: text.slice(lastIdx, match.index),
      });
    }
    parts.push({
      type: 'citation',
      content: match[1],
    });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push({
      type: 'text',
      content: text.slice(lastIdx),
    });
  }
  return parts;
};
```

---

## Phase 1 Scope

- Backend: `/api/ask-hadley` ✓
- Database: `hadley_unanswered_questions` table + RLS ✓
- Chat API tool registration + system prompt ✓
- Frontend: `ask_hadley` action handler + citation rendering ✓

---

## Phase 2 (Future)

- Embedding-based knowledge search (if files grow beyond 1000 lines)
- Answer caching (same question asked within 24h gets cached response)
- Citation URL linkouts (e.g., "TAC §537.28" → https://statutes.capitol.texas.gov/...)
- Hadley admin UI for reviewing & answering unanswered questions
- Auto-publish answered questions back to knowledge files

---

## Fallback & Error Cases

| Scenario | Behavior |
|----------|----------|
| Knowledge file not found | Return 503 + "Knowledge base not available" |
| Question is empty | Return 400 + "Question is required" |
| Auth fails | Return 401 + "Unauthorized" |
| Anthropic API error | Return 500 + "Failed to generate answer" |
| Low confidence (no citations) | Answer is returned + question logged to `hadley_unanswered_questions` |

---

## Testing Checklist (for Atlas APV)

- [ ] Sign in as demo
- [ ] Open a dossier (or just use Talk to Dossie without a dossier)
- [ ] Type: "Explain paragraph 12 of TREC 20-18"
- [ ] Verify answer appears + citations render as chips
- [ ] Type: "Is the seller required to give a Seller's Disclosure on a foreclosure resale?"
- [ ] Verify answer is accurate + citations present
- [ ] Type: "How do I bake a cake?" (off-topic)
- [ ] Verify Hadley declines gracefully
- [ ] Check console for no errors
- [ ] Verify question was logged (if low confidence)

---

## Files Changed/Created

- **Backend:** `C:\Users\Heath Shepard\Desktop\MeetDossie\api\ask-hadley.js` (NEW)
- **Database:** `C:\Users\Heath Shepard\Desktop\MeetDossie\supabase\migrations\20260620_hadley_unanswered_questions.sql` (NEW)
- **Frontend:** `C:\Users\Heath Shepard\Desktop\Dossie\dossie-app.jsx` (EDIT: add `ask_hadley` handler in `dispatchTalkAction`)
- **Chat API:** `C:\Users\Heath Shepard\Desktop\MeetDossie\api\chat.js` (EDIT: register `ask_hadley` tool in TOOLS array)

---

## Knowledge Base File Locations

- Source: `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Legal\TREC-Forms-Knowledge\<form>.md`
- Currently available: `trec-20-18.md` (640 lines, 45 citations, paragraph-by-paragraph)
- Future (Q3 2026): 13 more form files as Hadley completes study passes

---

## API Contract Example

**Request:**
```bash
curl -X POST https://meetdossie.com/api/ask-hadley \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What does the buyer lose if they skip the survey under the new 6.C rule?",
    "context": { "form": "TREC 20-18", "paragraph": "6.C" }
  }'
```

**Response:**
```json
{
  "ok": true,
  "answer": "If the buyer waives the survey (6.C option 2: 'Buyer may obtain new at Buyer's expense'), the buyer foregoes…",
  "citations": [
    { "source": "TREC 20-18", "section": "6.C" },
    { "source": "22 TAC §537.28", "section": "537.28" }
  ],
  "knowledge_file_used": "TREC 20-18",
  "low_confidence": false
}
```

---

## Success Criteria (for Heath's approval)

1. Customer asks "What's paragraph 12 of TREC 20-18?" → gets accurate, cited answer within 3s
2. Answer is styled naturally in the Talk-to-Dossie panel with visual citation chips
3. Unanswered questions are logged for Hadley's Q3 study pass
4. No customer PII is retained beyond user_id linking
5. Cost-per-query stays under $0.02
6. Zero console errors on staging APV
