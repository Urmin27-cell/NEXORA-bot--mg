import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const getPushState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [tokens, settings] = await Promise.all([
      context.supabase
        .from("push_tokens")
        .select("id,token,enabled,user_agent,created_at")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false }),
      context.supabase
        .from("push_settings")
        .select("auto_ai_enabled")
        .eq("user_id", context.userId)
        .maybeSingle(),
    ]);
    return {
      devices: (tokens.data ?? []).map((t) => ({
        id: t.id,
        enabled: t.enabled,
        user_agent: t.user_agent,
        created_at: t.created_at,
        token_preview: `${(t.token ?? "").slice(0, 10)}…`,
      })),
      autoAiEnabled: settings.data?.auto_ai_enabled ?? true,
    };
  });

export const savePushToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ token: z.string().min(20).max(4000), user_agent: z.string().max(300).optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("push_tokens").upsert(
      {
        user_id: context.userId,
        token: data.token,
        user_agent: data.user_agent ?? null,
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "token" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setAutoAiPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("push_settings").upsert(
      {
        user_id: context.userId,
        auto_ai_enabled: data.enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const removePushDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("push_tokens")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const sendTestPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("push_tokens")
      .select("token")
      .eq("user_id", context.userId)
      .eq("enabled", true);
    if (error) throw new Error(error.message);
    const tokens = (data ?? []).map((t) => t.token).filter(Boolean);
    if (tokens.length === 0) throw new Error("Aucun appareil enregistré pour les notifications.");

    const { generateAiPushMessage, sendPushToTokens } = await import("@/lib/push-notify.server");
    const message = await generateAiPushMessage();
    const result = await sendPushToTokens(tokens, message);
    return { ...result, message };
  });
