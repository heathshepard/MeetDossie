# Dossie Video Library — Project Brief

## 1. Video List

| # | Title | Feature Covered | Length | Priority |
|---|-------|-----------------|--------|----------|
| 1 | Welcome to Dossie | Platform overview, account setup, onboarding orientation | 3–4 min | P1 |
| 2 | Creating Your First Dossier | New transaction file creation, fields, saving | 90 sec | P1 |
| 3 | Uploading Documents & Contract Scanning | Document upload, compliance report, auto-fill dates | 90 sec | P1 |
| 4 | TREC Deadline Tracking | Auto-calculated deadlines, natural language display, deadline badges | 90 sec | P1 |
| 5 | Your Morning Brief | Daily audio + text deal summary, how to access and use | 60 sec | P1 |
| 6 | Talk to Dossie | Voice/text input → form fill, deadline questions | 90 sec | P1 |
| 7 | DossieSign: Fill Contracts by Talking | Voice-driven TREC form fill, review flow | 90 sec | P1 |
| 8 | DossieSign: Routing for E-Signature | Buyer 1 → Buyer 2 → Agent routing, executed PDF delivery | 90 sec | P1 |
| 9 | Your Pipeline Dashboard | Deal cards, status, deadline badges, deal navigation | 60 sec | P2 |
| 10 | Drafting Emails from Dossier Context | Email drafting feature, auto-context pull | 60 sec | P2 |
| 11 | Action Items & Checklists | Per-deal checklist, adding and completing action items | 60 sec | P2 |
| 12 | Form Library | Browsing + attaching TREC forms to a dossier | 60 sec | P2 |
| 13 | Form Packages | One-click Buyer or Seller Transaction bundle | 60 sec | P2 |
| 14 | Settings: Profile & Notifications | Profile setup, notification preferences | 60 sec | P3 |
| 15 | Dossie for Buyer Transactions — Full Walkthrough | End-to-end buyer deal from dossier creation to executed contract | 3–4 min | P2 |
| 16 | Dossie for Seller Transactions — Full Walkthrough | End-to-end seller deal walkthrough | 3–4 min | P3 |

**Notes:**
- Videos 1, 15, and 16 are composite long-form videos assembled from shorter clips plus additional narration.
- Videos 7 and 8 are split from DossieSign into two parts because the two halves serve different user questions.
- P1 videos are blocking for launch — must be live before onboarding emails or /help page deploys.

---

## 2. Production Pipeline

### Stage Overview

```
Script → Screen Record → Voiceover → Assembly → Captions → Approval → Delivery
```

### Step-by-Step

| Step | What Happens | Who | Manual or Automated |
|------|-------------|-----|-------------------|
| 1. Script brief | Cole drafts script using template. Heath approves. | Cole + Heath | Manual |
| 2. Screen recording | Heath records demo@meetdossie.com walkthrough (no audio). 1920x1080, 60fps. | Heath | Manual |
| 3. Voiceover generation | ElevenLabs API → Luna voice (lxYfHSkYm1EzQzGhdbfc) → .mp3 | Cole / Carter pipeline | Automated |
| 4. Video assembly | ffmpeg: screen recording + voiceover .mp3 → intro/outro cards → 16:9 .mp4 | Carter (assemble.js) | Automated |
| 5. Captions | Upload to Submagic. Review. Export burned-in. | Cole | Manual |
| 6. Final approval | Heath watches captioned version. One revision round. | Heath | Manual |
| 7. Upload to Supabase Storage | Approved .mp4 → dossie-videos bucket → public URL | Carter | Automated |
| 8. Delivery | URL added to /help page, in-app empty states, welcome email | Carter | Automated |

### File Naming Convention

```
[##]-[slug]-[version].mp4
Example: 02-creating-first-dossier-v1.mp4
```

### Storage Structure

```
Media/
  raw-recordings/        <- Heath's .mp4 screen recordings (no audio)
  scripts/               <- Approved .txt or .md scripts
  voiceover/             <- ElevenLabs .mp3 outputs
  assembled/             <- Post-assembly, pre-caption .mp4
  finished-videos/       <- Final approved .mp4 with captions
  social-cuts/           <- Sage's 9:16 derivatives for social

Supabase Storage bucket: dossie-videos/
  help/                  <- Public URLs for /help page
  email/                 <- Welcome video thumbnail
  app/                   <- In-app links
```

---

## 3. Technical Build List (Carter)

### 3a. Video Assembly Pipeline

**Invocation:**
```bash
node assemble.js \
  --recording "Media/raw-recordings/02-creating-first-dossier.mp4" \
  --audio "Media/voiceover/02-creating-first-dossier.mp3" \
  --title "Creating Your First Dossier" \
  --output "Media/assembled/02-creating-first-dossier-v1.mp4"
```

**Components:**
- Intro card: 2-second Dossie branded intro (logo on dark/blush background)
- Outro card: 2-second outro with "meetdossie.com" CTA
- Lower third: optional title overlay for first 3 seconds
- Batch mode: manifest .json for processing multiple videos
- Tooling: ffmpeg CLI or Node.js ffmpeg wrapper

### 3b. /help Page at meetdossie.com/help

