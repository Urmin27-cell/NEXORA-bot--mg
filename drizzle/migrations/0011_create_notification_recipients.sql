CREATE TABLE public.notification_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  recipient_psid TEXT NOT NULL,
  label TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notify_quota BOOLEAN NOT NULL DEFAULT TRUE,
  notify_orders BOOLEAN NOT NULL DEFAULT TRUE,
  last_quota_notified_at TIMESTAMPTZ,
  last_order_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notification_recipients_unique_psid
  ON public.notification_recipients (user_id, page_id, recipient_psid);
CREATE INDEX notification_recipients_active_idx
  ON public.notification_recipients (user_id, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_recipients TO authenticated;
GRANT ALL ON public.notification_recipients TO service_role;

ALTER TABLE public.notification_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own notification recipients"
  ON public.notification_recipients
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_notification_recipients_updated
  BEFORE UPDATE ON public.notification_recipients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
