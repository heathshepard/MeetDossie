-- Usage Logs Table
-- Tracks per-user consumption of metered services for cost analytics
-- Run this in Supabase SQL Editor to create the table

CREATE TABLE IF NOT EXISTS public.usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('elevenlabs', 'anthropic', 'resend', 'creatomate', 'hcti')),
  usage_type TEXT NOT NULL CHECK (usage_type IN ('voice_tts', 'chat', 'scan', 'email', 'video_render', 'image_render')),
  units_consumed INTEGER NOT NULL DEFAULT 0,
  estimated_cost DECIMAL(10, 4) NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON public.usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_service ON public.usage_logs(service);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON public.usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_service ON public.usage_logs(user_id, service);

-- Enable RLS (admin-only reads)
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;

-- Policy: Only allow service role to read/write (admin dashboard + API logging)
CREATE POLICY "Service role full access" ON public.usage_logs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.usage_logs IS 'Per-user consumption tracking for metered services (ElevenLabs, Anthropic, Resend, Creatomate, HCTI)';
COMMENT ON COLUMN public.usage_logs.user_id IS 'User who triggered the usage (NULL for system-level usage)';
COMMENT ON COLUMN public.usage_logs.service IS 'Service provider: elevenlabs, anthropic, resend, creatomate, hcti';
COMMENT ON COLUMN public.usage_logs.usage_type IS 'Specific usage type: voice_tts, chat, scan, email, video_render, image_render';
COMMENT ON COLUMN public.usage_logs.units_consumed IS 'Raw units consumed (characters for TTS, tokens for AI, email count, render count)';
COMMENT ON COLUMN public.usage_logs.estimated_cost IS 'Calculated cost in USD based on service pricing';
COMMENT ON COLUMN public.usage_logs.metadata IS 'Additional context: endpoint, model, text_length, token_breakdown, etc.';
