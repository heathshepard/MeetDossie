# Shepard Studio - Quick Setup Guide

## Status: ✅ Phase 1 Complete - Ready for Database Setup

All code has been deployed to **staging**. Follow these steps to complete the setup.

---

## Step 1: Initialize Database Tables

### Option A: Via Supabase Dashboard (Recommended)

1. Go to: https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/editor
2. Click **SQL Editor** in left sidebar
3. Click **New query**
4. Open this file: `C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\create-studio-tables.sql`
5. Copy the entire contents and paste into SQL Editor
6. Click **Run** (or press Ctrl+Enter)
7. Verify success - you should see "Success. No rows returned" for each statement

This creates:
- ✅ `organization_tasks` table (task pipeline)
- ✅ `studio_messages` table (chat history)
- ✅ `studio_agents` table (agent workforce)
- ✅ `studio_products` table (product portfolio)
- ✅ RLS policies (restricted to heath.shepard@kw.com)
- ✅ Seed data (4 agents + Dossie product)

### Option B: Via Helper Script

```bash
cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
node scripts/init-studio-db.js
# This prints instructions (same as Option A)
```

---

## Step 2: Test on Staging

**Staging URL:** https://meet-dossie-nc8tcpjt5-heathshepard-6590s-projects.vercel.app/studio.html

1. Visit the staging URL
2. Log in with `heath.shepard@kw.com` (use your existing Dossie password)
3. You should see:
   - ✅ 4 agent cards (Chief of Staff, Builder, Coder, IT Agent) with "idle" status
   - ✅ 1 product card (Dossie) showing live MRR from subscriptions table
   - ✅ Organization metrics (Total Revenue, Total Costs, Net Profit, Tasks This Week)
   - ✅ Chat interface with message input
   - ✅ Voice buttons (disabled with "Phase 2 Coming Soon" tooltips)

### What to Test

- **Agent Cards:** Should show 4 agents, all with "idle" status, 0 tasks completed, $0.00 cost
- **Product Card:** Should show "Dossie" with:
  - Status: Live (green badge)
  - MRR: $58 (2 active subscriptions × $29)
  - Customers: 2
  - Growth: +50%
  - [View App] button links to https://meetdossie.com/app
- **Org Metrics:**
  - Total Revenue: $58 (from Dossie MRR)
  - Total Costs: $0.00 (no tasks run yet)
  - Net Profit: $58 (green, positive)
  - Tasks This Week: 0
- **Chat:**
  - Type a message and click Send
  - Should store your message and return a placeholder response:
    "Message received. In Phase 2, this will trigger a real Chief of Staff agent to process your request."
  - Refresh page - your message history should persist
- **Auto-refresh:** Wait 30 seconds - all sections should refresh automatically
- **Voice Buttons:** Hover over 🎤 and 🔊 - should show "Voice coming in Phase 2" tooltips

---

## Step 3: Deploy to Production

Once testing confirms everything works:

```bash
cd "C:\Users\Heath Shepard\Desktop\MeetDossie"

# Merge staging to main
git checkout main
git merge staging
git push origin main
```

**Production URL:** https://meetdossie.com/studio.html

Vercel will auto-deploy within ~2 minutes.

---

## What You Built

### Frontend (studio.html)
- 4-section grid layout
- Real-time auto-refresh (30s polling)
- Agent workforce dashboard
- Product portfolio view
- Organization metrics summary
- Chat interface with Chief of Staff
- Voice-ready UI (buttons present but disabled)

### Backend (5 API endpoints)
- `/api/studio/status` - Overall org metrics
- `/api/studio/agents` - Agent workforce status
- `/api/studio/products` - Product portfolio with live data
- `/api/studio/tasks` - Query organization_tasks table
- `/api/studio/chat` - Send/receive messages with Chief of Staff

### Database (4 new tables)
- `organization_tasks` - Task pipeline for agent workforce
- `studio_messages` - Chat history
- `studio_agents` - Agent status and metrics
- `studio_products` - Product portfolio data

All tables have RLS policies restricting access to `heath.shepard@kw.com` only.

---

## Architecture Highlights

### Voice-Ready from Day 1
- Voice input button (🎤) present but disabled
- Voice output button (🔊) present but disabled
- UI architecture supports adding Web Speech API + ElevenLabs in Phase 2
- No rework needed - just enable buttons and wire up voice handlers

### Real-Time Ready
- 30-second polling in Phase 1
- Architecture supports WebSocket in Phase 2 (no frontend changes needed)
- WebSocket endpoint planned at `/api/studio/live`

### Live Data Integration
- Dossie MRR calculated from `subscriptions` table (dynamic)
- Organization costs from `organization_tasks.cost_estimate` (dynamic)
- Growth rate calculated from customer count change (currently hardcoded)

---

## Next Steps (Phase 2)

When ready to add voice and real-time features:

1. **Voice Input**
   - Enable microphone button
   - Integrate Web Speech API or Deepgram
   - Convert speech → text → chat endpoint

2. **Voice Output**
   - Enable speaker button
   - Integrate ElevenLabs TTS
   - Stream agent responses as audio

3. **WebSocket Endpoint**
   - Create `/api/studio/live` with Socket.io
   - Real-time agent status updates
   - Real-time task completions
   - Real-time chat responses

4. **Actual Agent Integration**
   - Wire up Claude Code agent spawning
   - Pass tasks to agents via `organization_tasks`
   - Update agent status in real-time
   - Store results and costs

See `SHEPARD-STUDIO.md` for complete Phase 2 specification.

---

## Troubleshooting

### "Access denied" error
- ✅ Check you're logged in as `heath.shepard@kw.com`
- ✅ Go to `/welcome.html` and log in again if needed

### Agents not loading
- ✅ Check browser console (F12) for errors
- ✅ Verify database tables exist (run SQL in Step 1)
- ✅ Check Network tab - `/api/studio/agents` should return 200

### Products showing $0 MRR
- ✅ Verify `subscriptions` table has active rows
- ✅ Check `status='active'` and `plan='founding'`
- ✅ MRR calculated as: count × $29

### Chat not working
- ✅ Check `/api/studio/chat` endpoint in Network tab
- ✅ Verify `studio_messages` table exists
- ✅ Check RLS policies in Supabase Dashboard

---

## File Locations

All files are in: `C:\Users\Heath Shepard\Desktop\MeetDossie`

- `studio.html` - Main UI
- `api/studio/*.js` - 5 API endpoints
- `scripts/create-studio-tables.sql` - Database schema
- `SHEPARD-STUDIO.md` - Complete documentation
- `SHEPARD-STUDIO-SETUP.md` - This file

---

## Summary

**Status:** ✅ Code deployed to staging, database setup pending

**Action Required:**
1. Run SQL from `scripts/create-studio-tables.sql` in Supabase Dashboard
2. Test at staging URL
3. Merge to main when ready

**Estimated Time:** 10 minutes

**Ready for Production:** After Step 1 complete and Step 2 passes

---

Built by Claude Code (Opus 4.5)  
Date: 2026-05-19  
Commit: a4617ad (staging branch)
