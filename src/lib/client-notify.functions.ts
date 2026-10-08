import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/** Liste des destinataires enregistrés + pages Facebook disponibles. */
export const listNotificationRecipients = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [rowsRes, pagesRes] = await Promise.all([
      context.supabase
        .from("notification_recipients")
        .select(
          "id,page_id,recipient_psid,label,is_active,notify_quota,notify_orders,last_quota_notified_at,last_order_notified_at,created_at",
        )
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false }),
      context.supabase
        .from("facebook_pages")
        .select("page_id,page_name")
        .eq("user_id", context.userId)
        .eq("is_connected", true),
    ]);
    if (rowsRes.error) throw new Error(rowsRes.error.message);
    return {
      rows: (rowsRes.data ?? []) as any[],
      pages: (pagesRes.data ?? []) as Array<{ page_id: string; page_name: string }>,
    };
  });

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  page_id: z.string().min(1).max(100),
  recipient_psid: z.string().min(3).max(100),
  label: z.string().max(120).optional().default(""),
  is_active: z.boolean().default(true),
  notify_quota: z.boolean().default(true),
  notify_orders: z.boolean().default(true),
});

export const saveNotificationRecipient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => upsertSchema.parse(input))
  .handler(async ({ data, context }) => {
    const payload = {
      user_id: context.userId,
      page_id: data.page_id.trim(),
      recipient_psid: data.recipient_psid.trim(),
      label: data.label.trim() || null,
      is_active: data.is_active,
      notify_quota: data.notify_quota,
      notify_orders: data.notify_orders,
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("notification_recipients")
        .update(payload)
        .eq("id", data.id)
        .eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { ok: true, id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("notification_recipients")
      .upsert(payload, { onConflict: "user_id,page_id,recipient_psid" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, id: row.id };
  });

export const toggleNotificationRecipient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), is_active: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("notification_recipients")
      .update({ is_active: data.is_active })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteNotificationRecipient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("notification_recipients")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testNotificationRecipient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { sendTestNotification } = await import("@/lib/client-notify.server");
    return sendTestNotification(context.userId, data.id);
  });
