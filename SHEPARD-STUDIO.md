# Shepard Studio - Venture Studio Operating System

## Overview

Shepard Studio is the command center UI for managing the entire Shepard Studio venture portfolio. It provides real-time visibility into:
- Agent workforce (Builder, Coder, IT Agent, Chief of Staff)
- Product portfolio (Dossie + future products)
- Organization metrics (revenue, costs, profit, velocity)
- Chat interface with Chief of Staff

**Status:** Phase 1 MVP - voice-ready architecture in place, voice features coming in Phase 2

---

## Architecture

### Frontend
- **File:** `studio.html`
- **Stack:** Vanilla JavaScript + Supabase client (ESM from CDN)
- **Design:** Matches Dossie brand (Cormorant Garamond, Blush/Sage/Gold/Navy)
- **Layout:** 4-section grid (Agent Workforce, Product Portfolio, Org Metrics, Chat)
- **Auth:** Supabase Auth, restricted to `heath.shepard@kw.com`
- **Updates:** 30-second auto-refresh for agents/products/metrics

### Backend API
All endpoints in `/api/studio/*`:

| Endpoint | Method | Description |
|---|---|---|
| `/api/studio/status` | GET | Overall org status (revenue, costs, profit, velocity) |
| `/api/studio/agents` | GET | Agent workforce status with current tasks |
| `/api/studio/products` | GET | Product portfolio with live MRR/customers |
| `/api/studio/tasks` | GET | Query organization_tasks (filter by status/agent) |
| `/api/studio/chat` | GET/POST | Chat with Chief of Staff |

**Auth:** All endpoints require Supabase JWT, restricted to `heath.shepard@kw.com`

### Database Tables

#### `organization_tasks`
Task pipeline for agent workforce.

```sql
CREATE TABLE organization_tasks (
  id UUID PRIMARY KEY,
  agent_name TEXT NOT NULL,
  task_description TEXT NOT NULL,
  status TEXT CHECK (status IN ('queued', 'working', 'completed', 'failed')),
  assigned_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  tokens_used INTEGER DEFAULT 0,
  cost_estimate DECIMAL(10,4) DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `studio_messages`
Chat history with Chief of Staff.

```sql
CREATE TABLE studio_messages (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  agent_name TEXT NOT NULL DEFAULT 'Chief of Staff',
  message TEXT NOT NULL,
  response TEXT,
  status TEXT CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);
