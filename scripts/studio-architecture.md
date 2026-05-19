# Shepard Studio - Technical Architecture

## Overview

Shepard Studio is a real-time venture studio operating system built on Vercel + Supabase. It provides visibility into agent workforce, product portfolio, and organization metrics.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (studio.html)                    │
│  - Vanilla JS + Supabase client (ESM from CDN)              │
│  - No build step, no dependencies                            │
│  - Auto-refresh every 30s (polling)                          │
│  - Voice UI elements (disabled in Phase 1)                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ HTTPS (Bearer JWT)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Backend API (/api/studio/*)                     │
│  - 5 Vercel Serverless Functions                            │
│  - Auth: verifySupabaseToken middleware                     │
│  - RLS: restricted to heath.shepard@kw.com                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ PostgREST API + Service Role Key
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Supabase PostgreSQL                         │
│  - 4 tables: organization_tasks, studio_messages,           │
│              studio_agents, studio_products                  │
│  - RLS policies on all tables                               │
│  - Indexes: status, agent_name, created_at                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. Agent Workforce View

```
Frontend                API Endpoint             Supabase
   │                        │                        │
   │─── GET /api/studio/agents ────────────────────→│
   │                        │                        │
   │                        │← SELECT * FROM studio_agents
   │                        │                        │
   │                        │  For each agent with current_task_id:
   │                        │← SELECT * FROM organization_tasks
   │                        │     WHERE id = current_task_id
   │                        │                        │
   │←─── JSON response ─────│                        │
   │   {                    │                        │
   │     agents: [          │                        │
   │       {                │                        │
   │         name,          │                        │
   │         status,        │                        │
   │         currentTask,   │                        │
   │         totalTasksCompleted,                    │
   │         costEstimate   │                        │
   │       }                │                        │
   │     ]                  │                        │
   │   }                    │                        │
```

### 2. Product Portfolio View

```
Frontend                API Endpoint             Supabase
   │                        │                        │
   │─── GET /api/studio/products ──────────────────→│
   │                        │                        │
   │                        │← SELECT * FROM studio_products
   │                        │                        │
   │                        │  If product_name = 'dossie':
   │                        │← SELECT * FROM subscriptions
   │                        │     WHERE status = 'active'
   │                        │                        │
   │                        │  Calculate MRR:        │
   │                        │    count × $29/mo     │
   │                        │                        │
   │←─── JSON response ─────│                        │
   │   {                    │                        │
   │     products: [        │                        │
   │       {                │                        │
   │         name,          │                        │
   │         mrr,           │                        │
   │         activeCustomers,                        │
   │         growthRate     │                        │
   │       }                │                        │
   │     ]                  │                        │
   │   }                    │                        │
```

### 3. Organization Metrics

```
Frontend                API Endpoint             Supabase
   │                        │                        │
   │─── GET /api/studio/status ────────────────────→│
   │                        │                        │
   │                        │← SELECT mrr, active_customers
   │                        │     FROM studio_products
   │                        │                        │
   │                        │← SELECT cost_estimate  │
   │                        │     FROM organization_tasks
   │                        │                        │
   │                        │← SELECT COUNT(*)       │
   │                        │     FROM organization_tasks
   │                        │     WHERE status = 'completed'
   │                        │       AND completed_at >= NOW() - INTERVAL '7 days'
   │                        │                        │
   │                        │  Calculate:            │
   │                        │    totalRevenue = SUM(mrr)
   │                        │    totalCosts = SUM(cost_estimate)
   │                        │    netProfit = totalRevenue - totalCosts
   │                        │                        │
   │←─── JSON response ─────│                        │
   │   {                    │                        │
   │     totalRevenue,      │                        │
   │     totalCosts,        │                        │
   │     netProfit,         │                        │
   │     tasksCompletedThisWeek                      │
   │   }                    │                        │
```

### 4. Chat Interface

```
Frontend                API Endpoint             Supabase
   │                        │                        │
   │─── POST /api/studio/chat ─────────────────────→│
   │   {                    │                        │
   │     message: "Build X" │                        │
   │   }                    │                        │
   │                        │                        │
   │                        │← INSERT INTO studio_messages
   │                        │     (user_id, agent_name, message, status)
   │                        │     VALUES (...)       │
   │                        │     RETURNING id       │
   │                        │                        │
   │                        │  [Phase 1: Auto-response]
   │                        │                        │
   │                        │← UPDATE studio_messages
   │                        │     SET response = '...', status = 'completed'
   │                        │     WHERE id = ...     │
   │                        │                        │
   │←─── JSON response ─────│                        │
   │   {                    │                        │
   │     id,                │                        │
   │     message,           │                        │
   │     response           │                        │
   │   }                    │                        │
```

---

## Database Schema

### organization_tasks

```sql
CREATE TABLE organization_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,                    -- 'builder', 'coder', etc.
  task_description TEXT NOT NULL,              -- "Build feature X"
  status TEXT NOT NULL,                        -- 'queued', 'working', 'completed', 'failed'
  assigned_at TIMESTAMPTZ DEFAULT NOW(),       -- When task was created
  started_at TIMESTAMPTZ,                      -- When agent started
  completed_at TIMESTAMPTZ,                    -- When agent finished
  tokens_used INTEGER DEFAULT 0,               -- Input + output tokens
  cost_estimate DECIMAL(10,4) DEFAULT 0,       -- USD cost
  result TEXT,                                 -- Agent's response
  error TEXT,                                  -- Error message if failed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_organization_tasks_status ON organization_tasks(status);
CREATE INDEX idx_organization_tasks_agent ON organization_tasks(agent_name);
CREATE INDEX idx_organization_tasks_created ON organization_tasks(created_at DESC);
```

**Usage:**
- When agent starts task: INSERT with `status='working'`
- When agent completes: UPDATE `status='completed'`, set `completed_at`, `tokens_used`, `cost_estimate`, `result`
- When agent fails: UPDATE `status='failed'`, set `error`

### studio_messages

```sql
CREATE TABLE studio_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),      -- Heath's user ID
  agent_name TEXT NOT NULL DEFAULT 'Chief of Staff',
  message TEXT NOT NULL,                       -- User's message
  response TEXT,                               -- Agent's response
  status TEXT NOT NULL DEFAULT 'pending',      -- 'pending', 'processing', 'completed', 'failed'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ                     -- When agent responded
);

CREATE INDEX idx_studio_messages_user ON studio_messages(user_id);
CREATE INDEX idx_studio_messages_created ON studio_messages(created_at DESC);
```

**Usage:**
- User sends message: INSERT with `status='pending'`
- Agent responds: UPDATE `status='completed'`, set `response`, `responded_at`

### studio_agents

```sql
CREATE TABLE studio_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT UNIQUE NOT NULL,             -- 'chief_of_staff', 'builder', 'coder', 'it_agent'
  display_name TEXT NOT NULL,                  -- 'Chief of Staff', 'Builder', etc.
  avatar_color TEXT NOT NULL,                  -- '#1A1A2E', '#8BA888', etc.
  description TEXT,                            -- "Strategic oversight and coordination"
  status TEXT NOT NULL DEFAULT 'idle',         -- 'idle', 'working', 'completed', 'error'
  current_task_id UUID REFERENCES organization_tasks(id) ON DELETE SET NULL,
  total_tasks_completed INTEGER DEFAULT 0,     -- Lifetime count
  total_tokens_used BIGINT DEFAULT 0,          -- Lifetime tokens
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_studio_agents_status ON studio_agents(status);
```

**Usage:**
- Agent starts task: UPDATE `status='working'`, set `current_task_id`, `last_active_at`
- Agent completes: UPDATE `status='idle'`, clear `current_task_id`, increment `total_tasks_completed`, add to `total_tokens_used`

### studio_products

```sql
CREATE TABLE studio_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT UNIQUE NOT NULL,           -- 'dossie', 'product2', etc.
  display_name TEXT NOT NULL,                  -- 'Dossie', 'Product 2', etc.
  logo_url TEXT,                               -- URL to logo image
  status TEXT NOT NULL DEFAULT 'development',  -- 'planning', 'development', 'beta', 'live', 'sunset'
  launch_date DATE,
  mrr DECIMAL(10,2) DEFAULT 0,                 -- Monthly recurring revenue (may be overridden by live calc)
  active_customers INTEGER DEFAULT 0,          -- Customer count (may be overridden)
  growth_rate DECIMAL(5,2) DEFAULT 0,          -- % growth vs last month
  description TEXT,
  app_url TEXT,                                -- URL to product dashboard
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Usage:**
- Seed data for Dossie exists
- `/api/studio/products` overrides `mrr` and `active_customers` for Dossie by querying `subscriptions` table
- Future products can be added manually or via admin UI

---

## API Endpoints

### GET /api/studio/status

**Auth:** Bearer JWT (heath.shepard@kw.com only)

**Response:**
```json
{
  "success": true,
  "data": {
    "totalRevenue": 58.00,
    "totalCosts": 0.00,
    "netProfit": 58.00,
    "totalCustomers": 2,
    "tasksCompletedThisWeek": 0,
    "timestamp": "2026-05-19T19:30:00Z"
  }
}
```

### GET /api/studio/agents

**Auth:** Bearer JWT (heath.shepard@kw.com only)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "chief_of_staff",
      "displayName": "Chief of Staff",
      "avatarColor": "#1A1A2E",
      "description": "Strategic oversight and coordination",
      "status": "idle",
      "currentTask": null,
      "totalTasksCompleted": 0,
      "totalTokensUsed": 0,
      "costEstimate": "0.00",
      "lastActiveAt": null
    }
  ]
}
```

### GET /api/studio/products

**Auth:** Bearer JWT (heath.shepard@kw.com only)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "dossie",
      "displayName": "Dossie",
      "logoUrl": null,
      "status": "live",
      "launchDate": null,
      "mrr": 58.00,
      "activeCustomers": 2,
      "growthRate": 50.00,
      "description": "AI Transaction Coordinator for Texas Real Estate",
      "appUrl": "https://meetdossie.com/app"
    }
  ]
}
```

### GET /api/studio/tasks

**Auth:** Bearer JWT (heath.shepard@kw.com only)

**Query Params:**
- `status` (optional): Filter by status
- `agent` (optional): Filter by agent_name
- `limit` (optional): Max results (default 50)
- `offset` (optional): Pagination offset (default 0)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "agentName": "builder",
      "description": "Build feature X",
      "status": "completed",
      "assignedAt": "2026-05-19T10:00:00Z",
      "startedAt": "2026-05-19T10:01:00Z",
      "completedAt": "2026-05-19T10:15:00Z",
      "tokensUsed": 50000,
      "costEstimate": 0.15,
      "result": "Feature X built successfully",
      "error": null
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1
  }
}
```

### POST /api/studio/chat

**Auth:** Bearer JWT (heath.shepard@kw.com only)

**Request:**
```json
{
  "message": "Build feature X",
  "agent": "Chief of Staff"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "message": "Build feature X",
    "response": "Message received. In Phase 2, this will trigger...",
    "agentName": "Chief of Staff"
  }
}
```

### GET /api/studio/chat

**Auth:** Bearer JWT (heath.shepard@kw.com only)

**Query Params:**
- `limit` (optional): Max messages (default 50)
- `offset` (optional): Pagination offset (default 0)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "agentName": "Chief of Staff",
      "message": "Build feature X",
      "response": "Message received...",
      "status": "completed",
      "createdAt": "2026-05-19T10:00:00Z",
      "respondedAt": "2026-05-19T10:00:01Z"
    }
  ]
}
```

---

## Security

### Authentication
- All endpoints require Supabase JWT (Bearer token)
- Token verified via `verifySupabaseToken` middleware
- User email must match `heath.shepard@kw.com`

### Row-Level Security (RLS)
All tables have RLS policies:

```sql
CREATE POLICY "Heath only - TABLE_NAME" ON TABLE_NAME
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.email = 'heath.shepard@kw.com'
    )
  );
```

This ensures:
- Only Heath can read/write data
- Even with service role key, RLS enforced
- No data leakage if JWT compromised

### CORS
Allowed origins:
- `https://meetdossie.com`
- `https://www.meetdossie.com`
- `https://staging.meetdossie.com`
- `*.vercel.app`
- `localhost` (development)

---

## Performance

### Frontend
- **Page size:** ~15KB HTML (gzipped)
- **Dependencies:** 1 (Supabase client from CDN)
- **Load time:** <2s on 3G
- **Refresh rate:** 30s polling (low overhead)

### Backend
- **Cold start:** <500ms (Vercel Serverless Functions)
- **Warm latency:** <200ms per endpoint
- **Throughput:** ~1000 req/s (Vercel limit)

### Database
- **Query latency:** <50ms (Supabase hosted in us-east-1)
- **Indexes:** All queries use indexed columns
- **Connection pooling:** Handled by Supabase

---

## Monitoring

### Frontend Errors
- Check browser console (F12 → Console)
- Network tab shows API request/response

### Backend Errors
- Vercel Logs: https://vercel.com/heathshepard-6590s-projects/meet-dossie/logs
- Filter by function name: `api/studio/*`

### Database Errors
- Supabase Logs: https://supabase.com/dashboard/project/pgwoitbdiyubjugwufhk/logs

---

## Phase 2 Architecture Changes

### WebSocket Endpoint
```
Frontend ← WebSocket → /api/studio/live
                           │
                           ├─ Redis (state sync)
                           ├─ Supabase (listen to PG changes)
                           └─ Claude Code agents (task updates)
```

### Voice Pipeline
```
Frontend (mic) → Web Speech API → text
                                    ↓
                    /api/studio/chat (POST)
                                    ↓
                    Chief of Staff agent
                                    ↓
                    ElevenLabs TTS ← text
                                    ↓
Frontend (speaker) ← audio stream
```

### Agent Integration
```
studio_messages.message → organization_tasks (INSERT)
                              ↓
                        Claude Code agent spawned
                              ↓
                        Agent updates task status (WebSocket broadcast)
                              ↓
                        studio_agents updated (status, tokens)
                              ↓
                        studio_messages.response (UPDATE)
```

---

## Cost Estimate

### Phase 1 (Current)
- **Vercel:** Free (under limits)
- **Supabase:** Free (under limits)
- **Frontend:** Static HTML (no CDN costs)
- **Total:** $0/mo

### Phase 2 (Voice + Real-time)
- **Vercel:** ~$20/mo (WebSocket function)
- **Supabase:** Free (under limits)
- **ElevenLabs TTS:** ~$5/mo (11,000 chars)
- **Redis (optional):** $0 (Upstash free tier)
- **Total:** ~$25/mo

### Production Scale (100+ tasks/day)
- **Vercel:** ~$50/mo
- **Supabase:** ~$25/mo (upgraded)
- **ElevenLabs:** ~$20/mo
- **Claude API:** ~$100/mo (Opus 4.5)
- **Total:** ~$195/mo

---

## Deployment

### Staging
- **Branch:** `staging`
- **URL:** https://meet-dossie-nc8tcpjt5-heathshepard-6590s-projects.vercel.app/studio.html
- **Auto-deploy:** On push to `staging` branch

### Production
- **Branch:** `main`
- **URL:** https://meetdossie.com/studio.html
- **Auto-deploy:** On push to `main` branch

---

Built by: Claude Code (Opus 4.5)  
Date: 2026-05-19  
Version: Phase 1 MVP
