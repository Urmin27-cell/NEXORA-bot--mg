/**
 * MINI IA — système intelligent de mémoire + secours.
 *
 * Module ADDITIF : il n'enlève rien à la logique existante.
 *  - mémorise automatiquement les couples question/réponse validés,
 *  - répond à la place de l'IA principale quand elle est indisponible (quota, 429…),
 *  - n'invente JAMAIS de réponse : sinon un message de secours aléatoire,
 *  - met les commentaires non répondus en file d'attente ("pending").
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeQuestion, limitToThreeSentences } from "./gemini-quota.server";

/** Seuil de confiance pour répondre directement (knowledge vérifiée). */
const HIGH_THRESHOLD = Number(process.env["MINI_AI_CONFIDENCE_THRESHOLD"] ?? "") || 0.72;
/** Seuil plus souple utilisé uniquement en mode secours (IA principale HS). */
const FALLBACK_THRESHOLD = 0.5;

export const PRIVATE_FALLBACKS = [
  "Azafady, andraso kely aloha fa mbola jerena tsara ny fanontanianao; raha tena maika kosa dia afaka mifandray mivantana amin'ny Admin ianao.",
  "Misaotra anao tamin'ny fanontaniana, omeo fotoana fohy izahay hanamarinana azy; raha mila valiny haingana ianao dia afaka miantso na mifandray amin'ny Admin.",
  "Azafady mba andraso kely, mbola mila fanamarinana fanampiny ity fanontaniana ity; raha maika dia aza misalasala manatona mivantana ny Admin.",
  "Voaray tsara ny hafatrao, saingy mila fotoana kely izahay hijerena ny valiny marina; raha tena maika dia mifandraisa avy hatrany amin'ny Admin.",
  "Mbola karakaraina ny fangatahanao, ka mangataka faharetana kely izahay; raha mila fanampiana maika ianao dia afaka mifandray mivantana amin'ny Admin.",
  "Azafady, omeo fotoana kely izahay hanomezana valiny marina; raha misy fahamaikana dia afaka miantso mivantana ny Admin ianao.",
  "Voaray ny fanontanianao ary mbola eo am-panamarinana izahay; raha tsy afaka miandry ianao dia mifandraisa amin'ny Admin mba hahazoana fanampiana haingana.",
  "Mankasitraka ny faharetanao izahay, mila fotoana fohy hijerena tsara ity fangatahanao ity; raha maika dia azonao ifandraisana mivantana ny Admin.",
  "Azafady mba andraso vetivety fa mbola hamarinina ny vaovao ilaina; raha tena maika ny raharaha dia mifandraisa amin'ny Admin avy hatrany.",
  "Voaray tsara ny hafatrao, ary mila fotoana kely izahay hahazoana antoka fa marina ny valiny; raha maika ianao dia afaka manatona mivantana ny Admin.",
];

export const COMMENT_FALLBACKS = [
  "Misaotra tamin'ny commentaire 😊 Alefaso amin'ny Message Privé izahay fa afaka manazava bebe kokoa aminao.",
  "Misaotra anao 🙏 Raha mila fanazavana fanampiny dia manorata aminay amin'ny Message Privé.",
  "Faly izahay nahazo ny commentaire-nao 😊 Alefaso MP izahay dia hanome anao ny antsipiriany.",
  "Raha liana ianao dia afaka mandefa Message Privé aminay mba hahazoana fanazavana feno.",
  "Misaotra tamin'ny fahaliananao 😊 Manorata aminay amin'ny privé dia hojerentsika miaraka ny antsipiriany.",
  "Azonao alefa aminay amin'ny Message Privé ny fanontanianao mba hahafahanay manampy anao bebe kokoa.",
  "Mankasitraka ny commentaire-nao izahay 🙏 Alefaso MP izahay raha mila fanazavana manokana.",
  "Raha mila antsipiriany bebe kokoa ianao dia aza misalasala mandefa Message Privé aminay.",
  "Misaotra anao 😊 Alefaso amin'ny privé ny hafatrao dia afaka manazava bebe kokoa momba izany izahay.",
  "Ho mora kokoa ny hanomezana anao ny antsipiriany amin'ny Message Privé, ka afaka manoratra aminay ianao.",
];

export function pickFallback(kind: "comment" | "private"): string {
  const list = kind === "comment" ? COMMENT_FALLBACKS : PRIVATE_FALLBACKS;
  return list[Math.floor(Math.random() * list.length)]!;
}

/** Contact de l'Admin donné au client quand la Mini IA ne trouve pas de réponse fiable. */
export async function getAdminContact(userId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("settings")
      .select("admin_contact")
      .eq("user_id", userId)
      .maybeSingle();
    const c = String((data as any)?.admin_contact ?? "").trim();
    return c ? c : null;
  } catch {
    return null;
  }
}

/**
 * Message de secours : on fait patienter le client, on lui donne le contact
 * de l'Admin s'il est pressé, et la question reste en file d'attente.
 */
export async function buildFallbackMessage(
  userId: string,
  kind: "comment" | "private",
): Promise<string> {
  const base = pickFallback(kind);
  const contact = await getAdminContact(userId);
  if (!contact) return base;
  return `${base}\nContact Admin : ${contact}`;
}