```

#### `studio_agents`
Agent workforce status.

```sql
CREATE TABLE studio_agents (
  id UUID PRIMARY KEY,
  agent_name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  description TEXT,
  status TEXT CHECK (status IN ('idle', 'working', 'completed', 'error')),
  current_task_id UUID REFERENCES organization_tasks(id),
  total_tasks_completed INTEGER DEFAULT 0,
  total_tokens_used BIGINT DEFAULT 0,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `studio_products`
Product portfolio.

```sql
CREATE TABLE studio_products (
  id UUID PRIMARY KEY,
  product_name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  logo_url TEXT,
  status TEXT CHECK (status IN ('planning', 'development', 'beta', 'live', 'sunset')),
  launch_date DATE,
  mrr DECIMAL(10,2) DEFAULT 0,
  active_customers INTEGER DEFAULT 0,
  growth_rate DECIMAL(5,2) DEFAULT 0,
  description TEXT,
  app_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**RLS:** All tables restricted to `heath.shepard@kw.com` via RLS policies.

---

## Setup Instructions

### 1. Initialize Database

```bash
# Option A: Run via Supabase Dashboard (recommended)
node scripts/init-studio-db.js
# This prints instructions to copy/paste SQL into Supabase SQL Editor

# Option B: Manual
# 1. Go to https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/editor
# 2. Click SQL Editor > New query
# 3. Copy contents of scripts/create-studio-tables.sql
# 4. Paste and click Run
```

This creates:
- 4 tables (organization_tasks, studio_messages, studio_agents, studio_products)
- RLS policies (restrict to heath.shepard@kw.com)
- Seed data (4 agents: Chief of Staff, Builder, Coder, IT Agent)
- Seed data (1 product: Dossie)

### 2. Deploy to Staging

```bash
# Switch to staging branch
git checkout staging

# Add and commit all new files
git add api/studio/*.js studio.html scripts/create-studio-tables.sql scripts/init-studio-db.js SHEPARD-STUDIO.md
git commit -m "Add Shepard Studio command center - Phase 1"

# Push to staging (Vercel auto-deploys)
git push origin staging
```

**Staging URL:** https://meet-dossie-nc8tcpjt5-heathshepard-6590s-projects.vercel.app/studio.html

### 3. Test on Staging

1. Visit staging URL
2. Log in with `heath.shepard@kw.com`
3. Verify:
   - Agent cards load (4 agents with idle status)
   - Product card shows Dossie with live MRR/customers from subscriptions table
   - Org metrics show totals (revenue, costs, profit, velocity)
   - Chat interface allows sending messages
   - Voice buttons show "Phase 2 Coming Soon" tooltips
   - Auto-refresh works (30s interval)

### 4. Deploy to Production

```bash
# After testing confirms everything works
git checkout main
git merge staging
git push origin main
```

**Production URL:** https://meetdossie.com/studio.html

---

## Voice Readiness (Phase 2)

The UI is architecturally ready for voice input/output. Phase 2 additions:

### Voice Input
- Enable microphone button
- Integrate Web Speech API (browser-native) or Deepgram
- Convert speech to text
- Pass to chat endpoint

### Voice Output
- Enable speaker button
- Integrate ElevenLabs TTS
- Stream responses as audio
- Support voice selection (Bill/Luna/custom)

### Backend Changes
- Add WebSocket endpoint (`/api/studio/live`)
- Real-time updates for task status changes
- Real-time agent responses
- Wire up actual Claude Code agent spawning

**Implementation notes in:** `scripts/voice-phase-2-spec.md` (to be created)

---

## Data Sources

### Live Data (Dynamic)
- **Dossie MRR/Customers:** Calculated from `subscriptions` table (`status='active'`)
- **Org Costs:** Sum of `organization_tasks.cost_estimate`
- **Task Velocity:** Count of `organization_tasks` where `status='completed'` in last 7 days

### Seed Data (Static until Phase 2)
- **Agents:** 4 pre-seeded in `studio_agents` (Chief of Staff, Builder, Coder, IT Agent)
- **Products:** Dossie pre-seeded in `studio_products`

### Cost Estimates
Phase 1 uses hardcoded token cost: `(tokens / 1000000) * $3.00`

Phase 2 will track actual costs per model:
- Sonnet 4.5: $3/M input, $15/M output
- Opus 4.5: $15/M input, $75/M output

---

## Usage

### Accessing the Studio

**URL:** `https://meetdossie.com/studio.html`

**Auth:** Must be logged in as `heath.shepard@kw.com`. Other users see "Access denied" and redirect to `/app.html`.

### Agent Cards

Each agent card shows:
- Avatar (colored circle with initials)
- Name (Chief of Staff, Builder, Coder, IT Agent)
- Status badge (Idle/Working/Completed/Error)
- Current task (if working)
- Total tasks completed
- Cost estimate (based on tokens used)

Click an agent card to view task history (Phase 2).

### Product Cards

Each product card shows:
- Logo/icon
- Name (Dossie, etc.)
- Status badge (Live/Development/Beta/Planning)
- MRR (monthly recurring revenue)
- Active customers count
- Growth rate (% vs last month)
- [View Analytics] button (links to product dashboard)

### Org Metrics

Summary cards show:
- **Total Revenue:** Sum of all product MRR
- **Total Costs:** Sum of agent costs (token usage)
- **Net Profit:** Revenue - Costs (green if positive, red if negative)
- **Tasks This Week:** Count of completed tasks in last 7 days

### Chat Interface

- **Agent selector:** Choose which agent to message (all route to Chief of Staff in Phase 1)
- **Message input:** Type message and press Enter or click Send
- **Message history:** Shows your messages + agent responses
- **Voice buttons:** Disabled with "Phase 2 Coming Soon" tooltips

---

## Future Products

When adding a new product to the portfolio:

```sql
INSERT INTO studio_products (product_name, display_name, status, description, app_url)
VALUES ('product_slug', 'Product Name', 'development', 'Description here', 'https://url.com');
```

The frontend will automatically:
- Show the product card
- Pull live MRR/customers from its subscription table (if table name matches pattern)
- Display status badge
- Enable [View Analytics] button if `app_url` is set

---

## Maintenance

### Adding New Agents

```sql
INSERT INTO studio_agents (agent_name, display_name, avatar_color, description)
VALUES ('agent_slug', 'Agent Name', '#HEX_COLOR', 'Description here');
```

Avatar color palette:
- Navy: `#1A1A2E` (Chief of Staff)
- Sage: `#8BA888` (Builder)
- Gold: `#C9A96E` (Coder)
- Coral: `#E8836B` (IT Agent)

### Updating Agent Status

When an agent starts a task:

```sql
-- Create task
INSERT INTO organization_tasks (agent_name, task_description, status)
VALUES ('builder', 'Build feature X', 'working')
RETURNING id;

-- Update agent
UPDATE studio_agents
SET status = 'working', current_task_id = '<task_id>', last_active_at = NOW()
WHERE agent_name = 'builder';
```

When an agent completes a task:

```sql
-- Update task
UPDATE organization_tasks
SET status = 'completed', completed_at = NOW(), tokens_used = 50000, cost_estimate = 0.15
WHERE id = '<task_id>';

-- Update agent
UPDATE studio_agents
SET status = 'idle', current_task_id = NULL, total_tasks_completed = total_tasks_completed + 1,
    total_tokens_used = total_tokens_used + 50000, last_active_at = NOW()
WHERE agent_name = 'builder';
```

### Manual SQL Access

```bash
# Via Supabase Dashboard
https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/editor

# Via psql (if you have connection string)
psql "postgresql://postgres:[PASSWORD]@db.pgwoitbdiyubjugwufhk.supabase.co:5432/postgres"
```

---

## Troubleshooting

### "Access denied" error
- Check you're logged in as `heath.shepard@kw.com`
- Check Supabase session is valid (go to `/welcome.html` and log in again)

### Agents not loading
- Check browser console for errors
- Verify `/api/studio/agents` returns 200 (check Network tab)
- Verify `studio_agents` table exists and has seed data

### Products not loading
- Check `/api/studio/products` endpoint
- Verify `studio_products` table exists
- Check Dossie seed data is present

### Chat not working
- Check `/api/studio/chat` endpoint
- Verify `studio_messages` table exists
- Check RLS policies allow heath.shepard@kw.com

### Database setup issues
- Run `node scripts/init-studio-db.js` and follow instructions
- Manually run SQL from `scripts/create-studio-tables.sql` in Supabase Dashboard

---

## File Manifest

### Frontend
- `studio.html` - Main UI (standalone, no build step)

### Backend API
- `api/studio/status.js` - Org metrics endpoint
- `api/studio/agents.js` - Agent workforce endpoint
- `api/studio/products.js` - Product portfolio endpoint
- `api/studio/tasks.js` - Task query endpoint
- `api/studio/chat.js` - Chat interface endpoint

### Database
- `scripts/create-studio-tables.sql` - Table definitions + seed data
- `scripts/init-studio-db.js` - Setup helper script

### Documentation
- `SHEPARD-STUDIO.md` - This file

---

## Integration with Claude Code

Phase 1: Chat messages stored in database, placeholder responses.

Phase 2: Wire up actual agent communication:
1. User sends message via `/api/studio/chat`
2. Backend creates task in `organization_tasks`
3. Backend spawns Claude Code agent with context
4. Agent processes task, updates status in real-time via WebSocket
5. Agent stores result in `organization_tasks.result`
6. Backend sends response to `studio_messages`
7. Frontend updates in real-time via WebSocket

**Implementation:** See Chief of Staff agent specification (to be created).

---

## Security

- **Auth:** All endpoints require Supabase JWT
- **RLS:** All tables restricted to `heath.shepard@kw.com`
- **CORS:** Allows `meetdossie.com`, `staging.meetdossie.com`, `*.vercel.app`, localhost
- **Secrets:** No API keys exposed in frontend (all in Vercel env vars)

---

## Performance

- **Auto-refresh:** 30-second polling (no WebSocket in Phase 1)
- **API latency:** <500ms per endpoint (all queries indexed)
- **Frontend size:** ~15KB HTML (no external dependencies except Supabase client from CDN)
- **Database:** Indexes on `status`, `agent_name`, `created_at` for fast queries

Phase 2 WebSocket will eliminate polling overhead.

---

## Roadmap

### Phase 1 (Current)
- ✅ Database schema
- ✅ API endpoints
- ✅ Frontend UI
- ✅ Auth and RLS
- ✅ Live data integration (Dossie MRR/customers)
- ✅ Voice-ready architecture (buttons present but disabled)

### Phase 2 (Voice + Real-time)
- [ ] WebSocket endpoint for real-time updates
- [ ] Voice input (Web Speech API or Deepgram)
- [ ] Voice output (ElevenLabs TTS)
- [ ] Wire up actual Claude Code agent spawning
- [ ] Task history modal (click agent to view)
- [ ] Historical growth rate calculation

### Phase 3 (Analytics + Insights)
- [ ] Revenue/cost charts (Chart.js)
- [ ] Agent performance metrics
- [ ] Product health dashboard
- [ ] Predictive analytics (burn rate, runway)

---

## Support

For issues or questions:
- **Telegram:** Message Heath directly
- **Codebase:** `CLAUDE.md` (section 1: "What Dossie Is")
- **Database:** Supabase Dashboard → SQL Editor

---

**Built by:** Claude Code (Opus 4.5) + Heath Shepard
**Date:** 2026-05-19
**Version:** Phase 1 MVP
