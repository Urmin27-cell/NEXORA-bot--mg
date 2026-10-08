import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function fetchFbName(
  senderId: string,
  pageToken: string,
  pageId?: string,
): Promise<string | null> {
  if (!senderId || !pageToken) return null;

  // 1. Preferred: resolve the participant name through the Page conversations edge.
  if (pageId) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${pageId}/conversations?user_id=${encodeURIComponent(
          senderId,
        )}&fields=participants&limit=1&access_token=${pageToken}`,
      );
      if (res.ok) {
        const data: any = await res.json();
        const participants: any[] = data?.data?.[0]?.participants?.data ?? [];
        const match =
          participants.find((p) => String(p?.id) === String(senderId)) ??
          participants.find((p) => String(p?.id) !== String(pageId));
        const name = (match?.name || "").trim();
        if (name && name !== senderId) return name;
      }
    } catch {}
  }

  // 2. Fallback: direct lookup (works for some PSIDs / tokens).
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${senderId}?fields=name,first_name,last_name&access_token=${pageToken}`,
    );
    if (res.ok) {
      const data: any = await res.json();
      const name =
        data.name || [data.first_name, data.last_name].filter(Boolean).join(" ").trim() || null;
      return name && name !== senderId ? name : null;
    }
  } catch {}
  return null;
}

/** List distinct conversations (grouped by page_id + sender_id) from messages_log */
export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("messages_log")
      .select("page_id,sender_id,sender_name,content,ai_response,direction,created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const map = new Map<string, any>();
    for (const r of data ?? []) {
      if (!r.sender_id || !r.page_id) continue;
      const key = `${r.page_id}::${r.sender_id}`;
      const realName = r.sender_name && r.sender_name !== r.sender_id ? r.sender_name : null;
      if (!map.has(key)) {
        map.set(key, {
          page_id: r.page_id,
          client_fb_id: r.sender_id,
          client_fb_name: realName,
          last_message: r.content ?? r.ai_response ?? "",
          last_at: r.created_at,
          last_direction: r.direction,
          unread: r.direction === "incoming",
        });
      } else if (!map.get(key).client_fb_name && realName) {
        map.get(key).client_fb_name = realName;
      }
    }
    const list = Array.from(map.values());

    // Resolve real Facebook names for conversations that still have none.
    const missing = list.filter((c) => !c.client_fb_name).slice(0, 25);
    if (missing.length > 0) {
      const { data: pages } = await context.supabase
        .from("facebook_pages")
        .select("page_id,page_access_token")
        .eq("user_id", context.userId);
      const tokens = new Map((pages ?? []).map((p: any) => [p.page_id, p.page_access_token]));
      await Promise.all(
        missing.map(async (c) => {
          const token = tokens.get(c.page_id);
          if (!token) return;
          const name = await fetchFbName(c.client_fb_id, token, c.page_id);
          if (!name) return;
          c.client_fb_name = name;
          // Backfill every past row of this conversation.
          await context.supabase
            .from("messages_log")
            .update({ sender_name: name })
            .eq("user_id", context.userId)
            .eq("page_id", c.page_id)
            .eq("sender_id", c.client_fb_id);
        }),
      );
    }

    for (const c of list) {
      if (!c.client_fb_name) c.client_fb_name = c.client_fb_id;
    }

    // Attach IA state
    const { data: states } = await context.supabase
      .from("client_ia_state")
      .select("*")
      .eq("user_id", context.userId);
    const stateMap = new Map(
      (states ?? []).map((s: any) => [`${s.page_id}::${s.client_fb_id}`, s.ia_stopped]),
    );
    return list.map((c) => ({
      ...c,
      ia_stopped: stateMap.get(`${c.page_id}::${c.client_fb_id}`) ?? false,
    }));
  });

export const listConversationMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ page_id: z.string(), client_fb_id: z.string() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("messages_log")
      .select("*")
      .eq("page_id", data.page_id)
      .eq("sender_id", data.client_fb_id)
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true })
      .limit(300);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const sendDiscussionMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        page_id: z.string(),
        client_fb_id: z.string(),
        text: z.string().min(1).max(4000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // Get page token
    const { data: page } = await context.supabase
      .from("facebook_pages")
      .select("page_id,page_access_token,page_name")
      .eq("page_id", data.page_id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!page?.page_access_token) throw new Error("Page introuvable ou token manquant");

    const res = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${page.page_access_token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipient: { id: data.client_fb_id },
          message: { text: data.text },
          messaging_type: "RESPONSE",
        }),
      },
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Facebook: ${res.status} ${t.slice(0, 200)}`);
    }
    await context.supabase.from("messages_log").insert({
      user_id: context.userId,
      page_id: data.page_id,
      sender_id: data.client_fb_id,
      direction: "outgoing",
      content: data.text,
      status: "sent",
    });
    return { ok: true };
  });

/** Send an image or a voice note directly to the client on Messenger. */
export const sendDiscussionAttachment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        page_id: z.string(),
        client_fb_id: z.string(),
        kind: z.enum(["image", "audio"]),
        filename: z.string().min(1).max(200),
        content_type: z.string().min(1).max(100),
        data_base64: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: page } = await context.supabase
      .from("facebook_pages")
      .select("page_id,page_access_token")
      .eq("page_id", data.page_id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!page?.page_access_token) throw new Error("Page introuvable ou token manquant");

    const buffer = Buffer.from(data.data_base64, "base64");
    if (buffer.length === 0) throw new Error("Fichier vide");
    if (buffer.length > 20 * 1024 * 1024) throw new Error("Fichier trop volumineux (max 20 Mo)");

    const blob = new Blob([buffer as unknown as BlobPart], { type: data.content_type });
    const form = new FormData();
    form.append("recipient", JSON.stringify({ id: data.client_fb_id }));
    form.append(
      "message",
      JSON.stringify({ attachment: { type: data.kind, payload: { is_reusable: false } } }),
    );
    form.append("filedata", blob, data.filename);
    form.append("messaging_type", "RESPONSE");

    const res = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${page.page_access_token}`,
      { method: "POST", body: form },
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Facebook: ${res.status} ${t.slice(0, 200)}`);
    }

    // Keep a copy in storage so the admin can see what was sent.
    let mediaUrl: string | null = null;
    try {
      const { uploadMediaFile } = await import("@/lib/storage-helper.server");
      mediaUrl = await uploadMediaFile({
        userId: context.userId,
        bucket: "post-images",
        fileName: data.filename.replace(/[^\w.-]/g, "_"),
        contentType: data.content_type,
        buffer,
      });
    } catch (e) {
      console.warn("[sendDiscussionAttachment] storage copy failed", e);
    }

    await context.supabase.from("messages_log").insert({
      user_id: context.userId,
      page_id: data.page_id,
      sender_id: data.client_fb_id,
      direction: "outgoing",
      content: data.kind === "image" ? "[Image envoyée]" : "[Message vocal envoyé]",
      media_type: data.kind,
      media_url: mediaUrl,
      status: "sent",
    });
    return { ok: true, media_url: mediaUrl };
  });