/* ------------------------------------------------------------ matching --- */

const STOP_WORDS = new Set([
  "ny",
  "ary",
  "dia",
  "fa",
  "no",
  "ve",
  "aho",
  "ianao",
  "izy",
  "amin",
  "amina",
  "mba",
  "azafady",
  "le",
  "la",
  "les",
  "de",
  "du",
  "des",
  "un",
  "une",
  "et",
  "est",
  "ce",
  "que",
  "qui",
  "pour",
  "the",
  "a",
  "an",
  "is",
  "of",
  "to",
  "for",
  "how",
  "what",
]);

function tokens(text: string): string[] {
  return normalizeQuestion(text)
    .split(" ")
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function bigrams(text: string): Set<string> {
  const s = normalizeQuestion(text).replace(/\s+/g, " ");
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Similarité 0..1 entre deux questions.
 * On ne cherche PAS une question identique : dès qu'un mot-clé important de la
 * question du client se retrouve dans une question mémorisée, le score monte
 * (recouvrement / containment), ce qui permet de retrouver la réponse la plus
 * proche même si la phrase est formulée autrement.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeQuestion(a);
  const nb = normalizeQuestion(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = tokens(na);
  const tb = new Set(tokens(nb));
  const wordScore = jaccard(new Set(ta), tb);
  const charScore = jaccard(bigrams(na), bigrams(nb));

  // Recouvrement pondéré : les mots longs (donc informatifs) pèsent plus que
  // les petits mots courants.
  const weight = (w: string) => (w.length >= 6 ? 3 : w.length >= 4 ? 2 : 1);
  let covered = 0;
  let total = 0;
  for (const w of new Set(ta)) {
    const wt = weight(w);
    total += wt;
    if (tb.has(w)) {
      covered += wt;
      continue;
    }
    for (const x of tb) {
      if (w.length >= 4 && (x.startsWith(w) || w.startsWith(x))) {
        covered += wt * 0.8;
        break;
      }
    }
  }
  const coverage = total ? Math.min(1, covered / total) : 0;
  // Une question mémorisée beaucoup plus longue est moins ciblée.
  const lengthPenalty = Math.min(1, (new Set(ta).size + 2) / (tb.size + 2));

  return Math.max(
    wordScore * 0.6 + charScore * 0.4,
    charScore * 0.8,
    coverage * 0.95 * (0.6 + 0.4 * lengthPenalty),
    coverage * 0.7 + charScore * 0.3,
  );
}

export type KnowledgeHit = {
  id: string;
  question: string;
  answer: string;
  score: number;
  is_verified: boolean;
};

/** Mots-clés significatifs utilisés pour pré-filtrer la mémoire côté base. */
function keywords(question: string): string[] {
  return [...new Set(tokens(question).filter((w) => w.length >= 3))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);
}

/** Cherche la réponse mémorisée la plus proche (par mots-clés) pour ce propriétaire. */
export async function miniAiLookup(
  userId: string,
  question: string,
  opts: { verifiedOnly?: boolean; threshold?: number } = {},
): Promise<KnowledgeHit | null> {
  const q = (question ?? "").trim();
  if (!q || q.length < 2) return null;
  const threshold = opts.threshold ?? HIGH_THRESHOLD;
  try {
    const base = () => {
      let query = supabaseAdmin
        .from("ai_knowledge")
        .select("id,question,answer,is_verified,usage_count")
        .eq("user_id", userId);
      if (opts.verifiedOnly) query = query.eq("is_verified", true);
      return query;
    };

    const kws = keywords(q);
    const rows: any[] = [];
    // 1. Candidats contenant au moins un mot-clé de la question du client.
    if (kws.length) {
      const orFilter = kws.map((k) => `question_norm.ilike.%${k.replace(/[,%]/g, "")}%`).join(",");
      const { data } = await base()
        .or(orFilter)
        .order("usage_count", { ascending: false })
        .limit(600);
      rows.push(...((data ?? []) as any[]));
    }
    // 2. Complément : les entrées les plus utilisées (filet de sécurité).
    if (rows.length < 50) {
      const { data } = await base().order("usage_count", { ascending: false }).limit(400);
      for (const r of (data ?? []) as any[]) {
        if (!rows.some((x) => x.id === r.id)) rows.push(r);
      }
    }

    let best: KnowledgeHit | null = null;
    let bestUsage = 0;
    for (const row of rows) {
      let score = similarity(q, row.question ?? "");
      // Une réponse validée par l'Admin est prioritaire à score comparable.
      if (row.is_verified) score = Math.min(1, score + 0.06);
      if (score >= threshold && (!best || score > best.score)) {
        best = {
          id: row.id,
          question: row.question,
          answer: row.answer,
          score,
          is_verified: Boolean(row.is_verified),
        };
        bestUsage = Number(row.usage_count ?? 0);
      }
    }
    if (best) {
      await supabaseAdmin
        .from("ai_knowledge")
        .update({ usage_count: bestUsage + 1 })
        .eq("id", best.id);
      return { ...best, answer: limitToThreeSentences(best.answer) };
    }
    return null;
  } catch (e) {
    console.warn("[mini-ia] lookup failed", e instanceof Error ? e.message : e);
    return null;
  }
}

export { FALLBACK_THRESHOLD };

/* ------------------------------------------------------------ learning --- */

/** Adresse e-mail ou numéro de téléphone : jamais mémorisé. */
const PERSONAL_RE = /(\+?\d[\d\s.-]{8,}\d|@[a-z0-9._-]+\.[a-z]{2,})/i;

/** Retire les balises techniques [[...]] laissées par l'IA pour ne garder que le texte client. */
export function stripTechnicalBlocks(text: string): string {
  return (text ?? "")
    .replace(/\[\[[\s\S]*?\]\]/g, " ")
    .replace(/\[\[?\s*[A-Z_]+\s*:[\s\S]*$/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Un couple question/réponse est-il mémorisable ?
 * Règle volontairement large : TOUTE discussion client est apprise
 * (même « Bonjour »), sauf données personnelles ou message de secours.
 */
export function isSafeKnowledge(question: string, answer: string): boolean {
  const q = (question ?? "").trim();
  const a = stripTechnicalBlocks(answer);
  if (q.length < 2 || q.length > 300) return false;
  if (a.length < 2 || a.length > 1200) return false;
  if (PERSONAL_RE.test(q) || PERSONAL_RE.test(a)) return false;
  if ([...PRIVATE_FALLBACKS, ...COMMENT_FALLBACKS].some((f) => a.startsWith(f))) return false;
  return true;
}

/** Mémorise (ou rafraîchit) une connaissance. Non vérifiée tant que l'Admin ne l'a pas validée. */
export async function learnKnowledge(opts: {
  userId: string;
  question: string;
  answer: string;
  source?: string;
  category?: string;
  pageId?: string | null;
}): Promise<void> {
  try {
    const { userId, question } = opts;
    const answer = stripTechnicalBlocks(opts.answer);
    if (!isSafeKnowledge(question, answer)) return;
    const norm = normalizeQuestion(question);
    if (!norm) return;
    const { data: existing } = await supabaseAdmin
      .from("ai_knowledge")
      .select("id")
      .eq("user_id", userId)
      .eq("question_norm", norm)
      .maybeSingle();
    if (existing?.id) {
      await supabaseAdmin
        .from("ai_knowledge")
        .update({ answer: limitToThreeSentences(answer).slice(0, 1200) })
        .eq("id", existing.id);
      return;
    }
    await supabaseAdmin.from("ai_knowledge").insert({
      user_id: userId,
      question: question.trim().slice(0, 300),
      question_norm: norm,
      answer: limitToThreeSentences(answer).slice(0, 1200),
      source: opts.source ?? "ai",
      category: opts.category ?? "general",
      page_id: opts.pageId ?? null,
      confidence: 0.6,
    });
  } catch (e) {
    console.warn("[mini-ia] learn failed", e instanceof Error ? e.message : e);
  }
}

/* ------------------------------------------------------------- pending --- */

export async function queuePendingRequest(opts: {
  userId: string;
  question: string;
  requestType: "comment" | "message";
  commentId?: string | null;
  postId?: string | null;
  pageId?: string | null;
  clientId?: string | null;
  conversationId?: string | null;
}): Promise<void> {
  try {
    const question = (opts.question ?? "").slice(0, 2000);
    if (!question.trim()) return;

    // Pas de contrainte unique en base : on vérifie nous-mêmes les doublons.
    let dupQuery = supabaseAdmin
      .from("ai_pending_requests")
      .select("id")
      .eq("user_id", opts.userId)
      .eq("status", "pending")
      .eq("request_type", opts.requestType)
      .limit(1);
    if (opts.requestType === "comment" && opts.commentId) {
      dupQuery = dupQuery.eq("comment_id", opts.commentId);
    } else {
      dupQuery = dupQuery.eq("question", question);
      if (opts.conversationId) dupQuery = dupQuery.eq("conversation_id", opts.conversationId);
    }
    const { data: dup } = await dupQuery;
    if (dup && dup.length > 0) return;

    const { error } = await supabaseAdmin.from("ai_pending_requests").insert({
      user_id: opts.userId,
      question,
      request_type: opts.requestType,
      comment_id: opts.commentId ?? null,
      post_id: opts.postId ?? null,
      page_id: opts.pageId ?? null,
      client_id: opts.clientId ?? null,
      conversation_id: opts.conversationId ?? null,
      status: "pending",
    });
    if (error) console.warn("[mini-ia] queue pending insert error", error.message);
  } catch (e) {
    console.warn("[mini-ia] queue pending failed", e instanceof Error ? e.message : e);
  }
}

export async function markPendingProcessed(id: string, response: string): Promise<void> {
  await supabaseAdmin
    .from("ai_pending_requests")
    .update({
      status: "processed",
      response: (response ?? "").slice(0, 4000),
      processed_at: new Date().toISOString(),
    })
    .eq("id", id);
}
