import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listOpenAiKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("openai_keys")
      .select("id,label,api_key,selected_model,is_active,last_used_at,error_count,disabled_until")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((k) => ({
      ...k,
      api_key: undefined,
      api_key_masked: `${k.api_key.slice(0, 5)}…${k.api_key.slice(-4)}`,
    }));
  });

export const addOpenAiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ label: z.string().min(1).max(60), api_key: z.string().min(20).max(400) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const key = data.api_key.trim();
    {
      // Une clé ne peut appartenir qu'à un seul compte NEXORA.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: dup } = await supabaseAdmin
        .from("openai_keys")
        .select("id")
        .eq("api_key", key)
        .neq("user_id", context.userId)
        .limit(1);
      if (dup && dup.length > 0) {
        throw new Error(
          "Cette clé API est déjà utilisée par un autre compte NEXORA. Chaque compte doit avoir sa propre clé.",
        );
      }
    }
    const { detectOpenAiModel } = await import("@/lib/openai.server");
    const r = await detectOpenAiModel(key);
    if (!r.ok) throw new Error(`Clé OpenAI refusée : ${r.error}`);
    const { error } = await context.supabase.from("openai_keys").insert({
      user_id: context.userId,
      label: data.label.trim(),
      api_key: key,
      selected_model: r.model,
      is_active: true,
    });
    if (error) throw new Error(error.message);
    return { model: r.model };
  });

export const testOpenAiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("openai_keys")
      .select("api_key")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .single();
    if (error || !row) throw new Error("Clé introuvable");
    const { detectOpenAiModel } = await import("@/lib/openai.server");
    const r = await detectOpenAiModel(row.api_key);
    if (!r.ok) {
      await context.supabase.from("openai_keys").update({ error_count: 1 }).eq("id", data.id);
      throw new Error(r.error);
    }
    await context.supabase
      .from("openai_keys")
      .update({ selected_model: r.model, error_count: 0, disabled_until: null })
      .eq("id", data.id);
    return { model: r.model };
  });

export const toggleOpenAiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), is_active: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await context.supabase
      .from("openai_keys")
      .update({ is_active: data.is_active })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    return { ok: true };
  });

export const deleteOpenAiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await context.supabase
      .from("openai_keys")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    return { ok: true };
  });
