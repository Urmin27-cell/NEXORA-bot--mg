import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/* ---------------- Fichiers attachés aux prompts IA ----------------
 * Ces fichiers (pdf, image, audio, vidéo) peuvent être envoyés
 * automatiquement par l'IA en message privé quand un client les demande.
 * ------------------------------------------------------------------ */

const PROMPT_FILES_BUCKET = "prompt-files";

function detectMediaType(mime: string): "image" | "video" | "audio" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

export const listPromptFiles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("prompt_files")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const uploadSchema = z.object({
  prompt_id: z.string().uuid().nullable().optional(),
  label: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  filename: z.string().min(1).max(200),
  mime_type: z.string().min(1).max(120),
  data_base64: z.string().min(1),
});

export const uploadPromptFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => uploadSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const safeName = data.filename.replace(/[^\w.-]/g, "_");
    const objectPath = `${context.userId}/${Date.now()}-${safeName}`;
    const buffer = Buffer.from(data.data_base64, "base64");
    if (buffer.length === 0) throw new Error("Fichier vide");
    if (buffer.length > 50 * 1024 * 1024) throw new Error("Fichier trop volumineux (max 50 Mo)");

    const { error: upErr } = await supabaseAdmin.storage
      .from(PROMPT_FILES_BUCKET)
      .upload(objectPath, buffer, { contentType: data.mime_type, upsert: true });
    if (upErr) throw new Error(upErr.message);

    const { data: row, error } = await context.supabase
      .from("prompt_files")
      .insert({
        user_id: context.userId,
        prompt_id: data.prompt_id ?? null,
        label: data.label.trim(),
        description: data.description?.trim() || null,
        media_type: detectMediaType(data.mime_type),
        mime_type: data.mime_type,
        file_path: objectPath,
        size_bytes: buffer.length,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updatePromptFileSale = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        is_for_sale: z.boolean(),
        price: z.number().min(0).max(1_000_000_000).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("prompt_files")
      .update({ is_for_sale: data.is_for_sale, price: data.is_for_sale ? data.price : null })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deletePromptFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("prompt_files")
      .select("file_path")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();

    if (row?.file_path) {
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin.storage.from(PROMPT_FILES_BUCKET).remove([row.file_path]);
      } catch (e) {
        console.warn("[deletePromptFile] storage remove warning:", e);
      }
    }

    const { error } = await context.supabase
      .from("prompt_files")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
