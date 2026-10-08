ALTER TABLE public.prompt_files ADD COLUMN IF NOT EXISTS is_for_sale boolean NOT NULL DEFAULT false;
ALTER TABLE public.prompt_files ADD COLUMN IF NOT EXISTS price numeric;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS prompt_file_id uuid REFERENCES public.prompt_files(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS file_delivered_at timestamptz;