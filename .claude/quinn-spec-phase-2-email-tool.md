# Quinn -> Carter: Phase 2 Email-Tool Architecture Spec

**Status:** Research & Design (NO IMPLEMENTATION)
**Scope:** Complete inbox-reading system architecture for Phase 2 (weeks 3-4 of 10-week plan)
**Deliverable:** Specification for agent email classification + auto-respond/draft capabilities

---

## 1. Architecture Options for Inbox Reading

### Option A: Gmail API with OAuth

**How it works:**
- Agent connects Dossie via OAuth (Gmail consent screen)
- Dossie stores encrypted refresh token in `user_email_credentials` table
- Endpoint `/api/email-sync` polls Gmail API (`gmail.users.messages.list`) every 5 min or on-demand
- Fetch new messages, classify, store in `email_messages` table

**Pros:**
- Native Gmail support (most TX agents)
- Full message body + attachments available
- Read/unread status, labels, threading all available
- Gmail-native folders + categories reduce noise
- Low latency (API calls complete in <1s)

**Cons:**
- OAuth flow adds UX complexity (landing page → Google consent → redirect)
- Requires Gmail Workspace verification for production (takes 7-14 days)
- Rate limit: 10 requests/sec per user → ~600 msgs/min max (fine for typical agents)
- Must handle token refresh + expiration edge cases
- New dependency on Google OAuth infrastructure

**Cost:** Free (Gmail API is unlimited for personal accounts)

---

### Option B: IMAP Polling

**How it works:**
- Agent provides email + password (or app-specific password)
- Dossie stores encrypted credentials in `user_email_credentials`
- Endpoint pulls from IMAP inbox periodically (UID-based, not full sync)
- Parse RFC 5322 email headers + body, classify, store in `email_messages`

**Pros:**
- Works with ANY email provider (Gmail, Outlook, Yahoo, corporate email, etc.)
- No OAuth consent screen needed
- Agents already know their password
- No external API rate limits
- Can be self-hosted if needed

**Cons:**
- IMAP is slow (~500ms per connection setup)
- UID tracking required to avoid re-fetching (complex state management)
- Email parsing is error-prone (malformed headers, encoding issues, weird clients)
- Password storage requires best-in-class encryption (HSM or Supabase Vault)
- Fewer metadata signals (no read status on all clients)

**Cost:** Free (IMAP is open standard)

---

### Option C: Email Forwarding to Dossie Inbox

**How it works:**
- Agent creates an email filter in Gmail/Outlook: "Forward TC-related emails to dossie-inbox@supabase.io" (catch-all inbox)
- Dossie receives emails via webhook (Vercel + inbound email API like SendGrid Inbound Parse)
- Parse received email, classify, store in `email_messages`, notify agent

**Pros:**
- Dead simple to set up (agent sets one filter rule)
- No OAuth, no credentials stored
- Works for any email provider that supports forwarding
- Webhook is synchronous → instant classification
- No polling overhead

