CREATE TABLE public.ai_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  question_norm TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  source TEXT NOT NULL DEFAULT 'ai',
  language TEXT NOT NULL DEFAULT 'mg',
  confidence NUMERIC NOT NULL DEFAULT 0.5,
  usage_count INTEGER NOT NULL DEFAULT 0,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  page_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_knowledge_user_idx ON public.ai_knowledge (user_id, created_at DESC);
CREATE INDEX ai_knowledge_norm_idx ON public.ai_knowledge (user_id, question_norm);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_knowledge TO authenticated;
GRANT ALL ON public.ai_knowledge TO service_role;

ALTER TABLE public.ai_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own knowledge"
ON public.ai_knowledge FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER ai_knowledge_set_updated_at
BEFORE UPDATE ON public.ai_knowledge
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.ai_pending_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id TEXT,
  comment_id TEXT,
  post_id TEXT,
  page_id TEXT,
  client_id TEXT,
  question TEXT NOT NULL DEFAULT '',
  request_type TEXT NOT NULL DEFAULT 'comment',
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX ai_pending_comment_uidx ON public.ai_pending_requests (comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX ai_pending_status_idx ON public.ai_pending_requests (user_id, status, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_pending_requests TO authenticated;
GRANT ALL ON public.ai_pending_requests TO service_role;

ALTER TABLE public.ai_pending_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own pending requests"
ON public.ai_pending_requests FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);