CREATE TABLE IF NOT EXISTS public.prompt_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  prompt_id UUID REFERENCES public.prompts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  description TEXT,
  media_type TEXT NOT NULL DEFAULT 'file',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_path TEXT NOT NULL,
  file_url TEXT,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.prompt_files TO authenticated;
GRANT ALL ON public.prompt_files TO service_role;

ALTER TABLE public.prompt_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prompt_files own select" ON public.prompt_files;
CREATE POLICY "prompt_files own select" ON public.prompt_files
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "prompt_files own insert" ON public.prompt_files;
CREATE POLICY "prompt_files own insert" ON public.prompt_files
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "prompt_files own update" ON public.prompt_files;
CREATE POLICY "prompt_files own update" ON public.prompt_files
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "prompt_files own delete" ON public.prompt_files;
CREATE POLICY "prompt_files own delete" ON public.prompt_files
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_prompt_files_user ON public.prompt_files(user_id);
CREATE INDEX IF NOT EXISTS idx_prompt_files_prompt ON public.prompt_files(prompt_id);

DROP POLICY IF EXISTS "prompt files own read" ON storage.objects;
CREATE POLICY "prompt files own read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'prompt-files' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "prompt files own write" ON storage.objects;
CREATE POLICY "prompt files own write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'prompt-files' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "prompt files own delete" ON storage.objects;
CREATE POLICY "prompt files own delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'prompt-files' AND auth.uid()::text = (storage.foldername(name))[1]);