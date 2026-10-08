ALTER TABLE public.products ADD COLUMN IF NOT EXISTS page_ids TEXT[] NOT NULL DEFAULT '{}'::text[];
CREATE INDEX IF NOT EXISTS idx_products_page_ids ON public.products USING gin (page_ids);