**Cons:**
- Agent must set up forwarding filter manually (friction)
- Only catches emails matching filter rules (easy to miss edge cases)
- Forwarded headers are messy (extra "X-Forwarded" spam)
- Single inbox endpoint is a bottleneck (all agents' emails in one bucket)
- Dossie inbox address becomes a target for spam
- Hard to link forwarded email back to agent without manual metadata

**Cost:** ~$1-2/mo SendGrid Inbound Parse quota

---

### Option D: Microsoft Graph API (Outlook)

**How it works:**
- Agent connects via OAuth to Microsoft (Outlook/Office 365)
- Dossie calls `GET /me/messages` with delta queries (incremental sync)
- Store in `email_messages`, classify, act

**Pros:**
- Delta queries are more efficient than Gmail (only fetches changed messages)
- Works with Office 365 enterprise accounts (corporate agents)
- Richer metadata than Gmail (importance flags, categories, etc.)

**Cons:**
- Only works for Outlook/Office 365 (excludes Gmail agents)
- Graph API is more complex than Gmail API
- Requires Enterprise consent + admin approval for enterprise tenants
- Texas REALTOR market skews Gmail, not Outlook

**Cost:** Free (Graph API is unlimited)

---

## RECOMMENDATION: Start with Option A (Gmail API)

**Rationale:**
1. **Texas market fit:** Vast majority of REALTOR agents use Gmail (personal or Google Workspace)
2. **Lowest complexity:** OAuth is standard, Google DevEx is polished
3. **Performance:** Sub-second latency on API calls, polling every 5 min = 288 syncs/day
4. **Scalability:** Rate limits not a concern for typical single-agent usage
5. **Signal quality:** Full message context + Gmail labels/categories = better classification
6. **Phase 2 scope:** Start with Gmail, Option B (IMAP) as Phase 3 expansion for Outlook/corporate users

**Fallback:** Keep Option B researched for Phase 3 when agents demand Outlook support.

---

## 2. Email Classification Logic

### What Makes an Email "TC-Relevant"?

**Core TC Email Categories (to classify):**

1. **Lender Question** — Title/escrow asking about appraisal status, underwriting, clear-to-close
   - Patterns: "appraisal", "underwriting", "funding", "clear-to-close", "conditions", "title search"
   - Sender: loan officer, title officer, underwriter

2. **Title Company Update** — Order status, document requests, closing disclosure
   - Patterns: "closing disclosure", "title search", "title order", "document review", "survey needed"
   - Sender: title officer

3. **Escrow Agent Communication** — Wire instructions, closing checklist, HOA docs
   - Patterns: "wire instructions", "closing checklist", "earnest money", "hold", "escrow", "HOA documents"
   - Sender: escrow officer

4. **Buyer/Seller Request** — Agent-facing requests (not direct buyer/seller email)
   - Patterns: within CC'd agent group, "please advise", "questions about", "timeline"
   - Sender: other agent

5. **Agent-to-Agent Communication** — Negotiation, issue resolution, coordination
   - Patterns: "counter", "inspection", "appraisal issue", "extension", "concern"
   - Sender: other agent, agent email domain

6. **Deadline/Action Item Reminder** — Dates, deadlines, options period, appraisal
   - Patterns: "due", "deadline", "by [date]", "option expires", "appraisal due"
   - Any body

7. **Irrelevant** — Marketing, personal, admin, newsletter, spam, FYI, "just checking in"
   - Patterns: "sale", "newsletter", "discount", "unsubscribe", low context
   - Sender: no organizational connection

### Classification Approach

**Option A: Rule-Based First, Claude Fallback**

```
if (sender_email in [lender_officer, title_officer, underwriter, escrow_agent]) → CLASSIFY HIGH_CONFIDENCE
else if (body contains [deadline keywords]) → CLASSIFY DEADLINE (high confidence)
else if (body + subject contain [multiple TC patterns]) → CLASSIFY (med confidence)
else → DEFER TO CLAUDE for NLP classification
```

**Option B: Claude Haiku All-In**

Every email → POST /api/classify-email with subject + body snippet → Claude Haiku extracts category + confidence + action

### Cost Analysis (Haiku Classification)

- Typical agent: ~30 emails/day
- ~70% are spam/marketing (skip classification, filter first)
- ~10 emails/day need Haiku
- Haiku cost: ~0.3¢ per email (input ~200 tokens + output ~50 tokens = ~250 tokens @ $0.80 / 1M)
- **Monthly cost per agent: ~$0.09** (negligible)
- Batch classification: run at night for all agents = ~$0.09 * 50,000 agents = $4,500/mo at scale

**Conclusion:** Haiku cost is acceptable even at scale. Use hybrid: Gmail sender-based rule pre-filter (80% confidence), Haiku for boundary cases (20%).

---

## 3. Per-Deal Context: Linking Email to Transaction

### The Problem
Agent gets 100 emails in their TC folder. We classify one as "lender question" but don't know which deal it's about.

Email subject: "Appraisal update on Main St"
Agent has 3 deals: "123 Main St" (buyer), "456 Main St" (listing), "789 Elm St"

### Solution: Transaction Linking

**Option A: Email Content NLP**
- Extract property address from email body/subject
- Fuzzy-match against agent's transactions → `link_confidence` score
- Fallback: let agent assign manually in UI

**Option B: Gmail Label System**
- Agent applies Gmail label: "TR-[transaction_id]" manually to thread
- Dossie reads the label on sync
- API extracts transaction_id from label

**Option C: Agent Heuristic**
- If email TO/FROM includes buyer name, lender name, title company name → match against transaction fields
- Build a lookup table: `{ transaction_id → [buyer_name, seller_name, title_company, lender_name] }`
- Match extracted values from email headers → transaction

**Recommendation: Option C + fallback to manual assignment**
- Use heuristic NLP for obvious cases (90% coverage)
- Surface in UI: "This looks like it's about 123 Main St — is that right?" → agent clicks yes/no
- Store link in `email_message_transactions` join table (many-to-many, since one email can reference multiple deals)

**Cost:** One Haiku call per email for extraction + matching (bundled in classification call above)

---

## 4. Action Options: What Should Dossie Do Once Classified?

### Per-Category Actions

| Email Type | Auto-Respond | Draft Response | Action Item | Notify Now |
|---|---|---|---|---|
| Lender Question | ❌ No | ✅ Draft + queue | ✅ (urgent) | ✅ (urgent) |
| Title Update | ❌ No | ✅ Draft confirm | ✅ (normal) | ❌ (batch) |
| Escrow Update | ✅ "Received" | ❌ | ❌ | ❌ (batch) |
| Buyer/Seller Request | ❌ No | ✅ Draft reply | ✅ (urgent) | ✅ (urgent) |
| Agent-to-Agent | ✅ "Got it" | ❌ | ✅ (normal) | ✅ (urgent) |
| Deadline Reminder | ❌ No | ❌ | ✅ (urgent) | ✅ (urgent) |
| Irrelevant | ❌ No | ❌ | ❌ | ❌ |

### Auto-Respond Guardrails (Phase 2, Carefully)

**DO NOT auto-respond to:**
- Emails with questions (requires human answer)
- Emails from new senders (could be scam)
- Emails with attachments (need human review)
- Emails outside known patterns (fallback to human)

**SAFE to auto-respond to:**
- Acknowledgment-only (title company: "Document received — will review by [date]")
- Status update without action (lender: "Appraisal ordered, expect results by [date]")
- Deadline notification ACK (escrow: "Got your closing checklist, will have docs signed by [date]")

**Response template:**
```
Hi [Recipient Name],

Thanks for the update on [property address]. I've received your [doc type] and will [next action] by [date].

[Agent Name]
[Agent Phone]
[Agent Email]
```

---

## 5. Data Model Additions Needed

### New Tables

```sql
CREATE TABLE user_email_credentials (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  provider TEXT NOT NULL, -- 'gmail', 'outlook', 'imap'
  encrypted_refresh_token TEXT,
  encrypted_auth_data TEXT,
  sync_state JSONB, -- { "lastSyncAt": "ISO", "lastUIDFetched": 12345 }
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

CREATE TABLE email_messages (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  transaction_id UUID REFERENCES transactions(id),
  provider_id TEXT, -- 'gmail:MSG_123' or 'outlook:AAMkADQ...'
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  received_at TIMESTAMP NOT NULL,
  gmail_labels TEXT[], -- ['INBOX', 'UNREAD', custom labels]
  is_read BOOLEAN DEFAULT FALSE,
  is_important BOOLEAN DEFAULT FALSE,
  parent_thread_id TEXT,
  created_at TIMESTAMP,
  UNIQUE(user_id, provider_id)
);

CREATE TABLE email_classifications (
  id UUID PRIMARY KEY,
  email_id UUID NOT NULL REFERENCES email_messages(id),
  category TEXT NOT NULL, -- 'lender_question', 'title_update', etc.
  confidence NUMERIC(3,2), -- 0.95 = 95% confident
  extracted_fields JSONB, -- { "property_address": "123 Main", "deadline": "2026-06-30" }
  classification_method TEXT, -- 'rule_based', 'haiku'
  created_at TIMESTAMP
);

CREATE TABLE email_actions (
  id UUID PRIMARY KEY,
  email_id UUID NOT NULL REFERENCES email_messages(id),
  action_type TEXT NOT NULL, -- 'draft_response', 'create_action_item', 'auto_respond', 'notify'
  action_data JSONB, -- { "draft_body": "...", "urgency": "urgent" }
  status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'executed', 'skipped'
  created_at TIMESTAMP,
  executed_at TIMESTAMP
);

CREATE TABLE email_message_transactions (
  id UUID PRIMARY KEY,
  email_id UUID NOT NULL REFERENCES email_messages(id),
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  link_confidence NUMERIC(3,2),
  link_method TEXT, -- 'heuristic', 'manual', 'label'
  created_at TIMESTAMP,
  UNIQUE(email_id, transaction_id)
);
```

### Updated profiles Table

```sql
ALTER TABLE profiles ADD COLUMN (
  email_sync_enabled BOOLEAN DEFAULT FALSE,
  email_sync_provider TEXT, -- 'gmail', 'outlook'
  email_notify_urgency TEXT DEFAULT 'normal', -- 'urgent' | 'normal' | 'digest'
  email_auto_respond_enabled BOOLEAN DEFAULT FALSE
);
```

---

## 6. Privacy & Security Implications

### Encryption at Rest

- `user_email_credentials.encrypted_refresh_token` stored in Supabase using **Supabase Vault** (envelope encryption)
- Each agent's credential encrypted with their own key material (derived from Supabase JWT)
- In-transit: HTTPS + Supabase RLS policies (agent can only read their own credentials)

### Agent Revocation

- Agent navigates Settings → Email Sync → Disconnect
- DELETE from `user_email_credentials` + call Gmail API to revoke refresh token
- Stops all polling immediately
- Email history in `email_messages` + `email_classifications` stays (for future reference)

### Data Retention

- `email_messages` kept for 90 days (GDPR compliance)
- After 90 days, delete body text but keep metadata (classification, transaction link)
- Agent can manually delete specific threads anytime

### Audit Trail

- All auto-responses logged with timestamp + recipient + body in `email_actions` table
- Agent can review what Dossie sent on their behalf
- Can revoke/recall if needed (mark as error, notify recipient later)

---

## 7. Cost Estimate Per Active Agent Per Month

| Component | Volume | Unit Cost | Monthly |
|---|---|---|---|
| Gmail API calls | 1,440 syncs (5min poll) | $0 | $0 |
| Haiku classification | 10 emails × 25¢ | $0.0025 | ~$0.02 |
| Supabase Storage (credentials) | ~1KB encrypted | $0.024/TB | ~$0.00002 |
| Supabase Storage (email messages) | 900 msgs/mo × 5KB | $0.024/TB | ~$0.11 |
| Resend (auto-respond emails) | ~5/day × ~0.5¢ | $0.005 | ~$0.07 |
| **Total** | | | **~$0.20/agent/mo** |

**Scale economics:** At 1,000 agents, total cost = $200/mo (negligible vs $29 subscription price).

---

## 8. MVP Scope: What Ships in Week 1 of Phase 2?

**Week 1 deliverables (3-4 days Carter + 1 day Quinn):**

### Frontend
- ✅ Settings → Email Sync section
- ✅ "Connect Gmail" button → OAuth flow → token storage
- ✅ Dashboard: "Email Inbox" tab (read-only view of last 30 classified emails)
- ✅ Email detail card: shows category, extracted fields, linked transaction (if matched)

### Backend
- ✅ `/api/gmail-oauth-callback` — exchange code for refresh token, store encrypted
- ✅ `/api/email-sync` — poll Gmail, classify, store (runs every 5 min or on-demand)
- ✅ `/api/email-classify` — Haiku classification endpoint (called from sync)
- ✅ `/api/emails` — GET list of classified emails for dashboard
- ✅ Cron: `cron-email-sync.js` (runs every 5 min per active user with email_sync_enabled=true)

### NOT in Week 1
- ❌ Auto-responding (defer to Week 2)
- ❌ Draft responses (defer to Week 2)
- ❌ IMAP support (defer to Phase 3)
- ❌ Microsoft Graph / Outlook (defer to Phase 3)
- ❌ Email forwarding (too risky; skip entirely)

---

## 9. Risks & Unknowns

### Technical Risks

1. **Gmail API Quota/Rate Limiting**
   - Current: 10 requests/second per user
   - If agent has 10k emails, first sync takes 1000 seconds (16 min)
   - Mitigation: Implement cursor-based pagination + incremental sync (only new emails)

2. **Token Refresh Failures**
   - Refresh token expires if unused for 6 months
   - Agent's internet connection drops during OAuth
   - Mitigation: Graceful error handling, notify agent via Telegram/email, redirect to reconnect

3. **Email Classification Bias**
   - Haiku might misclassify non-English emails (agent uses Spanish for some)
   - Classified as "irrelevant" when it's actually urgent
   - Mitigation: Manual override in UI, feedback loop to retrain

4. **Transaction Linking Failures**
   - Heuristic fails for multi-property emails ("Updates on all your listings")
   - Links wrong email to wrong deal
   - Mitigation: Show confidence score, let agent click to correct, retrain

### Business Risks

1. **Privacy Concerns**
   - Agent worried Dossie is reading all their personal emails (we're not, only filtering TC-related)
   - Solution: Clear privacy policy, in-app explainer, no email body storage for irrelevant emails

2. **Reduced Agent Autonomy**
   - Agent feels auto-responding erodes their control
   - Solution: Require approval before any auto-respond; default = draft only

3. **Adoption Friction**
   - OAuth setup is friction; agent forgets to connect
   - Solution: Onboarding wizard, prominent Settings link, in-app prompt after first 100 messages

---

## 10. Decision Points for Carter

**Before starting implementation, Carter needs Heath's input on:**

1. **Revenue Model for Phase 2:**
   - Include email sync in base $79 plan?
   - Charge separately as add-on ($10/mo)?
   - Current plan: "Include in base" (email = core TC feature)

2. **Auto-Respond Approval Gate:**
   - Require agent to manually approve each auto-response before sending?
   - Or approve response template + auto-send all matches?
   - Current plan: "Require per-response approval in Week 2"

3. **IMAP Support Timeline:**
   - Skip IMAP entirely (Gmail-only MVP)?
   - Plan IMAP for Phase 3 (week 7-8)?
   - Current plan: "Phase 3, start design in Phase 2"

4. **Email History Retention:**
   - Keep email bodies forever (expensive at scale)?
   - 90-day retention (GDPR compliant)?
   - 30-day retention (cheapest)?
   - Current plan: "90-day retention with option to delete manually"

---

## Summary

**Phase 2 email-tool architecture is Gmail API + Haiku classification + draft responses (auto-respond deferred to Week 2).** This is the highest-leverage, lowest-complexity design for Texas agents. Cost is negligible ($0.20/agent/mo). Privacy controls are built in. MVP ships in ~4 days and unlocks the "email-aware agent" narrative for Week 5-6 content.

Cost to ship: 1 Carter, 1 Quinn, 1 Vercel deploy slot. Confidence: High. Risk: Medium (OAuth UX friction).

Ready for implementation once Health approves the decision points above.
