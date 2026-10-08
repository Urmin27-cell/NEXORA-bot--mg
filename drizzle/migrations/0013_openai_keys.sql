CREATE TABLE public.openai_keys(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,label text NOT NULL,api_key text NOT NULL,selected_model text,is_active boolean NOT NULL DEFAULT true,last_used_at timestamptz,error_count int NOT NULL DEFAULT 0,disabled_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.openai_keys TO authenticated;
GRANT ALL ON public.openai_keys TO service_role;
ALTER TABLE public.openai_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own openai keys" ON public.openai_keys FOR ALL TO authenticated USING(auth.uid()=user_id) WITH CHECK(auth.uid()=user_id);
CREATE TRIGGER trg_openai_keys_updated BEFORE UPDATE ON public.openai_keys FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();