**Requirements:**
- Videos grouped by category: Getting Started, Core Features, DossieSign, Settings
- Each card: title, thumbnail, runtime badge, play button
- Inline player (modal). No YouTube — host from Supabase Storage.
- Client-side text filter on titles
- Each video has anchor URL for deep linking from in-app (/help#creating-first-dossier)
- Public — no auth required

**Supabase table:**
```sql
CREATE TABLE help_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  duration_seconds INT,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  priority INT DEFAULT 2,
  published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3c. Welcome Email Integration (Resend)

- Trigger: new user signup
- Template: greeting + welcome copy + video thumbnail image linked to /help
- Video embed strategy: static thumbnail → links to /help#welcome-to-dossie (email clients don't play video natively)
- Animated GIF of first 3 seconds as fallback
- Sender: noreply@meetdossie.com via Resend

### 3d. In-App Empty State Links

| Empty State | Video | Link Text |
|-------------|-------|-----------|
| Pipeline (no deals) | #2: Creating Your First Dossier | "Watch: Create your first dossier →" |
| Documents tab (empty) | #3: Document Upload & Scanning | "Watch: How to upload documents →" |
| Deadlines tab (empty) | #4: TREC Deadline Tracking | "Watch: How deadlines work →" |
| Forms tab (empty) | #12: Form Library | "Watch: Browse the form library →" |
| Action Items (empty) | #11: Action Items & Checklists | "Watch: Using checklists →" |

**Implementation:** `<HelpVideoLink videoSlug="...">` React component → links to /help#[slug]

---

## 4. Script Template

```
[HOOK — 1-2 sentences. Name the problem or moment the user is in.]
[CONTEXT — 1 sentence. Where we are in the app, what we're about to do.]
[DEMO NARRATION — Walk through exactly what's on screen, present tense, active voice.]
  -> Describe each click/action as it happens.
  -> Name UI elements exactly as they appear in the product.
  -> Highlight the "Dossie does this for you" moments.
[OUTCOME — 1-2 sentences. What the user has now. What they can do next.]
[CTA — 1 sentence. Where to go next or what to explore.]
```

### Style Rules

- Voice: warm, confident, peer-level. Luna is a capable colleague, not a tutorial bot.
- Tense: present tense ("You click Save" not "You will click Save").
- Avoid: "Simply," "Just," "Easy," "Now you can see."
- Name the benefit, not the action: not "the system calculates the date" — "Dossie calculates the Option Period deadline for you."
- Pacing: write for 130-140 wpm. 90-second video = ~195-210 words.
- End every video with a soft nudge to the next logical action in the workflow.

### Example Script: "Creating Your First Dossier" (Video #2)
**Target: 90 seconds | ~200 words**

Every deal starts with a dossier — your transaction file inside Dossie. Here's how to create one in under a minute.

From your Pipeline dashboard, click "New Dossier" in the top right. You'll see a clean form: property address, client names, representation type — buyer or seller — and the key transaction dates.

Fill in the property address. Dossie uses this to anchor everything that follows — deadlines, documents, and your Morning Brief updates will all reference this deal by address.

Add your client's name, select whether you're representing the buyer or seller, and set your contract execution date. That single date is what Dossie uses to auto-calculate every TREC deadline in your transaction.

Hit Save, and your dossier is live in the pipeline. You'll see it appear as a deal card immediately, with a status badge and your first set of deadlines already populated.

From here, you can upload your contract, set action items, or let Dossie walk you through the rest by talking through it. Your deal is now tracked — nothing falls through the cracks.

Next up: uploading your contract and letting Dossie scan it automatically.

*Word count: 198 | Estimated runtime: 88 seconds at 135 wpm*

---

## 5. Week 1 Action Items

### Heath (Records + Reviews)

| Day | Task |
|-----|------|
| Mon | Review and approve this project brief |
| Mon | Confirm demo@meetdossie.com account has clean state for recording |
| Tue | Record Video #1 (Welcome to Dossie) — 3-4 min raw recording, no audio |
| Wed | Record Video #2 (Creating Your First Dossier) — 90-second walkthrough |
| Wed | Record Video #3 (Document Upload & Contract Scanning) — 90-second walkthrough |
| Thu | Review and approve Cole's scripts for Videos #2 and #3 |
| Fri | Watch assembled cuts of Videos #2 and #3 for final approval |

### Cole (Scripts + Coordination)

| Day | Task |
|-----|------|
| Mon | Finalize scripts for Videos #2 and #3. Send to Heath for approval. |
| Mon | Submit approved scripts to ElevenLabs API (Luna voice). Download .mp3 files. |
| Tue | Draft script for Video #1 (Welcome) — longer, block 2 hours |
| Tue | Hand off screen recordings + voiceover .mp3 to Carter when ready |
| Wed | Upload assembled Videos #2 and #3 to Submagic. Review and export captions. |
| Thu | Draft scripts for Videos #4 (Deadlines), #5 (Morning Brief), #6 (Talk to Dossie) |
| Fri | Coordinate final approval loop with Heath |

### Carter (Builds)

| Day | Task |
|-----|------|
| Mon | Set up Media/ folder structure. Create Supabase Storage bucket dossie-videos. |
| Mon | Build assemble.js (ffmpeg). Test with placeholder files. |
| Tue | Create branded intro card + outro card assets. Wire into assembly script. |
| Wed | Receive assembled Videos #2 and #3. Upload to Supabase Storage. |
| Wed | Create help_videos table in Supabase. Seed with first 3 video records. |
| Thu | Build /help page at meetdossie.com/help — grid layout, category grouping, inline player. |
| Fri | Build Resend welcome email template with video thumbnail. Wire to signup trigger. Test. |

### Week 1 Exit Criteria

- [ ] Videos #2 and #3 approved, captioned, uploaded to Supabase Storage
- [ ] /help page live at meetdossie.com/help with at least 2 published videos
- [ ] Welcome email template wired to signup trigger (Video #1 thumbnail, even if video not finished)
- [ ] assemble.js proven end-to-end — Carter can hand off a "run this command" instruction
- [ ] Scripts for Videos #4-6 drafted and ready for Heath's approval in Week 2
