import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateAiReply, sendMessengerReply } from "@/lib/ai-engine.server";

export type ModerationResult = {
  violation: boolean;
  reason: string;
  action: "none" | "warned" | "banned";
  offenses: number;
};

const LINK_RE =
  /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|fr|mg|io|me|xyz|shop|store|link|biz|info|ru|top)\b|t\.me\/|wa\.me\/|bit\.ly)/i;

const SPAM_RE =
  /\b(vidio\s*porno|porno|sex|casino|paris sportif|bet(ting)?|crypto|forex|investissement rapide|gagner de l'argent|mividy|mivarotra amidy|promo(tion)? ho an'ny|whatsapp\s*\+?\d{6,}|inbox me|dm me)\b/i;

/** Obvious insults, caught without spending any AI quota. */
const INSULT_RE =
  /\b(adala|adaladala|bado|jiolahy|mpangalatra|mpisoloky|kinga|vulgaire|conn?ard|connasse|salaud|salope|encul|merde|putain|idiot|imbecile|imbécile|stupide|voleur|arnaqueur|escroc|fuck|shit|bitch|asshole|bete|bête)\b/i;

/** Quick deterministic pre-check: links, spam and insults are always violations.
 *  It runs first so most comments never cost an AI moderation call. */
function quickCheck(content: string): string | null {
  const text = (content ?? "").trim();
  if (!text) return null;
  if (LINK_RE.test(text)) return "lien / publicité";
  if (SPAM_RE.test(text)) return "contenu publicitaire ou inapproprié";
  if (INSULT_RE.test(text)) return "propos insultants";
  return null;
}

/** Comments shorter than this are handled by the deterministic checks only:
 *  spending an AI call on "Salama", "Ohatrinona ?" or an emoji wastes quota. */
const AI_MODERATION_MIN_LENGTH = 30;

/** Ask the AI to classify a comment. Returns a reason when it is abusive. */
async function aiCheck(userId: string, content: string): Promise<string | null> {
  const text = (content ?? "").trim();
  if (!text) return null;
  if (text.length < AI_MODERATION_MIN_LENGTH) return null;
  try {
    const systemPrompt =
      "Tu es un modérateur de page Facebook professionnelle. Tu analyses UN commentaire et tu réponds " +
      "en UNE seule ligne, exactement dans l'un de ces deux formats :\n" +
      "VERDICT: OK\n" +
      "VERDICT: VIOLATION | <raison courte>\n" +
      "Est une VIOLATION : insulte, attaque, propos négatifs/haineux envers la page ou les personnes, " +
      "arnaque, publicité pour un autre produit/page, lien externe, spam, contenu sexuel ou illégal.\n" +
      "N'est PAS une violation : question, critique polie, avis neutre, félicitation, demande de prix.";
    const { text: raw } = await generateAiReply({
      shortReply: false,
      userId,
      systemPrompt,
      parts: [{ text: `Commentaire :\n"""${text}"""` }],
      allowLinks: false,
    });
    const line = (raw ?? "").toUpperCase();
    if (line.includes("VIOLATION")) {
      const reason = (raw.split("|")[1] ?? "").trim();
      return reason || "commentaire inapproprié";
    }
    return null;
  } catch (e) {
    console.warn("[moderation] ai check failed", e instanceof Error ? e.message : e);
    return null;
  }
}

async function deleteComment(pageToken: string, commentId: string) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${commentId}?access_token=${pageToken}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(`Delete comment ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
}

async function banFromPage(pageToken: string, pageId: string, userId: string) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${pageId}/blocked?access_token=${pageToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: userId }),
    },
  );
  if (!res.ok) {
    throw new Error(`Ban user ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
}

/** Post a public comment on the post that mentions the offender. */
async function postWarningOnPost(
  pageToken: string,
  postId: string,
  authorId: string,
  authorName: string | null,
  message: string,
) {
  const mention = authorId ? `@[${authorId}]` : (authorName ?? "");
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${postId}/comments?access_token=${pageToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: `${mention} ${message}`.trim() }),
    },
  );
  if (!res.ok) {
    // Mentions are not always allowed: fall back to the plain name.
    await fetch(`https://graph.facebook.com/v21.0/${postId}/comments?access_token=${pageToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: `${authorName ?? ""} ${message}`.trim() }),
    });
  }
}

/**
 * Analyse one incoming comment. On violation the comment is deleted; the first
 * time the author is publicly mentioned and warned, the second time the author
 * is blocked from the page (can no longer see it or message it).
 */
export async function moderateComment(
  page: any,
  input: {
    commentId: string;
    postId: string;
    authorId: string;
    authorName: string | null;
    content: string;
  },
): Promise<ModerationResult> {
  const none: ModerationResult = { violation: false, reason: "", action: "none", offenses: 0 };
  const { commentId, postId, authorId, authorName, content } = input;
  if (!commentId || !authorId || authorId === page.page_id) return none;

  const reason = quickCheck(content) ?? (await aiCheck(page.user_id, content));
  if (!reason) return none;

  // Count previous offenses for this author on this page.
  const { data: prev } = await (supabaseAdmin as any)
    .from("comment_violations")
    .select("id,offense_count,banned")
    .eq("page_id", page.page_id)
    .eq("author_id", authorId)
    .maybeSingle();

  const offenses = (prev?.offense_count ?? 0) + 1;

  try {
    await deleteComment(page.page_access_token, commentId);
  } catch (e) {
    console.warn("[moderation] delete failed", e instanceof Error ? e.message : e);
  }

  let action: ModerationResult["action"] = "warned";
  if (offenses >= 2) {
    action = "banned";
    try {
      await banFromPage(page.page_access_token, page.page_id, authorId);
    } catch (e) {
      console.warn("[moderation] ban failed", e instanceof Error ? e.message : e);
      action = "warned";
    }
  }

  const publicMessage =
    action === "banned"
      ? `Efa nomena fampitandremana ianao teo aloha. Noho ny tsy fanajana ny fitsipiky ny pejy (${reason}), voasakana tsy afaka mifandray amin'ity pejy ity intsony ianao.`
      : `Nesorina ny hevitrao noho ny tsy fanajana ny fitsipiky ny pejy (${reason}). Fampitandremana voalohany ity : raha miverina indray dia hosakanana tsy afaka hifandray amin'ny pejy intsony ianao.`;

  try {
    await postWarningOnPost(page.page_access_token, postId, authorId, authorName, publicMessage);
  } catch (e) {
    console.warn("[moderation] warning comment failed", e instanceof Error ? e.message : e);
  }

  if (action === "warned") {
    try {
      await sendMessengerReply(page.page_access_token, authorId, publicMessage);
    } catch {
      /* the author may not have an open conversation: ignore */
    }
  }

  const row = {
    user_id: page.user_id,
    page_id: page.page_id,
    author_id: authorId,
    author_name: authorName,
    offense_count: offenses,
    last_reason: reason,
    banned: action === "banned",
    updated_at: new Date().toISOString(),
  };
  if (prev?.id) {
    await (supabaseAdmin as any).from("comment_violations").update(row).eq("id", prev.id);
  } else {
    await (supabaseAdmin as any).from("comment_violations").insert(row);
  }

  console.log("[moderation]", page.page_id, authorId, action, reason);
  return { violation: true, reason, action, offenses };
}
