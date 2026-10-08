import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const listSchema = z.object({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(5),
  search: z.string().max(200).optional().default(""),
  withAnswer: z.boolean().default(false),
});

/** Liste paginée : par défaut les 5 premières questions, sans les réponses. */
export const listKnowledge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => listSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const cols = data.withAnswer
      ? "id,question,answer,category,source,is_verified,usage_count,created_at"
      : "id,question,category,source,is_verified,usage_count,created_at";
    let query = context.supabase
      .from("ai_knowledge")
      .select(cols, { count: "exact" })
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);
    if (data.search.trim()) query = query.ilike("question", `%${data.search.trim()}%`);
    const { data: rows, error, count } = await query;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as any[], total: count ?? 0 };
  });

const updateSchema = z.object({
  id: z.string().uuid(),
  question: z.string().min(2).max(300).optional(),
  answer: z.string().min(2).max(1200).optional(),
  is_verified: z.boolean().optional(),
});

export const updateKnowledge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => updateSchema.parse(input))
  .handler(async ({ data, context }) => {
    const patch: {
      question?: string;
      question_norm?: string;
      answer?: string;
      is_verified?: boolean;
    } = {};
    if (data.question !== undefined) {
      patch.question = data.question;
      patch.question_norm = data.question
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    if (data.answer !== undefined) patch.answer = data.answer;
    if (data.is_verified !== undefined) patch.is_verified = data.is_verified;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await context.supabase
      .from("ai_knowledge")
      .update(patch)
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Supprime la question ET sa réponse (même ligne) : aucune connaissance orpheline. */
export const deleteKnowledge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("ai_knowledge")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const createSchema = z.object({
  question: z.string().min(2).max(300),
  answer: z.string().min(2).max(1200),
  is_verified: z.boolean().default(true),
});

export const createKnowledge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => createSchema.parse(input))
  .handler(async ({ data, context }) => {
    const norm = data.question
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const { error } = await context.supabase.from("ai_knowledge").insert({
      user_id: context.userId,
      question: data.question,
      question_norm: norm,
      answer: data.answer,
      source: "admin",
      confidence: 1,
      is_verified: data.is_verified,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ------------------------- Contact Admin (secours) ------------------------ */

/** Contact donné au client quand la Mini IA ne trouve pas de réponse fiable. */
export const getAdminContactSetting = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("settings")
      .select("admin_contact")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { admin_contact: (data as any)?.admin_contact ?? "" };
  });

export const setAdminContactSetting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ admin_contact: z.string().max(300) }).parse(input))
  .handler(async ({ data, context }) => {
    const value = data.admin_contact.trim();
    const { error } = await context.supabase
      .from("settings")
      .upsert({ user_id: context.userId, admin_contact: value || null } as any, {
        onConflict: "user_id",
      });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Interrupteur : réponse automatique de secours de la Mini IA. */
export const getFallbackEnabled = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("settings")
      .select("mini_ia_fallback_enabled")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { enabled: (data as any)?.mini_ia_fallback_enabled !== false };
  });

export const setFallbackEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ enabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("settings")
      .upsert({ user_id: context.userId, mini_ia_fallback_enabled: data.enabled } as any, {
        onConflict: "user_id",
      });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Questions en attente : celles que la Mini IA n'a pas su traiter. */
export const listPendingRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("ai_pending_requests")
      .select("id,question,request_type,status,retry_count,created_at,processed_at")
      .eq("user_id", context.userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/**
 * Rétro-importation : reprend les anciennes discussions déjà enregistrées
 * (messages privés + commentaires) et les ajoute à la mémoire de la Mini IA.
 */
export const importPastConversations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { learnKnowledge } = await import("./mini-ia.server");
    let imported = 0;

    // --- messages privés : question du client -> réponse de l'IA ---
    const { data: msgs } = await context.supabase
      .from("messages_log")
      .select("page_id,sender_id,direction,content,ai_response,created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true })
      .limit(3000);

    const lastQuestion = new Map<string, string>();
    for (const row of (msgs ?? []) as any[]) {
      const key = `${row.page_id}:${row.sender_id}`;
      const text = String(row.content ?? "").trim();
      if (row.direction === "incoming") {
        if (text) lastQuestion.set(key, text);
        continue;
      }
      const answer = String(row.ai_response ?? row.content ?? "").trim();
      const question = lastQuestion.get(key);
      if (!question || !answer) continue;
      lastQuestion.delete(key);
      await learnKnowledge({
        userId: context.userId,
        question,
        answer,
        source: "import:message",
        category: "message",
        pageId: row.page_id ?? null,
      });
      imported++;
    }

    // --- commentaires : commentaire du client -> réponse de l'IA ---
    const { data: comments } = await context.supabase
      .from("comments_log")
      .select("page_id,content,ai_response")
      .eq("user_id", context.userId)
      .not("ai_response", "is", null)
      .order("created_at", { ascending: true })
      .limit(2000);

    for (const row of (comments ?? []) as any[]) {
      const question = String(row.content ?? "").trim();
      const answer = String(row.ai_response ?? "").trim();
      if (!question || !answer) continue;
      await learnKnowledge({
        userId: context.userId,
        question,
        answer,
        source: "import:comment",
        category: "comment",
        pageId: row.page_id ?? null,
      });
      imported++;
    }

    return { imported };
  });

/** Traite immédiatement les questions en attente de l'utilisateur connecté. */
export const processPendingNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { processPendingMessages, processPendingComments } =
      await import("@/lib/ai-engine.server");
    const countPending = async () => {
      const { count } = await context.supabase
        .from("ai_pending_requests")
        .select("id", { count: "exact", head: true })
        .eq("user_id", context.userId)
        .eq("status", "pending");
      return count ?? 0;
    };
    const before = await countPending();
    const messages = await processPendingMessages(context.userId, 50).catch(() => 0);
    const comments = await processPendingComments(context.userId, 50).catch(() => 0);
    const remaining = await countPending();
    const closed = Math.max(0, before - remaining - messages - comments);
    return { messages, comments, closed, remaining };
  });

/** Supprime toutes les questions en attente de l'utilisateur connecté. */
export const deleteAllPending = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error, count } = await supabaseAdmin
      .from("ai_pending_requests")
      .delete({ count: "exact" })
      .eq("user_id", context.userId)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return { deleted: count ?? 0 };
  });
