CREATE TABLE IF NOT EXISTS public.ai_usage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('lovable', 'gemini')),
  model TEXT NOT NULL,
  gemini_key_id UUID REFERENCES public.gemini_keys(id) ON DELETE SET NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.ai_usage_log TO authenticated;
GRANT ALL ON public.ai_usage_log TO service_role;
ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own AI usage" ON public.ai_usage_log FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS ai_usage_log_user_provider_created_idx ON public.ai_usage_log(user_id, provider, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_log_gemini_key_created_idx ON public.ai_usage_log(gemini_key_id, created_at DESC) WHERE gemini_key_id IS NOT NULL;
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS lovable_monthly_token_budget BIGINT NOT NULL DEFAULT 1000000 CHECK (lovable_monthly_token_budget > 0),
  ADD COLUMN IF NOT EXISTS gemini_monthly_token_budget BIGINT NOT NULL DEFAULT 1000000 CHECK (gemini_monthly_token_budget > 0);