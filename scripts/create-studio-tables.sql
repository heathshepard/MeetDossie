-- Shepard Studio database tables

-- Table for organization-level tasks (may already exist)
CREATE TABLE IF NOT EXISTS organization_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  task_description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'working', 'completed', 'failed')),
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  tokens_used INTEGER DEFAULT 0,
  cost_estimate DECIMAL(10,4) DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organization_tasks_status ON organization_tasks(status);
CREATE INDEX IF NOT EXISTS idx_organization_tasks_agent ON organization_tasks(agent_name);
CREATE INDEX IF NOT EXISTS idx_organization_tasks_created ON organization_tasks(created_at DESC);

-- Table for studio chat messages
CREATE TABLE IF NOT EXISTS studio_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL DEFAULT 'Chief of Staff',
  message TEXT NOT NULL,
  response TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_studio_messages_user ON studio_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_studio_messages_created ON studio_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_messages_status ON studio_messages(status);

-- Table for studio agent status
CREATE TABLE IF NOT EXISTS studio_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'completed', 'error')),
  current_task_id UUID REFERENCES organization_tasks(id) ON DELETE SET NULL,
  total_tasks_completed INTEGER DEFAULT 0,
  total_tokens_used BIGINT DEFAULT 0,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_agents_status ON studio_agents(status);
CREATE INDEX IF NOT EXISTS idx_studio_agents_name ON studio_agents(agent_name);

-- Table for products in the portfolio
CREATE TABLE IF NOT EXISTS studio_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  logo_url TEXT,
  status TEXT NOT NULL DEFAULT 'development' CHECK (status IN ('planning', 'development', 'beta', 'live', 'sunset')),
  launch_date DATE,
  mrr DECIMAL(10,2) DEFAULT 0,
  active_customers INTEGER DEFAULT 0,
  growth_rate DECIMAL(5,2) DEFAULT 0,
  description TEXT,
  app_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_products_status ON studio_products(status);
CREATE INDEX IF NOT EXISTS idx_studio_products_name ON studio_products(product_name);

-- Seed initial agents
INSERT INTO studio_agents (agent_name, display_name, avatar_color, description) VALUES
  ('chief_of_staff', 'Chief of Staff', '#1A1A2E', 'Strategic oversight and coordination'),
  ('builder', 'Builder', '#8BA888', 'Product development and architecture'),
  ('coder', 'Coder', '#C9A96E', 'Implementation and code execution'),
  ('it_agent', 'IT Agent', '#E8836B', 'Infrastructure and DevOps')
ON CONFLICT (agent_name) DO NOTHING;

-- Seed Dossie as first product
INSERT INTO studio_products (product_name, display_name, status, description, app_url) VALUES
  ('dossie', 'Dossie', 'live', 'AI Transaction Coordinator for Texas Real Estate', 'https://meetdossie.com/app')
ON CONFLICT (product_name) DO NOTHING;

-- Enable RLS
ALTER TABLE organization_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_products ENABLE ROW LEVEL SECURITY;

-- RLS Policies (restrict to heath.shepard@kw.com)
CREATE POLICY "Heath only - organization_tasks" ON organization_tasks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.email = 'heath.shepard@kw.com'
    )
  );

CREATE POLICY "Heath only - studio_messages" ON studio_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.email = 'heath.shepard@kw.com'
    )
  );

CREATE POLICY "Heath only - studio_agents" ON studio_agents
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.email = 'heath.shepard@kw.com'
    )
  );

CREATE POLICY "Heath only - studio_products" ON studio_products
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
      AND auth.users.email = 'heath.shepard@kw.com'
    )
  );
