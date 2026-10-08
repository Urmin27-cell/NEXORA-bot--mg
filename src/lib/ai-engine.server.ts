import {
  runManagedAiCall,
  getQuotaConfig,
  SHORT_REPLY_RULE,
  redactSecrets,
} from "./gemini-quota.server";
// Server-only AI engine: Lovable AI par défaut + rotation Gemini en fallback.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import fs from "fs";
import path from "path";

const GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Google a retiré gemini-1.5/2.0/2.5 pour les nouvelles clés API (404 "no longer available").
 * On remappe donc tout ancien nom de modèle vers un modèle encore servi.
 */
export function resolveGeminiModel(rawModel?: string | null): string {
  const m = (rawModel || "").trim().toLowerCase();
  if (!m) return GEMINI_MODEL;
  if (/gemini-(1\.5|2\.0|2\.5)/.test(m)) {
    return m.includes("pro") ? "gemini-pro-latest" : GEMINI_MODEL;
  }
  return m;
}
const LOVABLE_MODEL = "google/gemini-3.7-flash";
const INCOMING_DIRECTION = "incoming";
const OUTGOING_DIRECTION = "outgoing";
const MESSENGER_TEXT_LIMIT = 1800;

export type AiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

export type ChatTurn = { role: "user" | "assistant"; text: string };

function directionToRole(direction: string): ChatTurn["role"] {
  return direction === OUTGOING_DIRECTION || direction === "out" ? "assistant" : "user";
}

async function insertMessageLog(payload: any, label: string) {
  const { error } = await supabaseAdmin.from("messages_log").insert(payload);
  if (error) {
    console.error(`[messages_log:${label}]`, error.message);
  }
}

/** Resolve the real Facebook name of a client (PSID) through the Page conversations edge. */
export async function resolveClientName(
  pageId: string,
  pageToken: string,
  senderId: string,
): Promise<string | null> {
  if (!pageId || !pageToken || !senderId) return null;
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
      const name = String(match?.name || "").trim();
      if (name && name !== senderId) return name;
    }
  } catch (e) {
    console.warn("[resolveClientName] failed", e);
  }
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${senderId}?fields=name,first_name,last_name&access_token=${pageToken}`,
    );
    if (res.ok) {
      const data: any = await res.json();
      const name =
        data.name || [data.first_name, data.last_name].filter(Boolean).join(" ").trim() || "";
      if (name && name !== senderId) return name;
    }
  } catch {}
  return null;
}

/** Sanitize response: strip markdown but PRESERVE URLs exactly (including _ - . chars). */
export function sanitizeReply(text: string, allowLinks = false): string {
  const safeText = typeof text === "string" ? text : String(text ?? "");
  // 1. Extract URLs first so replacements below never touch them.
  const urlRegex = /(https?:\/\/[^\s<>()"']+|www\.[^\s<>()"']+)/gi;
  const urls: string[] = [];
  let t = safeText.replace(urlRegex, (m) => {
    urls.push(m);
    return `\u0000URL${urls.length - 1}\u0000`;
  });

  t = t
    .replace(/[*#`_>]+/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (allowLinks) {
    // Restore URLs exactly as the AI produced them.
    t = t.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? "");
  } else {
    t = t.replace(/\u0000URL\d+\u0000/g, "");
    t = t.replace(/[ \t]{2,}/g, " ").trim();
  }
  return t;
}

export function containsLink(text: string): boolean {
  const safeText = typeof text === "string" ? text : String(text ?? "");
  return /(https?:\/\/|www\.)/i.test(safeText);
}

function getTextFromParts(parts: AiPart[]): string {
  return parts
    .map((p) => ("text" in p ? p.text : "[sary]"))
    .join("\n")
    .trim();
}

function appendClarityInstructions(systemPrompt: string): string {
  return `${systemPrompt}

RÈGLE ABSOLUE ET STRICTE :
- Valio MIVANTANA amin'ny teny Malagasy (na Frantsay raha niteny frantsay) ny mpanjifa.
- AZA MANORATRA FANDINIHANA (thinking/scratchpad), AZA MANORATRA TENY ANGLAIS, AZA MANORATRA BROUILLON NA AUTO-ÉVALUATION (ohatra : "No markdown? Yes", "Language: ...", "Length: ...", "Expansion: ...", "Closing: ...", "Draft: ...", "Let's expand").
- Valin-teny farany vonona ho vakian'ny mpanjifa ihany no avoaka.`;
}

function looksTruncated(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return true;
  if (/[.!?…:)]$/.test(cleaned)) return false;
  return /\b(ary|fa|ka|dia|satria|raha|avec|de|du|des|et|ou|pour|par|sur|amin'ny|momba ny)$/i.test(
    cleaned,
  );
}

async function retryTruncatedReply(opts: {
  userId: string;
  systemPrompt: string;
  history: ChatTurn[];
  parts: AiPart[];
  currentReply: string;
  allowLinks?: boolean;
}): Promise<{ raw: string; provider: string } | null> {
  const retryPrompt =
    "Tohizo na avereno feno amin'ny fomba mazava sy fohy ny valiny teo aloha izay toa tapaka. Aza mampiasa teny fampidirana na fandinihana (thinking).\n\n" +
    `Valiny tapaka:\n"""${opts.currentReply}"""`;
  const retryParts: AiPart[] = [...opts.parts, { text: retryPrompt }];
  const strictPrompt = appendClarityInstructions(opts.systemPrompt);

  const { data: settings } = await supabaseAdmin
    .from("settings")
    .select("use_lovable_ai_fallback,default_model")
    .eq("user_id", opts.userId)
    .maybeSingle();
  const lovableEnabled = settings?.use_lovable_ai_fallback ?? true;
  const modelToUse = resolveGeminiModel(settings?.default_model);

  if (lovableEnabled) {
    try {
      return {
        raw: await callLovableAi(strictPrompt, opts.history, retryParts),
        provider: "lovable-ai:completed",
      };
    } catch (e) {
      console.warn("[Lovable AI retry] fallback vers Gemini:", e instanceof Error ? e.message : e);
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const key = await pickGeminiKey(opts.userId);
    if (!key) break;
    try {
      const raw = await callGemini(key.api_key, strictPrompt, opts.history, retryParts, modelToUse);
      await markKeyUsed(key.id);
      return { raw, provider: `gemini:${key.label}:completed` };
    } catch (e: any) {
      const isQuota = Boolean(
        e?.isQuota ||
        (e instanceof Error && (e.message.includes("Quota") || e.message.includes("429"))),
      );
      console.error("[Gemini retry] error", key.label, e);
      await markKeyError(key.id, key.error_count ?? 0, isQuota);
    }
  }

  return null;
}

export function splitMessengerText(text: string, maxLength = MESSENGER_TEXT_LIMIT): string[] {
  const safeText = typeof text === "string" ? text : String(text ?? "");
  const normalized = safeText.replace(/\r/g, "").trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    const breakpoints = ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "];
    let splitAt = -1;
    for (const bp of breakpoints) {
      const idx = window.lastIndexOf(bp);
      if (idx >= Math.floor(maxLength * 0.55)) {
        splitAt = idx + bp.length;
        break;
      }
    }
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

async function pickGeminiKey(userId: string) {
  const { data: keys } = await supabaseAdmin
    .from("gemini_keys")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (!keys || keys.length === 0) return null;

  const now = Date.now();
  // Filter out keys disabled_until in the future
  const available = keys.filter((k: any) => {
    if (!k.disabled_until) return true;
    return new Date(k.disabled_until).getTime() <= now;
  });

  // Never recycle paused keys in the same request path. A quota-exhausted key
  // will return the same 429 until its pause expires; selecting it again only
  // delays the Messenger reply and increments its error counter repeatedly.
  if (available.length === 0) return null;
  const listToUse = available;

  // Sort by last_used_at ascending (nulls / oldest first)
  listToUse.sort((a: any, b: any) => {
    if (!a.last_used_at && !b.last_used_at) return 0;
    if (!a.last_used_at) return -1;
    if (!b.last_used_at) return 1;
    return new Date(a.last_used_at).getTime() - new Date(b.last_used_at).getTime();
  });

  return listToUse[0] ?? null;
}

async function markKeyUsed(id: string) {
  await supabaseAdmin
    .from("gemini_keys")
    .update({ last_used_at: new Date().toISOString(), error_count: 0, disabled_until: null })
    .eq("id", id);
}

async function markKeyError(id: string, currentErrors: number, isQuota = false, isDead = false) {
  const next = currentErrors + 1;
  // Quota Google = fenêtre d'une minute -> une pause de 60 s suffit largement.
  // Une clé révoquée/supprimée chez Google (401) est mise de côté 24 h : la
  // réessayer à chaque message ne fait que retarder les réponses clients.
  let disabled: string | null = null;
  if (isDead) {
    disabled = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  } else if (isQuota) {
    disabled = new Date(Date.now() + 60 * 1000).toISOString();
  } else if (next >= 5) {
    disabled = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }
  await supabaseAdmin
    .from("gemini_keys")
    .update({ error_count: next, disabled_until: disabled })
    .eq("id", id);
}

/** Gemini may legitimately need longer than 12 seconds under load. Keep a
 * bounded network timeout for this external provider, but do not cut off valid
 * generations prematurely. */
const AI_TIMEOUT_MS = 22000;
/** Lovable AI is the default provider: cap one attempt so a slow model is
 *  abandoned quickly and the fallback answers the client without long waits. */
const LOVABLE_TIMEOUT_MS = 20000;

/** Model discovery is slow: cache it per key for 10 minutes. */
const modelDiscoveryCache = new Map<
  string,
  { at: number; value: { ok: boolean; models: string[]; error?: string } }
>();
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** Auto-detect available Gemini text/chat models dynamically from the Google Gemini API key */
export async function fetchAvailableGeminiModels(
  apiKey: string,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const cleanKey = (apiKey || "").trim();
    if (!cleanKey) {
      return { ok: false, models: [], error: "Clé API vide" };
    }
    const cached = modelDiscoveryCache.get(cleanKey);
    if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
      return cached.value;
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`,
      { signal: AbortSignal.timeout(AI_TIMEOUT_MS) },
    );
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, models: [], error: `Google API (${res.status}): ${t.slice(0, 180)}` };
    }
    const json: any = await res.json();
    const list: any[] = json.models ?? [];
    const models = list
      .filter(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes("generateContent"),
      )
      .map((m) => (typeof m.name === "string" ? m.name.replace(/^models\//, "") : ""))
      .filter((name) => {
        if (!name) return false;
        const lower = name.toLowerCase();
        // Exclude TTS, embedding, audio, imagen, and non-chat models
        if (
          lower.includes("-tts") ||
          lower.includes("embedding") ||
          lower.includes("audio") ||
          lower.includes("imagen") ||
          lower.includes("aqa")
        ) {
          return false;
        }
        return true;
      });
    const value = { ok: true, models };
    modelDiscoveryCache.set(cleanKey, { at: Date.now(), value });
    return value;
  } catch (err: any) {
    return { ok: false, models: [], error: err.message || String(err) };
  }
}

/** Safely merge conversation history into strictly alternating user/model turns for Gemini API */
function normalizeContentsForGemini(history: ChatTurn[], parts: AiPart[]) {
  const rawItems = [
    ...history.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.text || "" }],
    })),
    { role: "user", parts },
  ];

  // Filter out items with no valid text or inline_data
  const validItems = rawItems.filter((item) => {
    if (!item.parts || item.parts.length === 0) return false;
    return item.parts.some((p: any) => {
      if ("text" in p && typeof p.text === "string" && p.text.trim().length > 0) return true;
      if ("inline_data" in p && p.inline_data) return true;
      return false;
    });
  });

  if (validItems.length === 0) {
    return [{ role: "user", parts: [{ text: "(message)" }] }];
  }

  // Merge consecutive turns with the same role
  const merged: typeof validItems = [];
  for (const item of validItems) {
    if (merged.length > 0 && merged[merged.length - 1].role === item.role) {
      merged[merged.length - 1].parts.push(...item.parts);
    } else {
      merged.push({ role: item.role, parts: [...item.parts] });
    }
  }

  // Ensure first turn starts with 'user'
  if (merged.length > 0 && merged[0].role === "model") {
    merged.shift();
  }

  if (merged.length === 0) {
    return [{ role: "user", parts: [{ text: "(message)" }] }];
  }

  return merged;
}

/** Heuristic: a paragraph that is model reasoning/meta-commentary, not an answer for the client. */
function isReasoningParagraph(p: string): boolean {
  const low = p.toLowerCase().trim();
  if (!low) return true;
  const metaPatterns = [
    /\b(?:the user|the client|the customer) (?:is|wants|asks|asked|says|said)\b/,
    /\b(?:we|i) (?:need to|should|must|will|can) \b/,
    /\b(?:let me|let's|okay,|alright,|first,|so,) \b/,
    /\baccording to the (?:prompt|instructions|system)\b/,
    /\b(?:system prompt|the prompt says|the instructions say|as per the rules)\b/,
    // French reasoning
    /\b(?:je dois|il faut que je|analysons|réfléchissons|d'abord, je|le client demande|le client veut|ma réponse doit|je vais donc|voyons|notons que|selon le prompt|d'après les instructions|en résumé, je)\b/,
    // Malagasy reasoning
    /\b(?:tokony hamaly aho|mieritreritra aho|ny fanontaniana dia|ny mpanjifa dia mangataka|ny mpanjifa dia manontany|valiny tokony|handinika aho|hamaly toy izao aho|araka ny torolalana|araka ny prompt|voalohany indrindra, izaho|ny tanjoko dia|ny valiny ho|alohan'ny hamaliana)\b/,
    /\b(?:draft|final answer|response plan|my response should)\b/,
  ];
  const hits = metaPatterns.filter((r) => r.test(low)).length;
  if (hits === 0) return false;
  // Long analytical blocks are almost always reasoning
  return (
    hits >= 2 ||
    low.length > 160 ||
    /^(?:okay|alright|so|let|the user|we need|je dois|le client|ny mpanjifa|tokony|araka ny)\b/.test(
      low,
    )
  );
}

export function sanitizeAiResponse(text: string): string {
  if (!text) return "";
  let cleaned = text;

  // 1. Remove XML/markdown thinking tags
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, "");
  cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  cleaned = cleaned.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, "");
  cleaned = cleaned.replace(/```(?:thinking|thought|reasoning|scratchpad)[\s\S]*?```/gi, "");

  // 2. Extract technical action blocks first so they are never lost during cleanup
  const actionTags: string[] = [];
  cleaned = cleaned.replace(
    /\[\[?\s*(?:SEND_?IMAGE_?ID|IMAGE_?ID|SEND_?IMAGE|SEND_?IMAGES?|SENDIMAGES?|SEND_?PHOTOS?|SENDPHOTOS?|ORDER)[^\]\n]*\]\]?/gi,
    (match) => {
      let normalized = match.trim();
      if (!normalized.startsWith("[[")) normalized = "[" + normalized;
      if (!normalized.endsWith("]]")) normalized = normalized + "]";
      actionTags.push(normalized);
      return "";
    },
  );

  // 3. If explicit "Final response / Final Text Construction" marker is present, take text after marker
  const finalMarkers = [
    /(?:^|\n)\s*(?:final response|reponse finale|réponse finale|valiny mivantana|valiny farany|final answer|final text construction|final text)\s*:\s*\n?/i,
  ];
  for (const marker of finalMarkers) {
    const parts = cleaned.split(marker);
    if (parts.length > 1 && parts[parts.length - 1].trim().length > 5) {
      cleaned = parts[parts.length - 1].trim();
      break;
    }
  }

  // 4. Line-by-line filtering of English meta-commentary, scratchpad, rule checks, and draft quotes
  const lines = cleaned.split("\n");
  const validLines: string[] = [];

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) {
      validLines.push("");
      continue;
    }

    // Strip wrapping quotes on drafts: "Salama tompoko." -> Salama tompoko.
    if (
      (line.startsWith('"') && line.endsWith('"')) ||
      (line.startsWith("'") && line.endsWith("'"))
    ) {
      line = line.slice(1, -1).trim();
    }

    const low = line.toLowerCase();

    // Check for audit checklist items like: No markdown? Yes. / Language: Malagasy? Yes. / No bullets? Check.
    if (/\?\s*(?:yes|no|ok|done|true|false|check|malagasy|french|english)\b/i.test(low)) {
      continue;
    }
    if (
      low.startsWith("(") &&
      (low.includes("prompt says") ||
        low.includes("wait,") ||
        low.includes("let's ensure") ||
        low.includes("no characters") ||
        low.includes("catalog is"))
    ) {
      continue;
    }

    // Skip English thoughts, planning headers, and instruction echoes
    if (
      /^(?:\*|\*\*|\[)?(?:thinking|thought|thoughts|reasoning|analyse|analysis|penser|réflexion|reflexion|internal notes|draft|draft\s*\d+|plan|greeting|response|description|closing|technical block|technical|hook|value proposition|trust|trust\/ease|benefit|check|cta|final cta|urgency|urgency\/engagement|self-correction|step\s*\d+|expansion|length|language|audit|checklist|verification|self-check|rule check|final text construction|final text)\s*(?::|\*|\*\*|\]|\.|\-|\?)/i.test(
        low,
      ) ||
      low.startsWith("no markdown") ||
      low.startsWith("no bold") ||
      low.startsWith("no bullet") ||
      low.startsWith("no italic") ||
      low.startsWith("needs to be around") ||
      low.startsWith("let's expand") ||
      low.startsWith("let us expand") ||
      low.startsWith("add more detail") ||
      low.startsWith("mention that the team") ||
      low.startsWith("do not describe this block") ||
      low.startsWith("only one send") ||
      low.startsWith("the user is asking") ||
      low.startsWith("the customer is asking") ||
      low.startsWith("the product being discussed") ||
      low.startsWith("based on the product name") ||
      low.startsWith("no thinking process") ||
      low.startsWith("no repeating question") ||
      low.startsWith("same language") ||
      low.startsWith("professional/warm") ||
      low.startsWith("professional style") ||
      low.startsWith("one block") ||
      low.startsWith("let me analyze") ||
      low.startsWith("let me check") ||
      low.startsWith("let me see") ||
      low.startsWith("let's analyze") ||
      low.startsWith("let's check") ||
      low.startsWith("let's think") ||
      low.startsWith("let's ensure") ||
      low.startsWith("i will ensure") ||
      low.startsWith("acknowledge the request") ||
      low.startsWith("briefly mention") ||
      low.startsWith("a clear closing") ||
      low === "check." ||
      low === "check" ||
      low === "ready." ||
      low.includes("(text looks good") ||
      low.includes("total length is sufficient") ||
      low.includes("character count")
    ) {
      continue;
    }

    validLines.push(line);
  }

  cleaned = validLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 5. If there is an isolated preamble draft list followed by the real conversational greeting, discard preamble
  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  let startIndex = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (
      /^(?:miala tsiny|salama|manao ahoana|bonjour|bonsoir|misaotra|mankasitraka|eny tompoko|tsia tompoko|ity vokatra|momba ny|raha|ny vidin)/i.test(
        p,
      )
    ) {
      const preceding = paragraphs.slice(0, i).join(" ");
      if (preceding && !/^(?:salama|bonjour|manao ahoana)/i.test(paragraphs[0])) {
        startIndex = i;
      }
      break;
    }
  }

  // 5b. Drop reasoning/meta paragraphs (model "thinking" leaking into the answer)
  const candidateParagraphs = paragraphs.slice(startIndex);
  const nonMeta = candidateParagraphs.filter((p) => !isReasoningParagraph(p));
  // Never restore an answer made entirely of reasoning. Returning an empty
  // string triggers the short, safe fallback at the call site instead.
  const usefulParagraphs = candidateParagraphs.length > 0 && nonMeta.length === 0 ? [] : nonMeta;

  // 6. Deduplicate repeated paragraphs (e.g. repeated greetings)
  const dedupedParagraphs: string[] = [];
  const seenParagraphs = new Set<string>();
  for (const p of usefulParagraphs) {
    const key = p.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenParagraphs.has(key)) continue;
    seenParagraphs.add(key);
    dedupedParagraphs.push(p);
  }

  cleaned = dedupedParagraphs.join("\n\n").trim();

  // 7. Clean any remaining internal bracket tags
  cleaned = cleaned.replace(/\[\[[\s\S]*?\]\]/g, "");
  cleaned = cleaned.replace(
    /\[(?:SEND_?IMAGE_?ID|SEND_?IMAGES?|SENDIMAGES?|SEND_?PHOTOS?|SENDPHOTOS?|ORDER)[^\]]*\]/gi,
    "",
  );

  // 8. Re-attach technical action tag at the end
  if (actionTags.length > 0) {
    cleaned = `${cleaned}\n\n${actionTags[actionTags.length - 1]}`.trim();
  }

  return cleaned;
}

async function callGemini(
  apiKey: string,
  systemPrompt: string,
  history: ChatTurn[],
  parts: AiPart[],
  modelName: string = GEMINI_MODEL,
  maxTokens: number = 1500,
): Promise<string> {
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey) throw new Error("Clé API Gemini vide");

  const contents = normalizeContentsForGemini(history, parts);

  const standardCandidates = ["gemini-3.6-flash", "gemini-flash-latest", "gemini-3.5-flash"];

  const cleanModelName = resolveGeminiModel(modelName);

  // Model discovery is cached (see fetchAvailableGeminiModels) and only used as
  // a fallback, so a normal reply costs one single HTTP call.
  const candidateList = [cleanModelName, ...standardCandidates].filter(Boolean);

  // Gestion du quota : on garde trois modèles candidats pour qu'un quota atteint
  // (429) sur un modèle bascule immédiatement vers un modèle encore libre avec
  // la MÊME clé, au lieu de mettre la clé en pause.
  const uniqueModels = [...new Set(candidateList)].slice(0, 3);

  let lastError = "";
  let discoveryError = "";
  let quotaError: any = null;
  for (const m of uniqueModels) {
    // thinkingBudget:0 supprime la "réflexion interne" facturée et lente.
    // Mesuré : ~0,7 s avec, ~10 s sans (et parfois une réponse vide car tout le
    // budget de sortie part dans la réflexion). On l'essaie donc en premier
    // partout, et on retombe sans si un modèle le refuse.
    // Modes essayés : (1) sans thinking + recherche Google, (2) sans thinking
    // SANS recherche (le quota de la recherche Google est souvent à 0 sur les
    // clés gratuites → 429 qui n'est PAS un vrai quota de la clé), (3) repli.
    const thinkingModes: Array<{ disableThinking: boolean; search: boolean }> = [
      { disableThinking: true, search: true },
      { disableThinking: true, search: false },
      { disableThinking: false, search: false },
    ];
    let quotaOnThisModel = false;
    for (const { disableThinking, search } of thinkingModes) {
      try {
        const genConfig: Record<string, any> = { temperature: 0.1, maxOutputTokens: maxTokens };
        if (disableThinking) {
          genConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        const body: Record<string, any> = {
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: genConfig,
        };
        if (search) body.tools = [{ google_search: {} }];

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${cleanKey}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(AI_TIMEOUT_MS),
          },
        );

        if (!res.ok) {
          const t = await res.text();
          // If thinkingConfig is unsupported on this model, retry next loop without thinkingConfig
          if (
            disableThinking &&
            (t.includes("thinkingConfig") ||
              t.includes("INVALID_ARGUMENT") ||
              t.includes("Unknown name"))
          ) {
            continue;
          }
          // Échec avec la recherche Google (quota recherche / 503) : ce n'est
          // pas la clé qui est épuisée → on réessaie tout de suite sans recherche.
          if (search && res.status !== 401 && res.status !== 403) {
            console.warn(
              `[gemini] recherche Google refusée (${res.status}) sur ${m}, repli sans recherche`,
            );
            continue;
          }
          lastError = `Gemini (${m}): ${t.slice(0, 180)}`;
          // Clé révoquée / compte de service supprimé chez Google : inutile
          // d'essayer un autre modèle, elle échouera partout. On remonte tout
          // de suite pour passer à la clé suivante.
          if (res.status === 401 || res.status === 403 || t.includes("UNAUTHENTICATED")) {
            const authErr = new Error(
              `Clé refusée par Google (${res.status}) : ${t.slice(0, 150)}`,
            );
            (authErr as any).isAuth = true;
            throw authErr;
          }
          // Quota atteint (429 / RESOURCE_EXHAUSTED) : la LIMITE est par modèle.
          // On passe donc au modèle suivant avec la même clé ; la clé n'est
          // considérée à court de quota que si TOUS les modèles refusent.
          if (
            res.status === 429 ||
            t.includes("RESOURCE_EXHAUSTED") ||
            t.toLowerCase().includes("quota")
          ) {
            console.warn(`[gemini] quota atteint sur le modèle ${m}, bascule modèle suivant`);
            const quotaErr = new Error(`Quota dépassé pour cette clé (${m}): ${t.slice(0, 150)}`);
            (quotaErr as any).isQuota = true;
            quotaError = quotaErr;
            quotaOnThisModel = true;
            break; // modèle suivant (quota libre ailleurs)
          }
          console.warn(`[gemini] model ${m} failed:`, lastError);
          break; // move to next model
        }

        const json: any = await res.json();
        const candidate = json?.candidates?.[0];
        const finish = candidate?.finishReason;
        const candidateParts = candidate?.content?.parts ?? [];
        // Filter out thought parts
        const nonThoughtParts = candidateParts.filter(
          (p: any) => !p.thought && !p.thought_process && p.type !== "thought",
        );
        const effectiveParts = nonThoughtParts.length > 0 ? nonThoughtParts : candidateParts;
        const text = effectiveParts
          .map((p: any) => p.text ?? "")
          .join("")
          .trim();

        if (finish && finish !== "STOP" && finish !== "MAX_TOKENS") {
          console.warn("[gemini] finishReason non-STOP:", finish);
        }
        if (finish === "MAX_TOKENS") {
          console.warn("[gemini] réponse tronquée par MAX_TOKENS, longueur:", text.length);
        }
        if (!text)
          throw new Error(`Réponse vide du modèle ${m} (finishReason=${finish ?? "unknown"})`);
        return sanitizeAiResponse(text);
      } catch (err: any) {
        lastError = err.message || String(err);
        // Clé refusée : inutile d'essayer d'autres modèles, on passe à la clé suivante.
        if (err?.isAuth) throw err;
        // Quota : la limite est par modèle → on tente le modèle suivant.
        if (err?.isQuota) {
          quotaError = err;
          quotaOnThisModel = true;
          break;
        }
      }
    }
    if (quotaOnThisModel) continue; // modèle saturé, on essaie le suivant
  }

  // Tous les modèles connus sont saturés pour cette clé → on passe à la clé suivante.
  if (quotaError) throw quotaError;

  // Only when every known model failed do we pay for model discovery.
  if (!lastError || /not found|not supported|unsupported|404/i.test(lastError)) {
    const discovery = await fetchAvailableGeminiModels(cleanKey);
    discoveryError = discovery.ok ? "" : (discovery.error ?? "");
    const extra = (discovery.models ?? []).filter((m) => !uniqueModels.includes(m)).slice(0, 2);
    for (const m of extra) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${cleanKey}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents,
              generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
            }),
            signal: AbortSignal.timeout(AI_TIMEOUT_MS),
          },
        );
        if (!res.ok) {
          lastError = `Gemini (${m}): ${(await res.text()).slice(0, 180)}`;
          continue;
        }
        const json: any = await res.json();
        const candidateParts = json?.candidates?.[0]?.content?.parts ?? [];
        const text = candidateParts
          .filter((p: any) => !p.thought && !p.thought_process && p.type !== "thought")
          .map((p: any) => p.text ?? "")
          .join("")
          .trim();
        if (text) return sanitizeAiResponse(text);
      } catch (err: any) {
        lastError = err?.message || String(err);
      }
    }
  }

  if (discoveryError) throw new Error(discoveryError);

  throw new Error(lastError || "Toutes les tentatives de modèles Gemini ont échoué");
}

/* ---- Lovable AI: rotation sur tous les modèles de chat disponibles ---- */

const LOVABLE_FALLBACK_MODELS = [
  "google/gemini-3.7-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-pro",
];

let lovableModelsCache: { models: string[]; at: number } | null = null;
let lovableRotationIndex = 0;

async function getLovableModels(apiKey: string): Promise<string[]> {
  const now = Date.now();
  if (lovableModelsCache && now - lovableModelsCache.at < 10 * 60 * 1000) {
    return lovableModelsCache.models;
  }
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const json: any = await res.json();
    const models: string[] = (json?.data ?? [])
      .filter((m: any) => {
        const id: string = m?.id ?? "";
        const input: string[] = m?.modalities?.input ?? [];
        const output: string[] = m?.modalities?.output ?? [];
        return (
          id.startsWith("google/gemini") &&
          !/embedding|tts|image|transcribe/i.test(id) &&
          input.includes("text") &&
          input.includes("image") &&
          output.length === 1 &&
          output[0] === "text"
        );
      })
      .map((m: any) => m.id as string)
      // Modèles les plus récents d'abord.
      .sort((a: string, b: string) => b.localeCompare(a, "en", { numeric: true }));
    if (models.length) {
      lovableModelsCache = { models, at: now };
      return models;
    }
  } catch (e) {
    console.warn("[Lovable AI] models list error:", e instanceof Error ? e.message : e);
  }
  lovableModelsCache = { models: LOVABLE_FALLBACK_MODELS, at: now };
  return LOVABLE_FALLBACK_MODELS;
}

async function callLovableAi(
  systemPrompt: string,
  history: ChatTurn[],
  parts: AiPart[],
  maxTokens: number = 1500,
): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  const content: any[] = parts.map((p) =>
    "text" in p
      ? { type: "text", text: p.text }
      : {
          type: "image_url",
          image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` },
        },
  );
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map((t) => ({ role: t.role, content: t.text })),
    { role: "user", content },
  ];

  const models = await getLovableModels(key);
  const start = lovableRotationIndex % models.length;
  lovableRotationIndex = (start + 1) % models.length;

  let lastError = "";
  // Speed: never walk the whole catalogue for one reply. A slow/failing model
  // must be abandoned quickly so the client gets an answer in seconds.
  const maxModelTries = Math.min(models.length, 2);
  for (let i = 0; i < maxModelTries; i++) {
    const model = models[(start + i) % models.length]!;
    try {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "Lovable-API-Key": key },
        signal: AbortSignal.timeout(LOVABLE_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.1,
          max_tokens: maxTokens,
          // No internal reasoning: the client must only ever receive the answer.
          reasoning_effort: "none",
        }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        lastError = `Lovable AI ${model} ${res.status}: ${body}`;
        // 429 (rate limit) / 402 (crédits) / 5xx : on tente le modèle suivant.
        if (res.status === 429 || res.status === 402 || res.status >= 500) {
          console.warn("[Lovable AI] rotation modèle:", lastError);
          continue;
        }
        // 400/401/403 : inutile de réessayer ce modèle, mais on tente les autres
        // uniquement pour un 400 (modèle non supporté).
        if (res.status === 400) continue;
        throw new Error(lastError);
      }
      const json: any = await res.json();
      const message = json?.choices?.[0]?.message ?? {};
      // Any reasoning/thinking field is deliberately ignored, never sent to the client.
      const text = typeof message.content === "string" ? message.content : "";
      if (!text) {
        lastError = `Empty Lovable AI response (${model})`;
        continue;
      }
      return sanitizeAiResponse(text);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.warn("[Lovable AI] erreur modèle", model, lastError);
    }
  }
  // Tous les modèles Lovable ont échoué (quota épuisé) → bascule vers Gemini.
  throw new Error(lastError || "Tous les modèles Lovable AI ont échoué");
}

/** Generate a reply. Lovable AI first (default), Gemini rotation as fallback. */
export async function generateAiReply(opts: {
  userId: string;
  systemPrompt: string;
  history?: ChatTurn[];
  parts: AiPart[];
  allowLinks?: boolean;
  /** Réponse client courte (max 3 phrases) + cache. false pour posts/modération. */
  shortReply?: boolean;
  conversationId?: string;
  /** Question brute du client (utilisée par la Mini IA : mémoire + secours). */
  question?: string;
  /** Type de message de secours si plus aucune IA n'est disponible. */
  kind?: "comment" | "private";
}): Promise<{ text: string; provider: string }> {
  const shortReply = opts.shortReply ?? true;
  const cfg = getQuotaConfig();

  // ---- MINI IA (module additif : mémoire intelligente + secours) ----
  const question = (
    opts.question ?? opts.parts.map((p) => ("text" in p ? p.text : "")).join(" ")
  ).trim();
  const hasImage = opts.parts.some((p) => !("text" in p));
  const miniEnabled = shortReply && !hasImage && question.length >= 2;

  if (miniEnabled) {
    try {
      const { miniAiLookup } = await import("./mini-ia.server");
      const hit = await miniAiLookup(opts.userId, question, { verifiedOnly: true });
      if (hit?.answer) return { text: hit.answer, provider: "mini-ia:verified" };
    } catch (e) {
      console.warn("[mini-ia] pre-check skipped", e instanceof Error ? e.message : e);
    }
  }

  const runMain = () =>
    runManagedAiCall({
      userId: opts.userId,
      systemPrompt: opts.systemPrompt,
      parts: opts.parts,
      history: opts.history ?? [],
      conversationId: opts.conversationId,
      shortReply,
      useCache: shortReply,
      type: shortReply ? "reply" : "generation",
      call: (history) =>
        generateAiReplyUnmanaged({
          ...opts,
          systemPrompt: shortReply ? opts.systemPrompt + SHORT_REPLY_RULE : opts.systemPrompt,
          history,
          maxTokens: shortReply ? cfg.MAX_OUTPUT_TOKENS : 1500,
        }),
    });

  if (!miniEnabled) return runMain();

  const miniRescue = async (): Promise<{ text: string; provider: string }> => {
    const { miniAiLookup, buildFallbackMessage, FALLBACK_THRESHOLD } =
      await import("./mini-ia.server");
    // Secours : on accepte la réponse mémorisée la plus proche par mots-clés.
    const hit = await miniAiLookup(opts.userId, question, { threshold: FALLBACK_THRESHOLD });
    if (hit?.answer) return { text: hit.answer, provider: "mini-ia:memory" };
    return {
      text: await buildFallbackMessage(opts.userId, opts.kind ?? "private"),
      provider: "mini-ia:fallback",
    };
  };

  const fallbackAllowed = async (): Promise<boolean> => {
    try {
      const { data } = await supabaseAdmin
        .from("settings")
        .select("mini_ia_fallback_enabled")
        .eq("user_id", opts.userId)
        .maybeSingle();
      return (data as any)?.mini_ia_fallback_enabled !== false;
    } catch {
      return true;
    }
  };
  const noFallback = (reason: string) =>
    Object.assign(new Error(`Mini IA fallback non envoyé : ${reason}`), { fallbackSkipped: true });

  try {
    const res = await runMain();
    // L'IA principale n'a pas pu répondre (quota / file d'attente) : secours Mini IA.
    if (res.provider.startsWith("quota-manager")) {
      // Limite par conversation ≠ quota épuisé : pas de message de secours.
      if (res.provider !== "quota-manager:fallback") throw noFallback(res.provider);
      void notifyQuotaRecipients(opts.userId, res.provider);
      if (!(await fallbackAllowed())) throw noFallback("désactivé par l'admin");
      return await miniRescue();
    }
    if (res.text && !res.provider.startsWith("cache")) {
      const { learnKnowledge } = await import("./mini-ia.server");
      await learnKnowledge({
        userId: opts.userId,
        question,
        answer: res.text,
        source: res.provider,
        category: opts.kind === "comment" ? "comment" : "message",
      });
    }
    return res;
  } catch (e) {
    if ((e as any)?.fallbackSkipped) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[mini-ia] IA principale indisponible", msg);
    const isQuota = Boolean((e as any)?.isQuota || /429|quota|RESOURCE_EXHAUSTED/i.test(msg));
    // Secours uniquement si le quota des IA principales est réellement épuisé.
    if (!isQuota) throw noFallback(`erreur non liée au quota (${msg.slice(0, 120)})`);
    void notifyQuotaRecipients(opts.userId, msg.slice(0, 120));
    if (!(await fallbackAllowed())) throw noFallback("désactivé par l'admin");
    return await miniRescue();
  }
}

/** Alerte quota épuisé aux seuls PSID enregistrés et activés (best effort). */
async function notifyQuotaRecipients(userId: string, detail?: string) {
  try {
    const { notifyQuotaExhausted } = await import("@/lib/client-notify.server");
    await notifyQuotaExhausted(userId, detail);
  } catch (e) {
    console.error("[quota-notify] erreur", e);
  }
}

async function generateAiReplyUnmanaged(opts: {
  userId: string;
  systemPrompt: string;
  history?: ChatTurn[];
  parts: AiPart[];
  allowLinks?: boolean;
  maxTokens?: number;
}): Promise<{ text: string; provider: string }> {
  const { userId, systemPrompt, parts, allowLinks } = opts;
  const maxTokens = opts.maxTokens ?? 1500;
  const history = opts.history ?? [];
  const strictSystemPrompt = appendClarityInstructions(systemPrompt);

  const { data: settings } = await supabaseAdmin
    .from("settings")
    .select("use_lovable_ai_fallback,default_model")
    .eq("user_id", userId)
    .maybeSingle();
  const lovableEnabled = settings?.use_lovable_ai_fallback ?? true;
  const modelToUse = resolveGeminiModel(settings?.default_model);

  if (lovableEnabled) {
    try {
      const raw = await callLovableAi(strictSystemPrompt, history, parts, maxTokens);
      const sanitized = sanitizeAiResponse(raw);
      const cleaned = sanitizeReply(sanitized, allowLinks);
      if (looksTruncated(cleaned)) {
        const completed = await retryTruncatedReply({
          userId,
          systemPrompt,
          history,
          parts,
          currentReply: cleaned,
          allowLinks,
        });
        if (completed) {
          const completedSanitized = sanitizeAiResponse(completed.raw);
          return {
            text: sanitizeReply(completedSanitized, allowLinks),
            provider: completed.provider,
          };
        }
      }
      return { text: cleaned, provider: "lovable-ai" };
    } catch (e) {
      console.warn("[Lovable AI] fallback vers Gemini:", e instanceof Error ? e.message : e);
    }
  }

  // Clés OpenAI (ChatGPT) de l'administrateur, avec modèle auto-détecté.
  try {
    const { data: oaKeys } = await supabaseAdmin
      .from("openai_keys")
      .select("*")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("last_used_at", { ascending: true, nullsFirst: true });
    const nowOa = Date.now();
    const { callOpenAiChat, detectOpenAiModel } = await import("@/lib/openai.server");
    for (const k of (oaKeys ?? []) as any[]) {
      if (k.disabled_until && new Date(k.disabled_until).getTime() > nowOa) continue;
      try {
        let model = k.selected_model as string | null;
        if (!model) {
          const d = await detectOpenAiModel(k.api_key);
          if (!d.ok) throw new Error(d.error);
          model = d.model;
          await supabaseAdmin.from("openai_keys").update({ selected_model: model }).eq("id", k.id);
        }
        const textParts = parts
          .map((p) => ("text" in p ? p.text : ""))
          .filter(Boolean)
          .join("\n");
        const raw = await callOpenAiChat(
          k.api_key,
          model,
          [
            { role: "system", content: strictSystemPrompt },
            ...history.map((t) => ({ role: t.role, content: t.text })),
            { role: "user", content: textParts || "..." },
          ],
          maxTokens,
        );
        await supabaseAdmin
          .from("openai_keys")
          .update({ last_used_at: new Date().toISOString(), error_count: 0 })
          .eq("id", k.id);
        return {
          text: sanitizeReply(sanitizeAiResponse(raw), allowLinks),
          provider: `openai:${model}`,
        };
      } catch (e: any) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[OpenAI] error", k.label, redactSecrets(msg));
        const pauseMs = e?.isAuth ? 24 * 3600_000 : e?.isQuota ? 10 * 60_000 : 60_000;
        await supabaseAdmin
          .from("openai_keys")
          .update({
            error_count: (k.error_count ?? 0) + 1,
            disabled_until: new Date(Date.now() + pauseMs).toISOString(),
          })
          .eq("id", k.id);
      }
    }
  } catch (e) {
    console.warn("[OpenAI] skipped", e instanceof Error ? e.message : e);
  }

  // Fallback Gemini : on récupère TOUTES les clés actives, puis on les essaie
  // une par une (les disponibles d'abord, puis, en dernier recours, celles
  // encore "en pause" — sinon plus aucune réponse quand Lovable AI est épuisé).
  const { data: allKeys } = await supabaseAdmin
    .from("gemini_keys")
    .select("*")
    .eq("user_id", userId);

  if (!allKeys || allKeys.length === 0) {
    throw new Error(
      "Aucune clé API Gemini configurée. Veuillez ajouter votre clé API Gemini dans le menu 'Clés Gemini'.",
    );
  }

  const nowMs = Date.now();
  const activeKeys = (allKeys as any[]).filter((k) => k.is_active !== false);
  const byOldestUse = (a: any, b: any) => {
    const ta = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
    const tb = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
    return ta - tb;
  };
  const ready = activeKeys
    .filter((k) => !k.disabled_until || new Date(k.disabled_until).getTime() <= nowMs)
    .sort(byOldestUse);
  const paused = activeKeys
    .filter((k) => k.disabled_until && new Date(k.disabled_until).getTime() > nowMs)
    .sort(byOldestUse);
  const orderedKeys = [
    ...ready,
    ...paused,
    ...(allKeys as any[]).filter((k) => k.is_active === false),
  ];

  const keyErrors: string[] = [];

  // On parcourt TOUTES les clés : s'arrêter aux 3 premières bloquait la
  // réponse quand les premières clés de la liste étaient révoquées chez Google,
  // alors que des clés valides attendaient juste derrière.
  for (const key of orderedKeys) {
    try {
      const cleanKey = (key.api_key || "").trim();
      if (!cleanKey) throw new Error(`Clé '${key.label}' vide`);
      const raw = await callGemini(
        cleanKey,
        strictSystemPrompt,
        history,
        parts,
        modelToUse,
        maxTokens,
      );
      await markKeyUsed(key.id);
      const sanitized = sanitizeAiResponse(raw);
      const cleaned = sanitizeReply(sanitized, allowLinks);
      if (looksTruncated(cleaned)) {
        const completed = await retryTruncatedReply({
          userId,
          systemPrompt,
          history,
          parts,
          currentReply: cleaned,
          allowLinks,
        });
        if (completed) {
          const completedSanitized = sanitizeAiResponse(completed.raw);
          return {
            text: sanitizeReply(completedSanitized, allowLinks),
            provider: completed.provider,
          };
        }
      }
      return { text: cleaned, provider: `gemini:${key.label}` };
    } catch (e: any) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const isQuota = Boolean(e?.isQuota || errMsg.includes("Quota") || errMsg.includes("429"));
      const isDead = Boolean(
        e?.isAuth ||
        errMsg.includes("UNAUTHENTICATED") ||
        errMsg.includes("401") ||
        errMsg.includes("service account is deleted"),
      );
      console.error("[Gemini] error", key.label, redactSecrets(errMsg));
      keyErrors.push(
        isDead
          ? `${key.label}: clé supprimée ou désactivée chez Google (à remplacer)`
          : `${key.label}: ${errMsg}`,
      );
      await markKeyError(key.id, key.error_count ?? 0, isQuota, isDead);
    }
  }

  throw new Error(
    keyErrors.length
      ? `Erreur Clé Gemini [${keyErrors.join(" | ")}]. Vérifiez vos clés dans le menu 'Clés Gemini'.`
      : "Clés API Gemini invalides ou temporairement désactivées. Vérifiez vos clés dans le menu 'Clés Gemini'.",
  );
}

/** Protocole de commande temporaire : l'article et les champs sont définis
 *  librement dans le prompt de l'utilisateur (hors catalogue). */
const GENERIC_ORDER_PROTOCOL =
  "PROTOCOLE COMMANDE TEMPORAIRE (DÉFINIE PAR LE PROMPT) :\n" +
  "- Si le prompt ci-dessus décrit un article, un service ou des informations à collecter, suis EXACTEMENT ces consignes pour prendre la commande, même si l'article n'existe pas dans un catalogue.\n" +
  "- Pose les questions une par une, puis quand toutes les informations demandées par le prompt sont réunies, ajoute À LA TOUTE FIN de ta réponse, sur une ligne séparée, ce bloc technique :\n" +
  `[[ORDER:{"type":"sales","item":"NOM DE L'ARTICLE OU DU SERVICE","quantity":1,"client_fb_name":"...","client_phone":"...","client_address":"...","payment_reference":"","notes":"..."}]]\n` +
  '- Tu peux AJOUTER librement d\'autres champs demandés par le prompt (ex: "taille":"XL", "date":"12/10") : ils seront enregistrés avec la commande.\n' +
  "- Un seul bloc ORDER par réponse, uniquement quand la commande est confirmée.\n" +
  "- Ce bloc est invisible pour le client : ne le commente jamais.";

/** Fetch dynamic catalog context (formations / produits / paiements) selon assistance_type. */
async function buildCatalogContext(userId: string, pageId?: string | null): Promise<string> {
  const { data: settings } = await supabaseAdmin
    .from("settings")
    .select("assistance_type")
    .eq("user_id", userId)
    .maybeSingle();
  const type = (settings as any)?.assistance_type ?? "online_work";

  const linkRule =
    "RÈGLE ABSOLUE POUR LES LIENS :\n" +
    "- Si tu envoies un lien (Google Drive, YouTube, etc.), recopie-le EXACTEMENT caractère par caractère.\n" +
    "- Garde tous les tirets bas (_), tirets (-), points (.), slashs (/), chiffres et majuscules.\n" +
    "- Ne jamais réécrire, raccourcir, embellir ou traduire un lien.\n" +
    "- Colle le lien sur une ligne seule pour qu'il reste cliquable.";

  if (type === "training") {
    const { data: trainings } = await supabaseAdmin
      .from("trainings")
      .select("name,description,pricing_type,price,payment_flow,video_link")
      .eq("user_id", userId)
      .eq("is_active", true);
    const { data: pmethods } = await supabaseAdmin
      .from("payment_methods")
      .select("label,number,instructions")
      .eq("user_id", userId)
      .eq("is_active", true);
    if (!trainings || trainings.length === 0) return `${linkRule}\n\n${GENERIC_ORDER_PROTOCOL}`;
    const list = trainings
      .map((t: any) => {
        const priceInfo =
          t.pricing_type === "free"
            ? "Gratuit"
            : `Payante : ${Number(t.price ?? 0).toLocaleString()} Ar`;
        const flow =
          t.pricing_type === "paid"
            ? t.payment_flow === "admin_numbers"
              ? " — Paiement via nos numéros ci-dessous, envoyer preuve avant réception."
              : " — Prendre nom Facebook + WhatsApp/téléphone du client avant confirmation."
            : "";
        return `• ${t.name} — ${priceInfo}${flow}\n   ${t.description ?? ""}${t.video_link ? `\n   Aperçu vidéo : ${t.video_link}` : ""}`;
      })
      .join("\n");
    const pm = (pmethods ?? [])
      .map((p: any) => `- ${p.label} : ${p.number}${p.instructions ? ` (${p.instructions})` : ""}`)
      .join("\n");

    const orderProtocol =
      "PROTOCOLE COMMANDE (OBLIGATOIRE) :\n" +
      "Dès qu'un client confirme vouloir une formation ET que tu as collecté les informations nécessaires " +
      "(nom Facebook, WhatsApp/téléphone, et pour les payantes la référence de paiement si envoyé), " +
      "ajoute À LA TOUTE FIN de ta réponse (sur une ligne séparée) un bloc technique EXACTEMENT au format :\n" +
      `[[ORDER:{"type":"training","training":"NOM EXACT DE LA FORMATION","client_fb_name":"...","client_whatsapp":"...","payment_reference":"...","notes":"..."}]]\n` +
      '- Remplis uniquement les champs que tu connais, laisse les autres vides ("").\n' +
      "- Ce bloc est invisible pour le client, ne le commente jamais.\n" +
      "- Un seul bloc ORDER par réponse, uniquement quand la commande est réellement confirmée.";

    return `CATALOGUE FORMATIONS :\n${list}\n\n${pm ? `NUMÉROS DE PAIEMENT :\n${pm}\n\n` : ""}RÈGLES IMPORTANTES :\n- Ne JAMAIS envoyer les fichiers d'une formation payante tant que le paiement n'est pas confirmé.\n- Pour une formation gratuite, propose immédiatement le contenu quand le client le demande.\n- Quand un client accepte une formation payante avec paiement par numéros, envoie les numéros ci-dessus et demande la référence + nom d'envoi.\n- Quand la méthode est "contact client", demande simplement le nom Facebook et un numéro WhatsApp/téléphone joignable.\n- Répète le nom de la formation choisie et le montant pour confirmer.\n\n${linkRule}\n\n${orderProtocol}\n\n${GENERIC_ORDER_PROTOCOL}`;
  }

  if (type === "sales") {
    const { data: allProducts } = await supabaseAdmin
      .from("products")
      .select(
        "id,name,price,stock,description,payment_flow,page_ids, product_images(id, image_path, sort_order)",
      )
      .eq("user_id", userId)
      .eq("is_active", true);
    // Filtre strict par page : seuls les produits sélectionnés pour CETTE page.
    const products = (allProducts ?? []).filter((p: any) => {
      const ids: string[] = Array.isArray(p.page_ids) ? p.page_ids : [];
      return Boolean(pageId) && ids.includes(String(pageId));
    });
    const { data: pmethods } = await supabaseAdmin
      .from("payment_methods")
      .select("label,number,instructions")
      .eq("user_id", userId)
      .eq("is_active", true);
    if (!products || products.length === 0) return `${linkRule}\n\n${GENERIC_ORDER_PROTOCOL}`;
    const list = products
      .map((p: any) => {
        const imgs = (p.product_images ?? []).sort(
          (a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
        );
        const imgStrs = imgs.map((img: any) => `   - Sary [ID_IMAGE: ${img.id}]`).join("\n");
        return `• [ID_PRODUIT: ${p.id}] ${p.name} — ${Number(p.price).toLocaleString()} Ar (stock : ${p.stock})\n   ${p.description ?? ""}\n${imgStrs}`;
      })
      .join("\n\n");
    const pm = (pmethods ?? [])
      .map((p: any) => `- ${p.label} : ${p.number}${p.instructions ? ` (${p.instructions})` : ""}`)
      .join("\n");

    const imageProtocol =
      "PROTOCOLE PHOTOS PRODUIT AVEC ID (OBLIGATOIRE) :\n" +
      "MISY FEPETRA HENJANA : SARY IRAY MONJA isaky ny fangatahana, ary tsy alefa raha tsy nangataka sary MAZAVA ny client amin'ilay hafatra farany (ohatra : 'misy sary ve', 'alefaso sary', 'tiako hojerena', 'photo').\n" +
      "- Rehefa mangataka sary izy : jereo ny ID ao amin'ny katalaogy ([ID_IMAGE: ...]) na ny anaran'ny vokatra, ary ampidiro amin'ny andalana manokana any amin'ny farany ny bloc teknika :\n" +
      "[[SEND_IMAGE_ID: ID_DE_LA_SARY]] na [[SEND_IMAGES: NOM_OU_ID_DU_PRODUIT]]\n" +
      "- AZA ampiasaina io bloc io intsony amin'ny valin-teny manaraka rehefa efa nandefa sary ianao : tohizo ny resaka (fanazavana, vidiny, commande).\n" +
      "- Raha miteny 'haka aho', 'hividy aho', 'commander' na manome fampahalalana ny client : TSY MANDEFA SARY MIHITSY, tohizo ny dingan'ny commande.\n" +
      "- Raha mangataka sary hafa indray izy vao mandefa iray hafa.\n" +
      "- Aza tononina na hazavaina amin'ny mpanjifa io bloc io fa miafina izy io.";

    const orderProtocol =
      "PROTOCOLE EXPLICATION PRODUIT SY COMMANDE TSIKILIKELY (STRICTEMENT OBLIGATOIRE) :\n\n" +
      "1. REHEFA MANAZAVA PRODUIT (TANDREMO TSY TONGA DIA MAMPISEHO PAIEMENT NA COMMANDE) :\n" +
      "   - Hazavao amin'ny fomba tsotra sy mazava ny momba ilay vokatra (antsipiriany, tombontsoa, vidiny).\n" +
      "   - Raha nangataka sary izy dia asio [[SEND_IMAGES:NOM EXACT DU PRODUIT]] any amin'ny farany.\n" +
      "   - REHEFA VITA NY FANAZAVANA : ANONTANIO ALOHA NY FANAPAHAN-KEVITRY NY MPANJIFA (DÉCISION) : ohatra 'Mahaliana anao ve ity vokatra ity? Tianao ve ny hanafatra azy sa mbola misy fanazavana fanampiny tianao ho fantatra?'.\n" +
      "   - TSY AZO OMENA LAHARANA FANDOAVAM-BOLA NA ANGATAHINA ADIRESY/COMMANDE NY MPANJIFA raha mbola tsy niteny mazava izy fa HANDRAY NA HIVIDY NA HANAFATRA.\n\n" +
      "2. REHEFA NANAIKY HIVIDY NY MPANJIFA (FAKANA COMMANDE TSIKILIKELY ISAKY NY VALIN-TENY) :\n" +
      "   Rehefa nilaza mazava ny mpanjifa fa hividy na handray (ohatra: 'Eny handray aho', 'Tiako hovidina', 'Commander-ko', 'Hanafatra aho'), anontanio TSIKILIKELY isaky ny hafatra ireto fampahalalana ireto (TSY AZO ANGATAHINA MIARAKA DAHOLO, ary jereo tsara ny resaka teo aloha mba tsy hamerenana fanontaniana efa voavaly) :\n" +
      "   • Dingana 1 : ANARANA FENO — Anontanio ny anarana fenon'ny mpanjifa (raha mbola tsy voalaza).\n" +
      "   • Dingana 2 : LAHARANA FINDAY — Rehefa azo ny anarana dia anontanio ny laharana finday afaka iantsoana azy na WhatsApp.\n" +
      "   • Dingana 3 : ADIRESY FENO MAZAVA — Rehefa azo ny laharana dia anontanio ny adiresy mazava misy azy (Faritra / RÉGION, Distrika / DISTRICT, FOKONTANY, ary toerana famantarana / REPÈRE).\n" +
      "   • Dingana 4 : FOMBA FANDOAVAM-BOLA SY FAMARANANA :\n" +
      "      - Raha 'Paiement avant livraison / Par numéros' : Omeo ny laharana fandoavam-bola (Mvola, Airtel Money, Orange Money) ary angataho ny référence sy ny anaran'ny mpanefa. Rehefa azo izany dia ampidiro ny bloc ORDER.\n" +
      "      - Raha 'Paiement à la livraison / Contact client' : Rehefa azo ireo 3 voalohany (Anarana, Laharana, Adiresy mazava) dia ampidiro AVY HATRANY ny bloc ORDER ary lazao amin'ny mpanjifa fa voaray soa aman-tsara ny commande-ny ary haterin'ny mpanao livraison aminy.\n\n" +
      "BLOC TECHNIQUE ORDER (ampidiro eo amin'ny farany indrindra amin'ny andalana manokana, rehefa feno ny fampahalalana) :\n" +
      `[[ORDER:{"type":"sales","product":"NOM EXACT DU PRODUIT","quantity":1,"client_fb_name":"ANARANA","client_phone":"LAHARANA","client_whatsapp":"WHATSAPP","client_address":"ADIRESY (REGION DISTRICT FOKONTANY REPERE)","payment_reference":"REFERENCE NA VIDE","notes":""}]]\n` +
      "- Tsy maintsy ampidirina ity bloc ORDER ity mba hiditra mivantana ao amin'ny pejy Commandes ny commande.\n" +
      "- Tsy hita maso ity bloc ity, aza hazavaina amin'ny mpanjifa.";

    return `CATALOGUE PRODUITS :\n${list}\n\n${pm ? `NUMÉROS DE PAIEMENT :\n${pm}\n\n` : ""}RÈGLES IMPORTANTES :\n- Vérifie toujours le stock disponible avant de confirmer.\n- Omeo ny vidiny marina sy ny antsipiriany araka ny voalaza etsy ambony.\n- Tsikelikely foana no manontany ny mombamomba ny mpanjifa (Anarana -> Laharana finday -> Adiresy mazava misy Région, District, Fokontany -> Fomba fandoavana).\n- Confirme toujours nom du produit, prix, quantité ET adresse.\n\n${linkRule}\n\n${imageProtocol}\n\n${orderProtocol}\n\n${GENERIC_ORDER_PROTOCOL}`;
  }

  return `${linkRule}\n\n${GENERIC_ORDER_PROTOCOL}`;
}

/** Économie de quota : le prompt système (prompts + catalogue + fichiers) est
 *  identique pour tous les messages d'une même page pendant quelques secondes.
 *  On le met en cache 60 s pour éviter de relire la base à chaque événement. */
const systemPromptCache = new Map<string, { value: string | null; expiresAt: number }>();
const SYSTEM_PROMPT_TTL_MS = 60 * 1000;

/** Build system prompt from active prompts, avec directives strictes.
 *  Retourne null si aucune prompt active n'est configurée pour cette page :
 *  dans ce cas l'IA ne doit PAS répondre. */
export async function buildSystemPrompt(
  userId: string,
  category: "message" | "comment",
  pageId?: string | null,
): Promise<string | null> {
  const cacheKey = `${userId}|${category}|${pageId ?? ""}`;
  const cached = systemPromptCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const built = await buildSystemPromptUncached(userId, category, pageId);
  systemPromptCache.set(cacheKey, { value: built, expiresAt: Date.now() + SYSTEM_PROMPT_TTL_MS });
  return built;
}

async function buildSystemPromptUncached(
  userId: string,
  category: "message" | "comment",
  pageId?: string | null,
): Promise<string | null> {
  const { data: settings } = await supabaseAdmin
    .from("settings")
    .select("assistance_type")
    .eq("user_id", userId)
    .maybeSingle();
  const assistanceType = (settings as any)?.assistance_type ?? "online_work";

  let query = supabaseAdmin
    .from("prompts")
    .select("id,content,category,page_id,page_ids,assistance_type")
    .eq("user_id", userId)
    .eq("is_active", true)
    .in("category", ["global", category]);

  const { data } = await query;

  // Strict : seul un prompt dont la page actuelle est explicitement sélectionnée
  // est utilisé. Jamais de prompt d'une autre page.
  const pageRows = (data ?? []).filter((p: any) => {
    const ids: string[] =
      Array.isArray(p.page_ids) && p.page_ids.length ? p.page_ids : p.page_id ? [p.page_id] : [];
    return Boolean(pageId) && ids.includes(String(pageId));
  });
  let matchedRows = pageRows.filter(
    (p: any) =>
      !p.assistance_type || p.assistance_type === "all" || p.assistance_type === assistanceType,
  );
  if (matchedRows.length === 0) matchedRows = pageRows;

  let extras = matchedRows
    .sort((a: any, b: any) => (a.category === "global" ? -1 : 1))
    .map((p: any) => (p.content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");

  // Fallback 3: if still no prompts configured at all, use default professional assistant prompt
  if (!extras) {
    extras =
      "Vous êtes l'assistant virtuel IA professionnel de notre page Facebook. Répondez de manière chaleureuse, amicale, claire et professionnelle aux questions des clients en les orientant efficacement.";
  }

  const styleRules =
    "RÈGLES ABSOLUES ET STRICTES DE RÉPONSE (PRIORITÉ MAXIMALE) :\n" +
    "1. MPANJIFA VAOVAO / FIARAHABANA : Rehefa mpanjifa vao manomboka miresaka na manao salama / bonjour / manao ahoana, miarahaba am-pifaliana sy am-panajana, mampahafantatra fohy ireo vokatra misy ao amin'ny pejy, ary manontany hoe inona amin'ireo no tiany ho fantatra kokoa.\n" +
    "2. RÉPONSE DIRECTE ET PRÉCISE : Réponds DIRECTEMENT à la question du client sans détour, sans préambule inutile et sans répéter la question du client.\n" +
    "3. AUCUNE PENSÉE NI ANALYSE VISIBLE : INTERDICTION FORMELLE d'inclure ton processus de réflexion, brouillon, 'Thinking:', 'Thought:', 'Hook:', 'Check', 'Let me check', 'Analyse:' ou du texte en anglais. Donne UNIQUEMENT la réponse finale pour le client.\n" +
    "4. LANGUE EXACTE DU CLIENT : Réponds STRICTEMENT dans la même langue que le client (en malgache si le client écrit en malgache, en français s'il écrit en français). N'utilise JAMAIS l'anglais.\n" +
    "5. EXPLICATION PUIS DÉCISION : Rehefa manazava produit dia hazavao ny momba azy sy ny vidiny, ary ANONTANIO ALOHA NY DÉCISION-NY ('Mahaliana anao ve? Tianao ve ny hanafatra azy?'). Aza mbola manome laharana fandoavam-bola na maka adiresy raha tsy manaiky mazava hividy izy.\n" +
    "6. DEMANDE D'INFOS PROGRESSIVE (TSIKILIKELY) : Rehefa nanaiky hividy izy vao maka commande tsikelikely (1. Nom complet -> 2. Numéro -> 3. Adresse Région/District/Fokontany/Repère -> 4. Paiement). Ne pose JAMAIS toutes les questions d'un coup.\n" +
    "7. PHOTOS DU PRODUIT : Si le client demande à voir ou demande des photos/sary du produit, ajoute [[SEND_IMAGES:NOM DU PRODUIT]] à la fin pour lui envoyer automatiquement les photos de la galerie.\n" +
    "8. TON NATUREL ET CHALEUREUX : Ton poli, accueillant, bienveillant et professionnel comme un vrai conseiller humain.\n" +
    "9. FORMAT PROPRE : Phrases courtes, saut de ligne entre les idées pour un texte facile à lire. N'utilise JAMAIS de markdown (* ou #).\n" +
    "10. HISTORIQUE : Tiens compte des échanges précédents dans la conversation pour ne pas reposer les mêmes questions.\n" +
    "11. FIDÉLITÉ ABSOLUE AU PROMPT ET AU CATALOGUE : Utilise UNIQUEMENT les produits, prix, stocks, conditions et informations fournis ci-dessus par l'administrateur. N'invente JAMAIS un produit, un prix, une promotion, un délai ou une caractéristique. Si l'info manque, dis-le honnêtement et propose l'alternative la plus proche du catalogue.\n" +
    "12. ANALYSE DU BESOIN AVANT DE VENDRE : Avant de proposer, comprends le vrai besoin du client (usage, problème à résoudre, budget, urgence). Si c'est flou, pose UNE question courte et ciblée. Puis recommande le produit du catalogue qui répond le mieux à CE besoin précis, en expliquant pourquoi il lui convient.\n" +
    "13. PERSUASION PROFESSIONNELLE : Mets en avant les BÉNÉFICES concrets pour le client (ce que le produit change pour lui), pas seulement les caractéristiques. Utilise la reformulation empathique ('Azoko tsara ny olanao...'), la preuve (qualité, garantie, satisfaction si fournies) et la valeur par rapport au prix.\n" +
    "14. TRAITEMENT DES OBJECTIONS : Si le client hésite (prix, confiance, livraison, efficacité), rassure-le calmement avec des arguments tirés du prompt/catalogue, sans jamais être agressif ni mentir, puis relance doucement vers la décision.\n" +
    "15. CONCLURE (CLOSING) : Termine chaque réponse commerciale par une question simple qui fait avancer vers l'achat (ex. 'Tianao ve hanafatra iray ho anao?' / 'Firy no ilainao?'). Dès qu'il manifeste de l'intérêt, guide-le immédiatement vers la commande.\n" +
    "16. UNE SEULE RÉPONSE : Donne une seule réponse cohérente, sans répéter deux fois le même paragraphe ou la même phrase.\n" +
    "17. EXPLICATIONS ENRICHIES : Si le client demande une explication sur un sujet du prompt (notion, méthode, usage, bienfaits), tu peux t'appuyer sur la recherche Internet pour expliquer plus clairement et plus en détail. Mais les prix, stocks, produits et conditions viennent UNIQUEMENT du prompt/catalogue, jamais d'Internet. Ne cite pas de liens ni de sources techniques.";

  const catalog = await buildCatalogContext(userId, pageId);

  const userInstructions = `INSTRUCTIONS DE L'ADMINISTRATEUR (à respecter STRICTEMENT, elles priment sur tout comportement par défaut) :\n\n${extras}`;

  const header =
    "Tu es une assistante virtuelle professionnelle. Tu dois suivre à la lettre les instructions de l'administrateur ci-dessous. Si aucune instruction ne couvre un cas, reste polie et propose de transmettre la demande.";

  const filesContext = await buildPromptFilesContext(
    userId,
    matchedRows.map((p: any) => p.id).filter(Boolean),
  );

  return [header, userInstructions, catalog, filesContext, styleRules].filter(Boolean).join("\n\n");
}

/** Fichiers (pdf, image, audio, vidéo) attachés aux prompts, envoyables en MP par l'IA. */
export type PromptFileRow = {
  id: string;
  label: string;
  description: string | null;
  media_type: string;
  mime_type: string;
  file_path: string;
  is_for_sale?: boolean | null;
  price?: number | null;
};

export async function listPromptFilesForAi(
  userId: string,
  promptIds: string[],
  allLinked = false,
): Promise<PromptFileRow[]> {
  try {
    const { data } = await supabaseAdmin
      .from("prompt_files")
      .select("id,label,description,media_type,mime_type,file_path,prompt_id,is_for_sale,price")
      .eq("user_id", userId);
    const rows = (data ?? []) as any[];
    // Chaque fichier appartient à SON prompt uniquement.
    return rows.filter(
      (r) => r.prompt_id && (allLinked || promptIds.includes(r.prompt_id)),
    ) as PromptFileRow[];
  } catch (e) {
    console.warn("[listPromptFilesForAi]", e);
    return [];
  }
}

const MEDIA_LABELS: Record<string, string> = {
  image: "Image",
  video: "Vidéo",
  audio: "Audio",
  file: "Document/PDF",
};

async function buildPromptFilesContext(userId: string, promptIds: string[]): Promise<string> {
  const files = await listPromptFilesForAi(userId, promptIds);
  if (files.length === 0) return "";

  const free = files.filter((f) => !f.is_for_sale);
  const paid = files.filter((f) => f.is_for_sale);
  const fmt = (f: PromptFileRow) =>
    `- ${f.label} [${MEDIA_LABELS[f.media_type] ?? f.media_type}]${
      f.is_for_sale ? ` — PRIX : ${Number(f.price ?? 0).toLocaleString("fr-FR")} Ar` : ""
    }${f.description ? ` : ${f.description}` : ""}`;

  let out = "";
  if (free.length > 0) {
    out +=
      "FICHIERS GRATUITS DISPONIBLES À ENVOYER AU CLIENT (pdf, image, audio, vidéo) :\n" +
      `${free.map(fmt).join("\n")}\n\n` +
      "RÈGLE D'ENVOI DES FICHIERS GRATUITS :\n" +
      "- Analysez ny anaran'ny fichiers etsy ambony ary ampitahao amin'izay nangatahin'ny mpanjifa.\n" +
      "- Alefa IHANY ny fichier(s) nangatahiny, fa tsy izy rehetra :\n" +
      "  * fichier iray nangatahina -> [[SEND_FILE:NOM EXACT DU FICHIER]]\n" +
      "  * fichiers roa na maromaro nangatahina -> [[SEND_FILE:NOM 1|NOM 2]] (na marqueur misaraka ho an'ny tsirairay)\n" +
      "  * raha mangataka mazava ny fichiers REHETRA izy (ohatra : « alefaso daholo », « tous les fichiers ») -> [[SEND_FILE:TOUS]]\n" +
      "- Aza mamorona anarana fichier tsy voatanisa etsy ambony.\n" +
      "- Tsy hita maso io marqueur io, aza hazavaina amin'ny mpanjifa, ary aza alefa raha tsy nangataka izy.\n\n";
  }
  if (paid.length > 0) {
    out +=
      "FICHIERS PAYANTS (PAIEMENT REQUIS) :\n" +
      `${paid.map(fmt).join("\n")}\n\n` +
      "RÈGLE DES FICHIERS PAYANTS (TSY AZO ALEFA MAIMAIMPOANA MIHITSY) :\n" +
      "- AZA MAMPIASA [[SEND_FILE]] mihitsy ho an'ireo fichiers ireo.\n" +
      "- Lazao ny vidiny ary asao handefa vola amin'ny fomba fandoavam-bola voalaza ao amin'ny catalogue/prompt ny mpanjifa.\n" +
      "- Rehefa milaza izy fa nandefa vola, angataho ny RÉFÉRENCE an'ilay paiement.\n" +
      "- Rehefa nomeny ny référence, avoahy indray mandeha monja ny marqueur :\n" +
      '  [[ORDER:{"file":"NOM EXACT DU FICHIER","item":"NOM EXACT DU FICHIER","payment_reference":"REFERENCE"}]]\n' +
      "- Avy eo lazao aminy fa voaray ny référence ary halefa ho azy ilay fichier rehefa voamarin'ny Admin ny paiement.\n" +
      "- Aza milaza mihitsy fa nalefa ilay fichier raha tsy mbola voamarina.";
  }
  return out.trim();
}

/** Fetch image from URL and encode to base64 for AI multimodal input. */
export async function fetchAsInlinePart(url: string): Promise<AiPart | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const mime = res.headers.get("content-type") ?? "image/jpeg";
    if (!mime.startsWith("image/")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return { inline_data: { mime_type: mime.split(";")[0], data: btoa(bin) } };
  } catch (e) {
    console.error("[fetchAsInlinePart]", e);
    return null;
  }
}

/** Fetch the parent post text of a comment for context. */
export async function fetchPostContext(postId: string, pageToken: string): Promise<string> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${postId}?fields=message,story&access_token=${pageToken}`,
    );
    const j: any = await res.json();
    return j.message ?? j.story ?? "";
  } catch {
    return "";
  }
}

/** Historique de conversation Messenger pour un expéditeur donné (mémoire). */
export async function fetchMessengerHistory(
  userId: string,
  pageId: string,
  senderId: string,
  limit = 20,
): Promise<ChatTurn[]> {
  const { data, error } = await supabaseAdmin
    .from("messages_log")
    .select("content,ai_response,direction,created_at")
    .eq("user_id", userId)
    .eq("page_id", pageId)
    .eq("sender_id", senderId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[fetchMessengerHistory]", error);
    return [];
  }
  const rows = (data ?? []).reverse();
  const turns: ChatTurn[] = [];
  for (const r of rows) {
    const text = (r.content ?? r.ai_response ?? "").toString().trim();
    if (!text) continue;
    turns.push({ role: directionToRole(r.direction), text });
  }
  console.log(`[memory] messenger history ${userId}/${pageId}/${senderId}: ${turns.length} turns`);
  return turns;
}

async function fetchGraphMessengerHistory(
  page: any,
  senderId: string,
  limit = 24,
): Promise<ChatTurn[]> {
  try {
    const url =
      `https://graph.facebook.com/v21.0/${page.page_id}/conversations` +
      `?platform=messenger&user_id=${encodeURIComponent(senderId)}` +
      `&fields=messages.limit(${Math.min(limit, 50)}){message,from,created_time}` +
      `&access_token=${page.page_access_token}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[memory] graph history ${res.status}: ${(await res.text()).slice(0, 180)}`);
      return [];
    }
    const json: any = await res.json();
    const messages: any[] = json?.data?.[0]?.messages?.data ?? [];
    const turns = messages
      .slice()
      .reverse()
      .map((m) => ({
        role: m.from?.id === page.page_id ? "assistant" : "user",
        text: String(m.message ?? "").trim(),
      }))
      .filter((t) => t.text) as ChatTurn[];
    console.log(`[memory] graph history ${page.page_id}/${senderId}: ${turns.length} turns`);
    return turns;
  } catch (e) {
    console.warn("[memory] graph history failed", e instanceof Error ? e.message : e);
    return [];
  }
}

async function fetchMessengerHistoryForReply(
  page: any,
  senderId: string,
  currentText: string,
  limit = 24,
): Promise<ChatTurn[]> {
  const dbHistory = await fetchMessengerHistory(page.user_id, page.page_id, senderId, limit);
  const graphHistory = await fetchGraphMessengerHistory(page, senderId, limit + 1);
  const current = (currentText || "").trim();
  const graphWithoutCurrent =
    current && graphHistory.at(-1)?.role === "user" && graphHistory.at(-1)?.text.trim() === current
      ? graphHistory.slice(0, -1)
      : graphHistory;

  const bestHistory =
    graphWithoutCurrent.length > dbHistory.length ? graphWithoutCurrent : dbHistory;
  return bestHistory.slice(-limit);
}

/** Send a Messenger reply. */
export async function sendMessengerReply(pageToken: string, recipientId: string, text: string) {
  const chunks = splitMessengerText(text);
  if (chunks.length === 0) return;
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: chunks[i] },
          messaging_type: "RESPONSE",
        }),
      },
    );
    if (!res.ok)
      throw new Error(
        `Messenger send part ${i + 1}/${chunks.length} ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
  }
}

/** Send a single image attachment via Messenger. Supports Data URLs, local file paths, and remote URLs with binary multipart upload. */
const APP_BASE_URL =
  process.env.APP_URL ||
  process.env.PUBLIC_URL ||
  "https://ais-dev-i7b5jeeh6qqkeyb3nv4dw4-469517843202.europe-west2.run.app";

function resolvePublicImageUrl(imagePathOrId: string, imageId?: string): string {
  if (imageId) {
    return `${APP_BASE_URL}/api/public/img?id=${encodeURIComponent(imageId)}`;
  }
  if (imagePathOrId.startsWith("http://") || imagePathOrId.startsWith("https://")) {
    return imagePathOrId;
  }
  return `${APP_BASE_URL}/api/public/img?path=${encodeURIComponent(imagePathOrId)}`;
}

function tryParseUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function stripDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

/** Safely fetch binary buffer of a Supabase Storage object by path or URL */
export async function downloadSupabaseStorageFile(
  bucket: string,
  objectPath: string,
  userId?: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const cleanPath = objectPath
    .replace(/^https?:\/\/[^\/]+\/storage\/v1\/object\/(?:public|sign|authenticated)\/[^\/]+\//, "")
    .replace(/^\/+/, "");

  // 1. Try JS SDK safely if storage client is present
  try {
    if (supabaseAdmin?.storage && typeof supabaseAdmin.storage.from === "function") {
      const storageBucket = supabaseAdmin.storage.from(bucket);
      if (typeof storageBucket?.download === "function") {
        const { data: stBlob, error: stErr } = await storageBucket.download(cleanPath);
        if (!stErr && stBlob) {
          const arrayBuf = await stBlob.arrayBuffer();
          return {
            buffer: Buffer.from(arrayBuf),
            mimeType: stBlob.type || "image/jpeg",
          };
        }
      }
    }
  } catch (e) {
    console.warn(
      "[downloadSupabaseStorageFile] JS SDK download skipped/failed:",
      e instanceof Error ? e.message : e,
    );
  }

  // 2. Derive userId from path prefix if not provided (e.g. "google_aG9yb.../folder/file.jpg")
  const derivedUserId = userId || (cleanPath.includes("/") ? cleanPath.split("/")[0] : null);

  let sbUrl: string | null = null;
  let sbKey: string | null = null;

  if (derivedUserId) {
    try {
      const { data: settings } = await supabaseAdmin
        .from("settings")
        .select("supabase_project_url,supabase_anon_key")
        .eq("user_id", derivedUserId)
        .maybeSingle();

      if (settings?.supabase_project_url && settings?.supabase_anon_key) {
        sbUrl = settings.supabase_project_url.replace(/\/$/, "");
        sbKey = settings.supabase_anon_key.trim();
      } else {
        const { data: conn } = await supabaseAdmin
          .from("supabase_oauth_connections")
          .select("selected_project_url,access_token,projects")
          .eq("user_id", derivedUserId)
          .maybeSingle();

        if (conn?.selected_project_url) {
          sbUrl = conn.selected_project_url.replace(/\/$/, "");
          const proj = (conn.projects as any[])?.find(
            (p) => p.project_url === conn.selected_project_url,
          );
          sbKey = proj?.anon_key || conn.access_token;
        }
      }
    } catch (dbErr) {
      console.warn("[downloadSupabaseStorageFile] DB lookup error:", dbErr);
    }
  }

  // 3. REST API attempts if sbUrl is available
  if (sbUrl) {
    const endpoints = [
      `${sbUrl}/storage/v1/object/public/${bucket}/${encodeURIComponent(cleanPath)}`,
      `${sbUrl}/storage/v1/object/public/${bucket}/${cleanPath}`,
      `${sbUrl}/storage/v1/object/authenticated/${bucket}/${cleanPath}`,
    ];

    for (const url of endpoints) {
      try {
        const headers: Record<string, string> = {};
        if (sbKey) {
          headers["Authorization"] = `Bearer ${sbKey}`;
          headers["apikey"] = sbKey;
        }
        const res = await fetch(url, { headers });
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          const mimeType = res.headers.get("content-type") || "image/jpeg";
          return { buffer: Buffer.from(arrayBuf), mimeType };
        }
      } catch (fetchErr) {
        // continue
      }
    }
  }

  return null;
}

export async function getMessengerImageSource(
  rawUrlOrPath: string,
  imageId?: string,
): Promise<{
  publicUrl: string | null;
  buffer: Buffer | null;
  mimeType: string;
  filename: string;
}> {
  let target = rawUrlOrPath;
  let mimeType = "image/jpeg";
  let filename = "image.jpg";
  let targetUserId: string | undefined = undefined;

  // 0. If imageId is provided, fetch image_path from product_images
  if (imageId) {
    const { data: imgRow } = await supabaseAdmin
      .from("product_images")
      .select("image_path, user_id")
      .eq("id", imageId)
      .maybeSingle();
    if (imgRow?.image_path) {
      target = imgRow.image_path;
      if (imgRow.user_id) targetUserId = imgRow.user_id;
    }
  }

  if (!target) {
    return { publicUrl: null, buffer: null, mimeType, filename };
  }

  // 1. Data URL (Base64)
  if (target.startsWith("data:image/") || target.startsWith("data:application/")) {
    const parsed = stripDataUrl(target);
    if (parsed) {
      const buffer = Buffer.from(parsed.base64, "base64");
      mimeType = parsed.mime || "image/jpeg";
      const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
      filename = `image.${ext}`;
      return { publicUrl: null, buffer, mimeType, filename };
    }
  }

  // 2. Local Filesystem check (handles local uploads in public/uploads/ or public/)
  const parsedUrl =
    target.startsWith("http://") || target.startsWith("https://") ? tryParseUrl(target) : null;
  const urlPathname = parsedUrl ? parsedUrl.pathname : target;
  const cleanPath = urlPathname.replace(/^\/+/, "");
  const baseName = path.basename(cleanPath);

  const possibleLocalPaths = [
    path.join(process.cwd(), "public", "uploads", baseName),
    path.join(process.cwd(), "public", cleanPath.replace(/^public\//, "")),
    path.join(process.cwd(), cleanPath),
  ];

  for (const p of possibleLocalPaths) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      try {
        const buffer = fs.readFileSync(p);
        const ext = path.extname(p).toLowerCase();
        mimeType =
          ext === ".png"
            ? "image/png"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".gif"
                ? "image/gif"
                : "image/jpeg";
        filename = baseName || `image${ext || ".jpg"}`;
        return { publicUrl: null, buffer, mimeType, filename };
      } catch (fsErr) {
        console.warn("[getMessengerImageSource] local read error:", fsErr);
      }
    }
  }

  // 3. Supabase Storage download
  try {
    const downloaded = await downloadSupabaseStorageFile("product-images", target, targetUserId);
    if (downloaded) {
      mimeType = downloaded.mimeType;
      const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
      filename = baseName || `product.${ext}`;
      return {
        publicUrl: target.startsWith("http") ? target : resolvePublicImageUrl(target, imageId),
        buffer: downloaded.buffer,
        mimeType,
        filename,
      };
    }
  } catch (stErr) {
    console.warn("[getMessengerImageSource] Supabase Storage error:", stErr);
  }

  // 4. Remote HTTP/HTTPS URL
  if (target.startsWith("http://") || target.startsWith("https://")) {
    const isDevUrl =
      target.includes("localhost") || target.includes("ais-dev") || target.includes("ais-pre");
    let publicUrl = isDevUrl ? null : target;

    try {
      const res = await fetch(target);
      if (res.ok) {
        const ct = res.headers.get("content-type") || "";
        if (ct.startsWith("image/")) {
          const arrayBuf = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          mimeType = ct;
          const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
          filename = baseName || `image.${ext}`;
          return { publicUrl, buffer, mimeType, filename };
        }
      }
    } catch (e) {
      console.warn("[getMessengerImageSource] remote fetch failed:", e);
    }

    if (publicUrl) {
      return { publicUrl, buffer: null, mimeType, filename };
    }
  }

  const proxyUrl = resolvePublicImageUrl(target, imageId);
  return { publicUrl: proxyUrl, buffer: null, mimeType, filename };
}

/** Send a single image attachment via Messenger. Supports fast binary FormData upload with URL fallback. */
async function sendMessengerImage(
  pageToken: string,
  recipientId: string,
  rawUrlOrPath: string,
  imageId?: string,
) {
  const source = await getMessengerImageSource(rawUrlOrPath, imageId);

  // Strategy A: Direct Multipart Binary Upload via Blob (Works 100% reliably in server environments)
  if (source.buffer && source.buffer.length > 0) {
    try {
      const blob = new Blob([source.buffer as unknown as BlobPart], { type: source.mimeType });
      const form = new FormData();
      form.append("recipient", JSON.stringify({ id: recipientId }));
      form.append("message", JSON.stringify({ attachment: { type: "image", payload: {} } }));
      form.append("filedata", blob, source.filename);
      form.append("messaging_type", "RESPONSE");

      const res = await fetch(
        `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`,
        {
          method: "POST",
          body: form,
        },
      );

      if (res.ok) {
        console.log(
          `[sendMessengerImage] Sent binary image successfully (${source.buffer.length} bytes, ${source.mimeType})`,
        );
        return;
      }

      const errText = await res.text();
      console.warn(
        `[sendMessengerImage:binary] Facebook API error ${res.status}: ${errText}, trying public URL...`,
      );
    } catch (binErr) {
      console.warn("[sendMessengerImage:binary] Upload error:", binErr);
    }
  }

  // Strategy B: Standard URL payload fallback
  if (source.publicUrl) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: {
              attachment: {
                type: "image",
                payload: { url: source.publicUrl },
              },
            },
            messaging_type: "RESPONSE",
          }),
        },
      );

      if (res.ok) {
        console.log("[sendMessengerImage] Sent successfully via public URL payload");
        return;
      }
      const errText = await res.text();
      console.error(`[sendMessengerImage:url] Facebook API error (${res.status}): ${errText}`);
    } catch (urlErr) {
      console.error("[sendMessengerImage:url] network error:", urlErr);
    }
  }

  throw new Error(`Unable to send Messenger image for: ${rawUrlOrPath}`);
}

const recentMidCache = new Map<string, number>();

function isDuplicateMid(mid: string): boolean {
  if (!mid) return false;
  const now = Date.now();
  for (const [k, ts] of recentMidCache.entries()) {
    if (now - ts > 300000) recentMidCache.delete(k);
  }
  if (recentMidCache.has(mid)) return true;
  recentMidCache.set(mid, now);
  return false;
}

async function claimFacebookEvent(eventType: "message" | "comment", eventId: string) {
  if (!eventId) return null;
  const jobName = `facebook-${eventType}:${eventId}`.slice(0, 240);
  const { data: claimed, error } = await (supabaseAdmin as any).rpc("claim_background_job", {
    _job_name: jobName,
    _lease_seconds: 300,
  });
  if (error) {
    console.error(`[dedup] unable to claim ${eventType}`, error.message);
    return null;
  }
  return claimed ? jobName : null;
}

async function finishFacebookEvent(jobName: string, succeeded: boolean) {
  await (supabaseAdmin as any).rpc("finish_background_job", {
    _job_name: jobName,
    // A completed event remains paused so another server instance can never
    // send the same Facebook reply again. Failed events remain retryable.
    _status: succeeded ? "paused" : "failed",
    _result: { completed: succeeded, at: new Date().toISOString() },
  });
}

/** Cross-instance lock for ONE conversation, shared by the webhook and the
 *  batch/cron path. Both paths use this identical key, which is what actually
 *  prevents duplicate replies (message ids differ between the two sources).
 *  `retries` lets a caller wait for a busy conversation instead of dropping the
 *  client's message: with several people writing at the same time, a short wait
 *  is much better than never answering. */
async function claimConversation(
  pageId: string,
  senderId: string,
  retries = 0,
  retryDelayMs = 1500,
): Promise<string | null> {
  if (!pageId || !senderId) return null;
  const jobName = `facebook-convo:${pageId}:${senderId}`.slice(0, 240);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { data: claimed, error } = await (supabaseAdmin as any).rpc("claim_background_job", {
      _job_name: jobName,
      _lease_seconds: 120,
    });
    if (error) {
      console.error("[dedup] unable to claim conversation", error.message);
      return null;
    }
    if (claimed) return jobName;
    if (attempt < retries) await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  // ANTI-VERROUILLAGE : une conversation ne doit JAMAIS rester bloquée.
  // Si le bail est toujours pris (instance morte, run interrompu), on le libère
  // de force puis on reprend la main. En dernier recours on continue quand même :
  // les doublons restent empêchés par le garde mémoire + la vérification
  // "déjà répondu" avant l'envoi.
  await (supabaseAdmin as any).rpc("finish_background_job", {
    _job_name: jobName,
    _status: "idle",
    _result: { force_unlock: true, at: new Date().toISOString() },
  });
  const { data: reclaimed } = await (supabaseAdmin as any).rpc("claim_background_job", {
    _job_name: jobName,
    _lease_seconds: 120,
  });
  if (reclaimed) return jobName;
  console.warn("[anti-lock] proceeding without lease for", jobName);
  return jobName;
}

/** Release the conversation lock so the next incoming message can be answered. */
async function releaseConversation(jobName: string | null) {
  if (!jobName) return;
  await (supabaseAdmin as any).rpc("finish_background_job", {
    _job_name: jobName,
    _status: "idle",
    _result: { at: new Date().toISOString() },
  });
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function safeParseOrderJson(jsonStr: string): any {
  if (!jsonStr) return null;
  // 1. Standard JSON.parse
  try {
    return JSON.parse(jsonStr);
  } catch {}

  // 2. Attempt cleanup of single quotes, unescaped newlines, trailing commas
  try {
    let cleaned = jsonStr.trim();
    // Only convert single quotes used as JSON delimiters. A blanket replace
    // would corrupt apostrophes inside names/addresses (ex: "Lot II L'Église").
    cleaned = cleaned.replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3');
    cleaned = cleaned.replace(/(:\s*)'([^']*)'(\s*[,}])/g, '$1"$2"$3');
    cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
    cleaned = cleaned.replace(/\r?\n/g, " ");
    return JSON.parse(cleaned);
  } catch {}

  // 3. Fallback regex field extraction
  try {
    const extract = (key: string) => {
      const match =
        jsonStr.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, "i")) ||
        jsonStr.match(new RegExp(`'${key}'\\s*:\\s*'([^']*)'`, "i")) ||
        jsonStr.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "i"));
      return match ? match[1] : null;
    };
    const product =
      extract("product") || extract("training") || extract("article") || extract("item");
    const name = extract("client_fb_name") || extract("client_name") || extract("name");
    const phone = extract("client_phone") || extract("phone") || extract("telephone");
    const whatsapp = extract("client_whatsapp") || extract("whatsapp");
    const address = extract("client_address") || extract("address") || extract("adresse");
    const type = extract("type") || (product ? "sales" : "training");
    const quantity = extract("quantity") ? Number(extract("quantity")) : 1;
    const ref = extract("payment_reference") || extract("reference");
    const notes = extract("notes");

    if (product || name || phone || address) {
      return {
        type,
        product,
        client_fb_name: name,
        client_phone: phone,
        client_whatsapp: whatsapp,
        client_address: address,
        quantity,
        payment_reference: ref,
        notes,
      };
    }
  } catch {}

  return null;
}

export async function fetchFbSenderName(
  senderId: string,
  pageToken: string,
): Promise<string | null> {
  if (!senderId || !pageToken) return null;
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${senderId}?fields=name&access_token=${pageToken}`,
    );
    if (res.ok) {
      const data: any = await res.json();
      return data.name || null;
    }
  } catch {}
  return null;
}

/** Parse and strip [[ORDER:{...}]] and [[SEND_IMAGES:name]] markers.
 *  Returns cleaned text plus the actions to execute. */
export function extractAiActions(text: string): {
  cleanText: string;
  orders: any[];
  imageRequests: string[];
  fileRequests: string[];
} {
  const safeText = typeof text === "string" ? text : String(text ?? "");
  const orders: any[] = [];
  const imageRequests: string[] = [];
  const fileRequests: string[] = [];
  let cleaned = safeText;

  cleaned = cleaned.replace(/\[\[?\s*ORDER:\s*(\{[\s\S]*?\})\s*\]\]?/gi, (_, json) => {
    const parsed = safeParseOrderJson(json);
    if (parsed) {
      orders.push(parsed);
    } else {
      console.warn("[extractAiActions] bad ORDER json:", json.slice(0, 200));
    }
    return "";
  });

  // Fichiers attachés aux prompts (pdf, image, audio, vidéo)
  cleaned = cleaned.replace(
    /\[\[?\s*(?:SEND_?FILES?|SEND_?FICHIERS?|SEND_?DOC(?:UMENT)?S?|SEND_?PDFS?|SEND_?VIDEOS?|SEND_?AUDIOS?|FICHIERS?)(?::\s*([^\]\n]*?))?\s*\]\]?/gi,
    (_, name) => {
      fileRequests.push(String(name || "").trim());
      return "";
    },
  );

  cleaned = cleaned.replace(
    /\[\[?\s*(?:SEND_?IMAGE_?ID|IMAGE_?ID|SEND_?IMAGE|SEND_?IMAGES?|SENDIMAGES?|SEND_?PHOTOS?|SENDPHOTOS?|IMAGES?|PHOTOS?|SARY|VOIR_?IMAGES?)(?::\s*([^\]\n]*?))?\s*\]\]?/gi,
    (_, name) => {
      imageRequests.push(String(name || "").trim());
      return "";
    },
  );

  // Remove any remaining internal brackets or technical strings
  cleaned = cleaned.replace(/\[\[[\s\S]*?\]\]/g, "");
  cleaned = cleaned.replace(
    /\[(?:SEND_?IMAGE_?ID|SEND_?IMAGES?|SENDIMAGES?|SEND_?PHOTOS?|SENDPHOTOS?|SEND_?FILES?|SEND_?PDFS?|ORDER)[^\]]*\]/gi,
    "",
  );

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText: cleaned, orders, imageRequests, fileRequests };
}

/** Persist an AI-emitted order into the orders table. */
async function persistAiOrder(
  userId: string,
  pageId: string,
  senderId: string,
  senderName: string | null,
  order: any,
) {
  try {
    // Remove polite prefixes / filler the client typed around the real value
    // (e.g. "Eny tompoko: Ravelomanantsoa Urmin" -> "Ravelomanantsoa Urmin").
    const stripPolite = (value: string): string => {
      let out = value.trim();
      // repeatedly strip leading politeness words followed by :/,/- or space
      const politeRe =
        /^(?:eny|ie|ok+|okay|d'accord|daccord|misaotra|azafady|tompoko|tompoko\s*o|salama|bonjour|voici|ity|itony|ny\s+anarako\s+dia|anarako\s+dia|anarako|ny\s+adiresiko\s+dia|adiresiko\s+dia|adiresiko|ny\s+laharako\s+dia|laharako\s+dia|laharako|mon\s+nom\s+est|je\s+m'appelle|mon\s+adresse\s+est|nom|anarana|adiresy|adresse|numero|numéro|laharana)\b[\s:,;.\-–]*/i;
      for (let i = 0; i < 6; i++) {
        const next = out.replace(politeRe, "").trim();
        if (next === out) break;
        out = next;
      }
      return out.replace(/^[:,;.\-–\s]+/, "").trim();
    };

    const cleanShortField = (value: unknown, maxLength: number): string | null => {
      if (typeof value !== "string") return null;
      const clean = stripPolite(value.replace(/\s+/g, " ").trim());
      if (!clean || clean.length > maxLength || clean.includes("[[")) return null;
      return clean;
    };
    const cleanPhone = (value: unknown): string | null => {
      const clean = cleanShortField(value, 40);
      if (!clean) return null;
      const match = clean.match(
        /(\+?261\s*[.-]?\s*3[234789](?:\s*[.-]?\s*\d){7}|\b0?3[234789](?:\s*[.-]?\s*\d){7}\b|\b\d{10}\b)/,
      );
      return match ? match[0].replace(/[\s.-]/g, "") : null;
    };
    const cleanName = (value: unknown): string | null => {
      let clean = cleanShortField(value, 80);
      if (!clean) return null;
      // Keep only the name part when extra sentence follows.
      clean = clean.split(/[,;.\n]/)[0]!.trim();
      if (
        !clean ||
        /\d|[.!?]{2,}|\b(?:client|assistant|discussion|commande|message)\b/i.test(clean)
      ) {
        return null;
      }
      return clean.split(/\s+/).length <= 8 ? clean : null;
    };
    const cleanAddress = (value: unknown): string | null => {
      let clean = cleanShortField(value, 400);
      if (!clean || /\b(?:assistant|system prompt|discussion|réponse de l'ia)\b/i.test(clean)) {
        return null;
      }
      // Drop phone numbers and trailing thanks from the address string.
      clean = clean
        .replace(/(\+?261[\s.-]?)?\b0?3[234789][\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{2}\b/g, "")
        .replace(/\b(misaotra|merci|azafady|tompoko)\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .replace(/^[\s:,;.\-–/]+|[\s:,;.\-–/]+$/g, "")
        .trim();
      return clean || null;
    };

    // 1. Intelligent order type determination
    let type: "sales" | "training" = "sales";
    if (order.type === "training" || (!order.product && order.training)) {
      type = "training";
    } else if (order.type === "sales" || order.product) {
      type = "sales";
    } else {
      const { data: st } = await supabaseAdmin
        .from("settings")
        .select("assistance_type")
        .eq("user_id", userId)
        .maybeSingle();
      type = (st as any)?.assistance_type === "training" ? "training" : "sales";
    }

    let productId: string | null = null;
    let trainingId: string | null = null;

    if (type === "sales" && order.product) {
      const { data: allProds } = await supabaseAdmin
        .from("products")
        .select("id,name,page_ids")
        .eq("user_id", userId);
      const prods = (allProds ?? []).filter(
        (p: any) => Array.isArray(p.page_ids) && pageId && p.page_ids.includes(String(pageId)),
      );
      const target = normalizeName(String(order.product));
      const match =
        (prods ?? []).find((p: any) => normalizeName(p.name) === target) ??
        (prods ?? []).find(
          (p: any) =>
            normalizeName(p.name).includes(target) || target.includes(normalizeName(p.name)),
        );
      productId = match?.id ?? null;
    }
    if (type === "training" && order.training) {
      const { data: trs } = await supabaseAdmin
        .from("trainings")
        .select("id,name")
        .eq("user_id", userId);
      const target = normalizeName(String(order.training));
      const match =
        (trs ?? []).find((t: any) => normalizeName(t.name) === target) ??
        (trs ?? []).find(
          (t: any) =>
            normalizeName(t.name).includes(target) || target.includes(normalizeName(t.name)),
        );
      trainingId = match?.id ?? null;
    }

    const fbName = senderName || null;
    let finalName: string | null = null;
    let finalPhone: string | null = null;
    let finalWhatsapp: string | null = null;
    let finalAddress: string | null = null;

    // Client identity is authoritative only when it comes from the client's
    // own messages. The AI-generated ORDER block is intentionally ignored for
    // these fields because it can paraphrase or invent values.
    {
      const { data: recentLogs } = await supabaseAdmin
        .from("messages_log")
        .select("content, sender_name, direction, created_at")
        .eq("user_id", userId)
        .eq("page_id", pageId)
        .eq("sender_id", senderId)
        .order("created_at", { ascending: false })
        .limit(40);

      const chronological = [...(recentLogs ?? [])].reverse();
      const clientMsgs = chronological
        .filter((l: any) => directionToRole(l.direction ?? "incoming") === "user")
        .map((l: any) => String(l.content ?? "").trim())
        .filter(Boolean);

      const phoneRe =
        /(\+?261\s*[\s.-]?3[234789][\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{2}|\b0?3[234789][\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{2}\b|\b\d{10}\b)/;
      const addressRe =
        /(region|région|district|commune|fokontany|quartier|lot\s|adresse|adiresy|repere|repère|antanana|village|rue|villa|cité|cite)/i;
      const nameLabelRe =
        /(?:anarana\s*feno|anaranao|anarana|nom\s*complet|nom)\s*[:=-]\s*([A-Za-zÀ-ÿ' -]{3,60})/i;
      const addressLabelRe = /(?:adiresy|adresse)\s*[:=-]\s*(.{6,400})/i;

      for (const txt of clientMsgs) {
        if (!finalPhone) {
          const m = txt.match(phoneRe);
          if (m) finalPhone = m[0].replace(/[\s.-]/g, "");
        }
        if (!finalAddress) {
          const labelledAddress = txt.match(addressLabelRe)?.[1];
          if (labelledAddress) finalAddress = cleanAddress(labelledAddress);
          else if (addressRe.test(txt) && txt.length >= 6) finalAddress = cleanAddress(txt);
        }
        if (!finalName) {
          const m = txt.match(nameLabelRe);
          if (m?.[1]) finalName = cleanName(m[1]);
        }
      }

      // A plain client answer is accepted only when it immediately follows an
      // explicit request for that exact field from the assistant.
      for (let i = 0; i < chronological.length - 1; i++) {
        const ask = chronological[i];
        const answer = chronological[i + 1];
        if (directionToRole(ask.direction ?? "incoming") !== "assistant") continue;
        if (directionToRole(answer.direction ?? "incoming") !== "user") continue;
        const question = String(ask.content ?? "");
        const value = String(answer.content ?? "").trim();
        if (!finalName && /anarana(?:o)?(?:\s*feno)?|nom\s*complet/i.test(question)) {
          finalName = cleanName(value);
        }
        if (
          !finalPhone &&
          /laharana|finday|téléphone|telephone|whatsapp|numéro|numero/i.test(question)
        ) {
          finalPhone = cleanPhone(value);
        }
        if (
          !finalAddress &&
          /adiresy|adresse|fokontany|district|région|region|repère|repere/i.test(question)
        ) {
          finalAddress = cleanAddress(value);
        }
      }

      if (!finalName) {
        finalName = chronological.find((l: any) => l.sender_name)?.sender_name ?? null;
      }
    }

    if (!finalName) finalName = fbName;
    finalWhatsapp = finalPhone;

    // Libellé de l'article : catalogue OU commande temporaire définie par le prompt.
    const itemLabel =
      cleanShortField(order.product ?? order.training ?? order.item ?? order.article, 120) ??
      "Produit";

    // Commande temporaire : tous les champs libres inventés dans le prompt
    // (hors champs standards) sont conservés dans les notes.
    const KNOWN_KEYS = new Set([
      "type",
      "product",
      "training",
      "item",
      "article",
      "quantity",
      "client_fb_name",
      "client_name",
      "name",
      "client_phone",
      "phone",
      "telephone",
      "client_whatsapp",
      "whatsapp",
      "client_address",
      "address",
      "adresse",
      "payment_reference",
      "reference",
      "notes",
      "file",
      "fichier",
    ]);
    const extraParts: string[] = [];
    for (const [k, v] of Object.entries(order ?? {})) {
      if (KNOWN_KEYS.has(k.toLowerCase())) continue;
      const val = cleanShortField(typeof v === "string" ? v : String(v ?? ""), 200);
      if (val) extraParts.push(`${k}: ${val}`);
    }
    const freeNotes = cleanShortField(order.notes, 500);
    const notesValue =
      [
        !productId && !trainingId ? `Article: ${itemLabel}` : null,
        freeNotes,
        extraParts.length ? extraParts.join(" | ") : null,
      ]
        .filter(Boolean)
        .join(" | ") || null;

    const paymentRef = (() => {
      const ref = cleanShortField(order.payment_reference, 60);
      if (!ref) return null;
      if (/[.!?]|\s{2,}/.test(ref) || ref.split(/\s+/).length > 6) return null;
      return ref;
    })();
    const quantityValue = Number(order.quantity) > 0 ? Number(order.quantity) : 1;

    // Fichier payant commandé (clé "file" dans le marqueur ORDER).
    let promptFileId: string | null = null;
    {
      const fileName = cleanShortField(order.file ?? order.fichier, 200);
      if (fileName) {
        const paid = (await listPromptFilesForAi(userId, [], true)).filter((f) => f.is_for_sale);
        const m = matchPromptFile(paid, fileName);
        promptFileId = m?.id ?? null;
      }
    }

    const { error: insErr } = await supabaseAdmin.from("orders").insert({
      user_id: userId,
      page_id: pageId,
      type,
      product_id: productId,
      training_id: trainingId,
      client_fb_id: senderId,
      client_fb_name: finalName || "Mpanjifa Messenger",
      client_whatsapp: finalWhatsapp,
      client_phone: finalPhone,
      client_address: finalAddress,
      // Never store free-form AI text as a payment reference: keep it short,
      // marker-free and sentence-free, otherwise drop it.
      payment_reference: paymentRef,
      quantity: quantityValue,
      notes: notesValue,
      prompt_file_id: promptFileId,
      status: promptFileId && paymentRef ? "payment_sent" : "pending",
    });

    if (insErr) {
      console.error("[persistAiOrder] insert error:", insErr.message);
    } else {
      console.log(
        `[persistAiOrder] Successfully created order for ${finalName || senderId} (${type})`,
      );
      // Alerte Messenger ciblée : uniquement les PSID enregistrés et activés.
      try {
        const { notifyOrderToRecipients } = await import("@/lib/client-notify.server");
        await notifyOrderToRecipients(userId, {
          type,
          item: itemLabel,
          quantity: quantityValue,
          client_fb_name: finalName || "Mpanjifa Messenger",
          client_phone: finalPhone,
          client_whatsapp: finalWhatsapp,
          client_address: finalAddress,
          payment_reference: paymentRef,
          notes: notesValue,
          status: "pending",
        });
      } catch (e) {
        console.error("[persistAiOrder] notification ciblée erreur", e);
      }
      // Envoi temps réel de la commande sur WhatsApp (best effort).
      try {
        const { notifyOrderOnWhatsApp } = await import("@/lib/whatsapp.server");
        const res = await notifyOrderOnWhatsApp({
          type,
          item: itemLabel,
          quantity: quantityValue,
          client_fb_name: finalName || "Mpanjifa Messenger",
          client_phone: finalPhone,
          client_whatsapp: finalWhatsapp,
          client_address: finalAddress,
          payment_reference: paymentRef,
          notes: notesValue,
          status: "pending",
          source: "Messenger / IA",
        });
        if (!res.sent) console.warn("[persistAiOrder] whatsapp not sent:", res.error);
      } catch (e) {
        console.error("[persistAiOrder] whatsapp error", e);
      }
    }
  } catch (e) {
    console.error("[persistAiOrder] Error:", e);
  }
}

/** Send product photos or specific image by ID for a client. */
async function sendProductImagesForClient(
  userId: string,
  pageId: string,
  pageToken: string,
  senderId: string,
  queryParam: string,
): Promise<{ sent: number; note: string }> {
  const cleanParam = (queryParam || "").trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanParam);

  // 1. If queryParam is a specific Image ID (UUID)
  if (isUuid) {
    const { data: imgRow } = await supabaseAdmin
      .from("product_images")
      .select("id, image_path, product_id, products(name)")
      .eq("id", cleanParam)
      .maybeSingle();

    if (imgRow?.image_path) {
      try {
        await sendMessengerImage(pageToken, senderId, imgRow.image_path, imgRow.id);
        const productName = (imgRow as any).products?.name || "Produit";
        await insertMessageLog(
          {
            user_id: userId,
            page_id: pageId,
            sender_id: senderId,
            content: `[Sary : ${productName}]`,
            media_type: "image",
            media_url: resolvePublicImageUrl(imgRow.image_path, imgRow.id),
            direction: OUTGOING_DIRECTION,
            status: "sent",
          },
          "image-sent",
        );
        return { sent: 1, note: `sent-image-id:${imgRow.id}` };
      } catch (e) {
        console.error("[sendProductImagesForClient by image ID]", e);
      }
    }
  }

  // 2. Otherwise, lookup by Product Name or Product ID
  const { data: allProds } = await supabaseAdmin
    .from("products")
    .select("id,name,page_ids, product_images(id, image_path, sort_order)")
    .eq("user_id", userId)
    .eq("is_active", true);
  // Strict : uniquement les produits sélectionnés pour CETTE page.
  const prods = (allProds ?? []).filter(
    (p: any) => Array.isArray(p.page_ids) && pageId && p.page_ids.includes(String(pageId)),
  );

  if (!prods || prods.length === 0) return { sent: 0, note: "no-products" };

  let product: any = null;
  const target = normalizeName(cleanParam);
  const genericWords = new Set([
    "sary",
    "sarin",
    "photo",
    "photos",
    "image",
    "images",
    "apercu",
    "voir",
    "jereo",
    "produit",
    "produits",
    "all",
    "galerie",
    "",
  ]);
  const isGeneric = !target || genericWords.has(target);

  if (!isGeneric && target) {
    product =
      prods.find((p: any) => p.id === cleanParam || normalizeName(p.name) === target) ??
      prods.find(
        (p: any) =>
          normalizeName(p.name).includes(target) || target.includes(normalizeName(p.name)),
      );
  }

  // If matched product has no images or target was generic, find first product with images
  if (!product || !Array.isArray(product.product_images) || product.product_images.length === 0) {
    product =
      prods.find((p: any) => Array.isArray(p.product_images) && p.product_images.length > 0) ||
      prods[0];
  }

  let images = (product.product_images ?? []).sort(
    (a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );

  // Absolute fallback: query product_images directly for this user
  if (!images || images.length === 0) {
    const { data: directImgs } = await supabaseAdmin
      .from("product_images")
      .select("id, image_path")
      .eq("user_id", userId)
      .limit(10);
    if (directImgs && directImgs.length > 0) {
      images = directImgs;
    }
  }

  if (!images || images.length === 0) return { sent: 0, note: "no-images" };

  // Read offset from client_ia_state
  const { data: state } = await supabaseAdmin
    .from("client_ia_state")
    .select("product_image_offsets")
    .eq("user_id", userId)
    .eq("page_id", pageId)
    .eq("client_fb_id", senderId)
    .maybeSingle();
  const offsets = ((state as any)?.product_image_offsets ?? {}) as Record<string, number>;
  let offset = offsets[product.id || "default"] ?? 0;
  if (offset >= images.length) {
    offset = 0;
  }

  // Send 1 image per request for maximum stability & no rate limits
  const batch = images.slice(offset, offset + 1);
  if (batch.length === 0) return { sent: 0, note: "already-sent-all" };

  let sent = 0;
  for (const img of batch) {
    if (!img.image_path) continue;
    try {
      await sendMessengerImage(pageToken, senderId, img.image_path, img.id);
      sent++;
      await insertMessageLog(
        {
          user_id: userId,
          page_id: pageId,
          sender_id: senderId,
          content: `[Sary : ${product.name || "Produit"}]`,
          media_type: "image",
          media_url: resolvePublicImageUrl(img.image_path, img.id),
          direction: OUTGOING_DIRECTION,
          status: "sent",
        },
        "image-sent",
      );
    } catch (e) {
      console.error("[sendProductImagesForClient batch]", e);
    }
  }

  const newOffsets = { ...offsets, [product.id || "default"]: offset + sent };
  await supabaseAdmin.from("client_ia_state").upsert(
    {
      user_id: userId,
      page_id: pageId,
      client_fb_id: senderId,
      product_image_offsets: newOffsets,
    },
    { onConflict: "user_id,page_id,client_fb_id" },
  );

  return { sent, note: `batch:${sent}/${images.length}` };
}

/** Trouve le fichier de prompt correspondant au nom demandé par l'IA. */
/** Normalisation commune (sans accents, sans ponctuation). */
function normPromptText(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ORDINAL_WORDS: Record<string, string> = {
  premiere: "1",
  premier: "1",
  deuxieme: "2",
  seconde: "2",
  second: "2",
  troisieme: "3",
  quatrieme: "4",
  cinquieme: "5",
  sixieme: "6",
  septieme: "7",
  huitieme: "8",
  neuvieme: "9",
  dixieme: "10",
  onzieme: "11",
  douzieme: "12",
  terminale: "terminale",
};

/**
 * Tokenise un libellé/une demande : « REPARTITION-6ème » et « classe de 6eme »
 * partagent alors le token « 6 ».
 */
function promptFileTokens(s: string): string[] {
  const base = normPromptText(s)
    // 6eme / 6e / 6 eme -> 6
    .replace(/(\d+)\s*(eme|e|er|ere|nd|nde)\b/g, "$1")
    .split(" ")
    .filter(Boolean);
  const out: string[] = [];
  for (const raw of base) {
    const mapped = ORDINAL_WORDS[raw] ?? raw;
    if (mapped.length >= 1) out.push(mapped);
  }
  return out;
}

const PROMPT_FILE_STOPWORDS = new Set([
  "de",
  "du",
  "des",
  "la",
  "le",
  "les",
  "un",
  "une",
  "et",
  "sy",
  "ny",
  "ou",
  "pour",
  "classe",
  "fichier",
  "fichiers",
  "rakitra",
  "pdf",
  "document",
  "documents",
  "doc",
  "svp",
  "azafady",
  "tompoko",
  "mba",
  "ilay",
  "izy",
  "aho",
  "veux",
  "voudrais",
  "envoie",
  "envoyez",
  "alefaso",
  "andefaso",
  "omeo",
  "tiako",
  "programme",
  "programa",
  "etudes",
  "etude",
]);

/** Score de correspondance entre un libellé de fichier et une demande. */
function scorePromptFile(label: string, request: string): number {
  const labelTokens = promptFileTokens(label);
  const reqTokens = promptFileTokens(request);
  if (labelTokens.length === 0 || reqTokens.length === 0) return 0;

  const labelSet = new Set(labelTokens);
  const reqSet = new Set(reqTokens);

  const labelNums = labelTokens.filter((t) => /^\d+$/.test(t));
  const reqNums = reqTokens.filter((t) => /^\d+$/.test(t));
  // Un numéro de classe/niveau qui diffère = fichier différent.
  if (labelNums.length > 0 && reqNums.length > 0) {
    if (!labelNums.some((n) => reqNums.includes(n))) return 0;
  }

  let score = 0;
  for (const t of labelSet) {
    if (PROMPT_FILE_STOPWORDS.has(t)) continue;
    if (reqSet.has(t)) score += /^\d+$/.test(t) ? 3 : 2;
  }
  for (const t of reqSet) {
    if (PROMPT_FILE_STOPWORDS.has(t) || labelSet.has(t)) continue;
    // token significatif présent partiellement dans le libellé
    if (t.length >= 4 && labelTokens.some((l) => l.includes(t) || t.includes(l))) score += 1;
  }
  return score;
}

function matchPromptFile(files: PromptFileRow[], request: string): PromptFileRow | null {
  const wanted = normPromptText(request);
  if (!wanted) return files.length === 1 ? (files[0] ?? null) : null;

  const exact = files.find((f) => normPromptText(f.label) === wanted);
  if (exact) return exact;

  const contains = files.find((f) => {
    const label = normPromptText(f.label);
    return label.length >= 3 && (label.includes(wanted) || wanted.includes(label));
  });
  if (contains) return contains;

  let best: PromptFileRow | null = null;
  let bestScore = 0;
  for (const f of files) {
    const s = scorePromptFile(f.label, request);
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }
  return bestScore >= 2 ? best : null;
}

const ALL_FILES_TOKENS = [
  "tous",
  "tout",
  "toutes",
  "all",
  "rehetra",
  "daholo",
  "izy rehetra",
  "tous les fichiers",
];

/**
 * Résout une demande de fichiers de l'IA : un nom, plusieurs noms séparés
 * par | , ; ou / , ou bien « tous » pour envoyer l'ensemble des fichiers.
 */
function resolvePromptFileRequests(files: PromptFileRow[], request: string): PromptFileRow[] {
  const raw = String(request || "").trim();
  if (!raw) return files.length === 1 ? files : [];

  const simple = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (ALL_FILES_TOKENS.includes(simple)) return files;

  const parts = raw
    .split(/[|;,/]+|\bet\b|\bsy\b/gi)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: PromptFileRow[] = [];
  for (const part of parts.length > 0 ? parts : [raw]) {
    const match = matchPromptFile(files, part);
    if (match) out.push(match);
    else console.warn(`[promptFiles] aucun fichier ne correspond à "${part}"`);
  }
  return out;
}

/** Envoie un fichier de prompt (pdf, image, audio, vidéo) en message privé Messenger. */
async function sendMessengerPromptFile(
  pageToken: string,
  recipientId: string,
  file: PromptFileRow,
) {
  const attachmentType =
    file.media_type === "image" || file.media_type === "video" || file.media_type === "audio"
      ? file.media_type
      : "file";

  const filename = file.file_path.split("/").pop() || "fichier";

  // Stratégie 0 (la plus fiable) : téléverser l'attachement sur Facebook
  // (/me/message_attachments) puis envoyer l'attachment_id au client.
  const sendAttachmentId = async (attachmentId: string) => {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: {
            attachment: { type: attachmentType, payload: { attachment_id: attachmentId } },
          },
          messaging_type: "RESPONSE",
        }),
      },
    );
    if (res.ok) return true;
    console.warn(
      `[sendMessengerPromptFile:attachmentId] ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
    return false;
  };

  // Stratégie A : upload binaire direct
  const downloaded = await downloadSupabaseStorageFile("prompt-files", file.file_path);

  if (downloaded?.buffer?.length) {
    try {
      const blob = new Blob([downloaded.buffer as unknown as BlobPart], {
        type: file.mime_type || downloaded.mimeType,
      });
      const form = new FormData();
      form.append(
        "message",
        JSON.stringify({ attachment: { type: attachmentType, payload: { is_reusable: true } } }),
      );
      form.append("filedata", blob, filename);
      const up = await fetch(
        `https://graph.facebook.com/v21.0/me/message_attachments?access_token=${pageToken}`,
        { method: "POST", body: form },
      );
      const upText = await up.text();
      if (up.ok) {
        const attachmentId = JSON.parse(upText)?.attachment_id;
        if (attachmentId && (await sendAttachmentId(String(attachmentId)))) return;
      } else {
        console.warn(`[sendMessengerPromptFile:upload] ${up.status}: ${upText.slice(0, 300)}`);
      }
    } catch (e) {
      console.warn("[sendMessengerPromptFile:upload] error:", e);
    }
  }

  if (downloaded?.buffer?.length) {
    try {
      const blob = new Blob([downloaded.buffer as unknown as BlobPart], {
        type: file.mime_type || downloaded.mimeType,
      });
      const form = new FormData();
      form.append("recipient", JSON.stringify({ id: recipientId }));
      form.append("message", JSON.stringify({ attachment: { type: attachmentType, payload: {} } }));
      form.append("filedata", blob, file.file_path.split("/").pop() || "fichier");
      form.append("messaging_type", "RESPONSE");

      const res = await fetch(
        `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`,
        { method: "POST", body: form },
      );
      if (res.ok) return;
      console.warn(
        `[sendMessengerPromptFile:binary] ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    } catch (e) {
      console.warn("[sendMessengerPromptFile:binary] error:", e);
    }
  }

  // Stratégie B : URL signée Supabase, puis URL proxy publique
  const candidateUrls: string[] = [];
  try {
    const { data: signed } = await supabaseAdmin.storage
      .from("prompt-files")
      .createSignedUrl(file.file_path, 60 * 60 * 24);
    if (signed?.signedUrl) candidateUrls.push(signed.signedUrl);
  } catch (e) {
    console.warn("[sendMessengerPromptFile] signed url error:", e);
  }
  candidateUrls.push(`${APP_BASE_URL}/api/public/prompt-file?id=${encodeURIComponent(file.id)}`);

  let lastError = "";
  for (const url of candidateUrls) {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { attachment: { type: attachmentType, payload: { url, is_reusable: true } } },
          messaging_type: "RESPONSE",
        }),
      },
    );
    if (res.ok) return;
    lastError = `${res.status}: ${(await res.text()).slice(0, 300)}`;
    console.warn(`[sendMessengerPromptFile:url] ${url.slice(0, 80)}... -> ${lastError}`);
  }
  throw new Error(`Prompt file send failed ${lastError}`);
}

/** Mots-clés indiquant qu'un client demande un fichier (fr + mg). */
const FILE_REQUEST_KEYWORDS = [
  "fichier",
  "fichiers",
  "rakitra",
  "pdf",
  "document",
  "doc",
  "catalogue",
  "brochure",
  "tutoriel",
  "tuto",
  "formation",
  "video",
  "vidéo",
  "audio",
  "telecharger",
  "télécharger",
  "envoyez",
  "envoie",
  "alefaso",
  "alefa",
  "andefaso",
  "omeo",
  "tiako ilay",
  "lien",
];

function clientAskedForFile(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return FILE_REQUEST_KEYWORDS.some((k) => t.includes(k));
}

/** Si l'IA a oublié le marqueur, retrouve le fichier demandé dans le message du client. */
function guessRequestedFiles(
  files: PromptFileRow[],
  userText: string | undefined,
): PromptFileRow[] {
  if (files.length === 0) return [];
  const t = normPromptText(userText ?? "");
  if (!t) return files.length === 1 ? files : [];

  // Le client demande explicitement tous les fichiers
  if (/\b(tous|toutes|tout|all|rehetra|daholo)\b/.test(t)) return files;

  // Meilleure correspondance par score (numéro de classe, mots-clés du libellé)
  const scored = files
    .map((f) => ({ f, s: scorePromptFile(f.label, t) }))
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s);
  if (scored.length > 0) {
    const top = scored[0]!.s;
    return scored.filter((x) => x.s === top).map((x) => x.f);
  }

  if (!clientAskedForFile(userText)) return [];

  const byType = files.filter((f) => {
    if (/\bvideo\b/.test(t)) return f.media_type === "video";
    if (/\baudio\b|\bvoix\b|\bfeo\b/.test(t)) return f.media_type === "audio";
    return false;
  });
  if (byType.length > 0 && byType.length <= 3) return byType;

  return files.length === 1 ? files : [];
}

/** Process AI actions extracted from a Messenger reply, send standalone images first, then return the cleaned text. */
export async function processAiActionsForMessenger(opts: {
  userId: string;
  pageId: string;
  pageToken: string;
  senderId: string;
  senderName: string | null;
  rawReply: string;
  userMessageText?: string;
}): Promise<{ cleanText: string; totalImagesSent: number; totalFilesSent?: number }> {
  const { cleanText, orders, imageRequests, fileRequests } = extractAiActions(opts.rawReply);

  // The client must EXPLICITLY ask for photos in the current message.
  // Otherwise the AI keeps re-emitting the image tag on every turn and the
  // conversation turns into an endless photo stream.
  const msg = opts.userMessageText ?? "";
  const askedPhotos =
    /(sary|sarin|photo|photos|image|images|aper[cç]u|asehoy|ase[hp]o|montre|montrez|hijery sary|jereo sary)/i.test(
      msg,
    );

  // Guard against the polling/cron path: while the client has not written a
  // NEW message, the same last message is re-processed and would trigger a new
  // photo every cycle. If an image was already sent AFTER the client's last
  // incoming message, never send another one.
  const alreadyAnsweredWithImage = async () => {
    const { data: lastIn } = await supabaseAdmin
      .from("messages_log")
      .select("created_at")
      .eq("user_id", opts.userId)
      .eq("page_id", opts.pageId)
      .eq("sender_id", opts.senderId)
      .eq("direction", "incoming")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: lastImg } = await supabaseAdmin
      .from("messages_log")
      .select("created_at")
      .eq("user_id", opts.userId)
      .eq("page_id", opts.pageId)
      .eq("sender_id", opts.senderId)
      .eq("media_type", "image")
      .eq("direction", OUTGOING_DIRECTION)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!lastImg?.created_at) return false;
    if (!lastIn?.created_at) return true;
    return new Date(lastImg.created_at).getTime() >= new Date(lastIn.created_at).getTime();
  };

  let allowedRequests: string[] = [];
  if (imageRequests.length > 0 && askedPhotos && !(await alreadyAnsweredWithImage())) {
    // exactly one image per explicit request
    allowedRequests = [imageRequests[0] ?? ""];
  }

  // 1. Persist orders
  for (const o of orders) {
    await persistAiOrder(opts.userId, opts.pageId, opts.senderId, opts.senderName, o);
  }

  // 2. Send images standalone FIRST before any text reply
  let totalImagesSent = 0;
  for (const name of allowedRequests) {
    const res = await sendProductImagesForClient(
      opts.userId,
      opts.pageId,
      opts.pageToken,
      opts.senderId,
      name,
    );
    totalImagesSent += res.sent;
  }

  // 2bis. Send prompt files (pdf, image, audio, vidéo) requested by the client
  let totalFilesSent = 0;
  {
    // Fichiers payants exclus : ils ne partent qu'après validation admin.
    const available = (await listPromptFilesForAi(opts.userId, [], true)).filter(
      (f) => !f.is_for_sale,
    );
    const targets: PromptFileRow[] = [];
    for (const request of fileRequests) {
      targets.push(...resolvePromptFileRequests(available, request));
    }
    // Filet de sécurité : l'IA annonce un envoi sans marqueur exploitable
    const aiClaimsSend =
      /(ci-?joint|voici (le|les|ce) (fichier|document|pdf)|je (vous )?(l')?envoie|envoy[eé]|indro|alefako|nalefa|efa nalefa|tongava)/i.test(
        cleanText || "",
      );
    if (
      targets.length === 0 &&
      (fileRequests.length > 0 || aiClaimsSend || clientAskedForFile(opts.userMessageText))
    ) {
      const guessed = guessRequestedFiles(available, opts.userMessageText);
      if (guessed.length > 0) targets.push(...guessed);
      else if (fileRequests.length > 0) {
        // Marqueur présent mais nom introuvable : essayer le nom demandé par l'IA
        for (const request of fileRequests) {
          const m = matchPromptFile(available, request);
          if (m) targets.push(m);
        }
      }
    }
    const sentIds = new Set<string>();
    for (const match of targets) {
      if (sentIds.has(match.id)) continue;
      try {
        await sendMessengerPromptFile(opts.pageToken, opts.senderId, match);
        sentIds.add(match.id);
        totalFilesSent += 1;
        console.log(`[promptFiles] envoyé "${match.label}" (${match.media_type})`);
      } catch (e) {
        console.error("[processAiActionsForMessenger] file send error:", e);
      }
    }
    if (targets.length === 0 && fileRequests.length > 0) {
      console.warn(
        `[promptFiles] ${fileRequests.length} demande(s) non résolue(s); ${available.length} fichier(s) disponible(s)`,
      );
    }
  }

  // 3. Never stay silent: if the AI reply contained ONLY action markers
  //    (e.g. [[SEND_IMAGES:...]]) the cleaned text is empty. Without a
  //    fallback the conversation stops dead after a photo. Always keep talking.
  let finalText = cleanText;
  if (!finalText.trim()) {
    finalText =
      totalImagesSent > 0 || totalFilesSent > 0
        ? "Indro ny sary sy ny rakitra tompoko. Inona no azonay anampiana anao ? Raha te-hividy ianao dia lazao ny anaranao, laharana findainao ary ny adiresinao azafady."
        : "Misaotra tompoko. Inona no azonay anampiana anao ? Raha mila sary na fanazavana fanampiny dia lazao fotsiny azafady.";
  }

  return { cleanText: finalText, totalImagesSent, totalFilesSent };
}

/** Reply to a comment publicly. */
export async function sendCommentReply(pageToken: string, commentId: string, text: string) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${commentId}/comments?access_token=${pageToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    },
  );
  if (!res.ok) throw new Error(`Comment reply ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Send a private reply to a comment (redirects user to Messenger). Supports chunked unlimited text. */
export async function sendPrivateReply(pageToken: string, commentId: string, text: string) {
  const chunks = splitMessengerText(text);
  if (chunks.length === 0) return;
  const res = await fetch(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text: chunks[0] },
        messaging_type: "RESPONSE",
      }),
    },
  );
  if (!res.ok) throw new Error(`Private reply ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/* --------------- Webhook processing entry --------------- */

async function getPage(pageId: string) {
  const { data } = await supabaseAdmin
    .from("facebook_pages")
    .select("*")
    .eq("page_id", pageId)
    .eq("is_connected", true)
    .maybeSingle();
  return data;
}

async function handleMessengerEvent(page: any, ev: any) {
  const senderId = ev?.sender?.id;
  if (!senderId || senderId === page.page_id) return;
  if (ev.message?.is_echo) return;
  const msg = ev.message;
  if (!msg) return;

  const mid = msg.mid || "";
  if (mid && isDuplicateMid(mid)) {
    console.log("[dedup] ignoring duplicate messenger event mid:", mid);
    return;
  }
  const eventJob = mid ? await claimFacebookEvent("message", mid) : null;
  if (mid && !eventJob) {
    console.log("[dedup] messenger event already claimed:", mid);
    return;
  }
  let eventSucceeded = false;

  // Everything that does not depend on the message content is fetched in
  // parallel: sequential round-trips were the main source of the reply delay.
  const settingsPromise = supabaseAdmin
    .from("settings")
    .select("auto_reply_messages,private_message_link,global_ia_stopped")
    .eq("user_id", page.user_id)
    .maybeSingle();
  const clientStatePromise = supabaseAdmin
    .from("client_ia_state")
    .select("ia_stopped")
    .eq("user_id", page.user_id)
    .eq("page_id", page.page_id)
    .eq("client_fb_id", senderId)
    .maybeSingle();
  const systemPromptPromise = buildSystemPrompt(page.user_id, "message", page.page_id).catch(
    () => null,
  );
  const senderNamePromise = resolveClientName(page.page_id, page.page_access_token, senderId).catch(
    () => null,
  );
  const { data: settings } = await settingsPromise;

  const text: string = msg.text ?? "";
  const attachments: any[] = msg.attachments ?? [];
  const parts: AiPart[] = [];
  if (text) parts.push({ text });
  let mediaType: string | null = null;
  let mediaUrl: string | null = null;
  for (const a of attachments) {
    if (a.type === "image" && a.payload?.url) {
      const p = await fetchAsInlinePart(a.payload.url);
      if (p) parts.push(p);
      mediaType = "image";
      mediaUrl = a.payload.url;
    } else if (a.type === "audio" && a.payload?.url) {
      parts.push({ text: `[Message vocal reçu : ${a.payload.url}]` });
      mediaType = "audio";
      mediaUrl = a.payload.url;
    }
  }
  if (parts.length === 0) parts.push({ text: "(message vide)" });

  // Historique AVANT d'insérer le message courant (pour ne pas le dupliquer).
  const history = await fetchMessengerHistoryForReply(page, senderId, text, 24);

  const senderName = await senderNamePromise;
  if (senderName) {
    // Backfill older rows of this conversation that still show the raw ID.
    supabaseAdmin
      .from("messages_log")
      .update({ sender_name: senderName })
      .eq("user_id", page.user_id)
      .eq("page_id", page.page_id)
      .eq("sender_id", senderId)
      .is("sender_name", null)
      .then(undefined, () => {});
  }

  const incomingLogPromise = insertMessageLog(
    {
      user_id: page.user_id,
      page_id: page.page_id,
      sender_id: senderId,
      sender_name: senderName,
      content: text || null,
      direction: INCOMING_DIRECTION,
      status: "received",
      media_type: mediaType,
      media_url: mediaUrl,
    },
    "incoming-webhook",
  );

  if (!(settings?.auto_reply_messages ?? true)) {
    await incomingLogPromise;
    return;
  }
  if ((settings as any)?.global_ia_stopped) {
    console.log("[stop-ia] global stopped for user", page.user_id);
    await incomingLogPromise;
    return;
  }

  // Check per-client IA stop (already fetched in parallel above)
  const { data: clientState } = await clientStatePromise;
  if (clientState?.ia_stopped) {
    console.log("[stop-ia] client stopped", senderId);
    await incomingLogPromise;
    return;
  }
  await incomingLogPromise;

  const webhookLockKey = `${page.page_id}::${senderId}`;
  if (inFlightReplies.has(webhookLockKey)) {
    console.log("[dedup] reply already in progress for", webhookLockKey);
    return;
  }
  // Shared conversation lock (same key as the batch/cron path) so a client
  // never receives the same answer twice from two different code paths.
  // Short wait only: 2 quick retries so a busy conversation is answered fast
  // instead of adding seconds of delay before the AI even starts.
  const convoJob = await claimConversation(page.page_id, senderId, 2, 700);
  if (!convoJob) {
    console.log("[dedup] conversation already being answered:", webhookLockKey);
    return;
  }
  inFlightReplies.add(webhookLockKey);
  // Moment this turn started: only a reply produced by ANOTHER path after this
  // instant means someone else already answered the client's message.
  const turnStartedAt = Date.now();

  try {
    const systemPrompt = await systemPromptPromise;
    if (!systemPrompt) {
      console.log("[skip] no prompt configured for page", page.page_id);
      return;
    }
    const { text: reply, provider } = await generateAiReply({
      userId: page.user_id,
      systemPrompt,
      history,
      parts,
      allowLinks: true,
      conversationId: `${page.page_id}:${senderId}`,
      question: text,
      kind: "private",
    });
    const rawReply = reply || "Misaotra tamin'ny hafatrao. Handray anao tsy ho ela izahay.";
    const senderName = await fetchFbSenderName(senderId, page.page_access_token);

    const { cleanText, totalImagesSent } = await processAiActionsForMessenger({
      userId: page.user_id,
      pageId: page.page_id,
      pageToken: page.page_access_token,
      senderId,
      senderName,
      rawReply,
      userMessageText: text,
    });

    if (totalImagesSent > 0) {
      // Pause so that photos arrive in Messenger first before the explanation text
      await new Promise((r) => setTimeout(r, 600));
    }

    if (cleanText) {
      if (
        (await alreadyAnsweredAfter(page.user_id, page.page_id, senderId, turnStartedAt)) ||
        (await sentSameTextRecently(page.user_id, page.page_id, senderId, cleanText))
      ) {
        console.log(
          "[dedup] a reply was sent while webhook generation was running",
          webhookLockKey,
        );
        eventSucceeded = true;
        return;
      }
      await sendMessengerReply(page.page_access_token, senderId, cleanText);
      await insertMessageLog(
        {
          user_id: page.user_id,
          page_id: page.page_id,
          sender_id: senderId,
          content: cleanText,
          ai_response: cleanText,
          direction: OUTGOING_DIRECTION,
          status: `sent:${provider}`,
        },
        "outgoing-webhook",
      );
      // MINI IA : réponse de secours (IA principale indisponible) → la question
      // du client reste en file d'attente jusqu'au retour d'une IA principale.
      if (
        (provider.startsWith("mini-ia:fallback") || provider.startsWith("quota-manager")) &&
        text.trim()
      ) {
        const { queuePendingRequest } = await import("./mini-ia.server");
        await queuePendingRequest({
          userId: page.user_id,
          question: text,
          requestType: "message",
          pageId: page.page_id,
          clientId: senderId,
          conversationId: `${page.page_id}:${senderId}`,
        });
      }
    }
    eventSucceeded = true;
  } catch (e) {
    console.error("[messenger reply]", e);
    await insertMessageLog(
      {
        user_id: page.user_id,
        page_id: page.page_id,
        sender_id: senderId,
        direction: OUTGOING_DIRECTION,
        status: `error:${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`,
      },
      "error-webhook",
    );
  } finally {
    inFlightReplies.delete(webhookLockKey);
    if (convoJob) await releaseConversation(convoJob);
    if (eventJob) await finishFacebookEvent(eventJob, eventSucceeded);
  }
}

async function fetchCommentAttachments(commentId: string, pageToken: string): Promise<AiPart[]> {
  const parts: AiPart[] = [];
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${commentId}/attachment?access_token=${pageToken}`,
    );
    const j: any = await res.json();
    const media = j?.media?.image?.src ?? j?.data?.[0]?.media?.image?.src;
    if (media) {
      const p = await fetchAsInlinePart(media);
      if (p) parts.push(p);
    }
  } catch (e) {
    console.warn("[fetchCommentAttachments]", e);
  }
  return parts;
}

/** Historique des commentaires précédents du même auteur sur la même publication. */
async function fetchCommentHistory(
  userId: string,
  postId: string,
  authorId: string,
  limit = 8,
): Promise<ChatTurn[]> {
  const { data } = await supabaseAdmin
    .from("comments_log")
    .select("content,ai_response,created_at")
    .eq("user_id", userId)
    .eq("post_id", postId)
    .eq("author_id", authorId)
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows = (data ?? []).reverse();
  const turns: ChatTurn[] = [];
  for (const r of rows) {
    if (r.content) turns.push({ role: "user", text: r.content });
    if (r.ai_response) {
      const cleaned = String(r.ai_response)
        .replace(/^\[[^\]]+\]\s*/, "")
        .split("\n---MP---\n")[0];
      if (cleaned.trim()) turns.push({ role: "assistant", text: cleaned });
    }
  }
  return turns;
}

async function handleFeedChange(page: any, value: any, force = false) {
  if (value?.item !== "comment" || value.verb !== "add") return;
  const commentId: string = value.comment_id;
  const postId: string = value.post_id;
  const authorId: string = value.from?.id ?? "";
  const authorName: string | null = value.from?.name ?? null;
  const content: string = value.message ?? "";
  if (!commentId || authorId === page.page_id) return;
  if (force) {
    // Manual scan: clear a stale lease left by a crashed run so an unanswered
    // comment is never skipped for 5 minutes.
    await (supabaseAdmin as any).rpc("finish_background_job", {
      _job_name: `facebook-comment:${commentId}`.slice(0, 240),
      _status: "idle",
      _result: { manual_reset: true, at: new Date().toISOString() },
    });
  }
  const eventJob = await claimFacebookEvent("comment", commentId);
  if (!eventJob) {
    console.log("[dedup] comment event already claimed:", commentId);
    return;
  }

  let eventSucceeded = false;

  const { data: existing } = await supabaseAdmin
    .from("comments_log")
    .select("id,replied")
    .eq("comment_id", commentId)
    .maybeSingle();
  if (existing?.replied) {
    await finishFacebookEvent(eventJob, true);
    return;
  }

  const { data: settings } = await supabaseAdmin
    .from("settings")
    .select("auto_reply_comments,private_message_link,global_ia_stopped")
    .eq("user_id", page.user_id)
    .maybeSingle();
  if ((settings as any)?.global_ia_stopped) {
    // Not answered: keep the event retryable for the next scan.
    await finishFacebookEvent(eventJob, false);
    return;
  }

  const history = await fetchCommentHistory(page.user_id, postId, authorId, 8);

  if (!existing) {
    await supabaseAdmin.from("comments_log").insert({
      user_id: page.user_id,
      page_id: page.page_id,
      post_id: postId,
      comment_id: commentId,
      author_id: authorId,
      author_name: authorName,
      content,
      replied: false,
    });
  }

  // Modération : commentaire négatif / lien / publicité → suppression + avertissement,
  // puis blocage de l'auteur à la 2e infraction. Aucune réponse IA dans ce cas.
  try {
    const { moderateComment } = await import("@/lib/comment-moderation.server");
    const verdict = await moderateComment(page, {
      commentId,
      postId,
      authorId,
      authorName,
      content,
    });
    if (verdict.violation) {
      await supabaseAdmin
        .from("comments_log")
        .update({
          replied: true,
          ai_response: `[moderation:${verdict.action}] ${verdict.reason} (infraction ${verdict.offenses})`,
        })
        .eq("comment_id", commentId);
      await finishFacebookEvent(eventJob, true);
      return;
    }
  } catch (e) {
    console.warn("[moderation] skipped", e instanceof Error ? e.message : e);
  }

  if (!(settings?.auto_reply_comments ?? true)) {
    await finishFacebookEvent(eventJob, false);
    return;
  }

  try {
    const postContext = await fetchPostContext(postId, page.page_access_token);
    const imageParts = await fetchCommentAttachments(commentId, page.page_access_token);
    const systemPrompt = await buildSystemPrompt(page.user_id, "comment", page.page_id);
    if (!systemPrompt) {
      console.log("[skip] no prompt configured for page", page.page_id);
      return;
    }
    const privateLink = settings?.private_message_link ?? "";

    const baseContext = `Publication de la page :\n"""${postContext}"""\n\nCommentaire de ${authorName ?? "l'utilisateur"} :\n"""${content || "(sans texte)"}"""${imageParts.length ? "\n\n(Une image a été jointe au commentaire, analyse-la avant de répondre.)" : ""}`;

    // 1) Réponse publique (doit s'aligner strictement avec la description de la publication et répondre au commentaire)
    let finalPublic = "";
    let providerUsed = "";
    try {
      const pubPrompt = `${baseContext}\n\nRédige une réponse publique au commentaire de l'utilisateur qui s'aligne STRICTEMENT avec la description de la publication ci-dessus et répond directement à sa question (en malgache si le client écrit en malgache, en français sinon). 1 à 2 phrases chaleureuses, professionnelles et bienveillantes, invitant la personne. Sans lien, sans * ni #.`;
      const pub = await generateAiReply({
        userId: page.user_id,
        systemPrompt,
        history,
        parts: [{ text: pubPrompt }, ...imageParts],
        allowLinks: false,
        question: content,
        kind: "comment",
      });
      finalPublic = extractAiActions(pub.text).cleanText;
      providerUsed = pub.provider;
    } catch (e) {
      console.warn("[public reply failed]", e instanceof Error ? e.message : e);
    }

    if (!finalPublic.trim()) {
      finalPublic = "Misaotra tamin'ny hevitrao. Handray anao amin'ny antsipiriany izahay.";
    }
    await sendCommentReply(page.page_access_token, commentId, finalPublic);

    // 2) Message privé détaillé (illimité, multi-part si long)
    let privateSent = false;
    let privateReply = "";
    try {
      const privPrompt = `${baseContext}\n\nRédige une réponse Messenger privée complète et détaillée basée sur la publication : explication claire, étapes numérotées si besoin (avec des chiffres, pas de #), et si utile le lien : ${privateLink || "(aucun lien fourni)"}. Style calme, aéré, sans * ni #.`;
      const priv = await generateAiReply({
        userId: page.user_id,
        systemPrompt,
        history,
        parts: [{ text: privPrompt }, ...imageParts],
        allowLinks: true,
        question: content,
      });
      privateReply = extractAiActions(priv.text).cleanText;
      providerUsed = providerUsed || priv.provider;
      if (privateReply.trim()) {
        await sendPrivateReply(page.page_access_token, commentId, privateReply);
        const chunks = splitMessengerText(privateReply);
        if (chunks.length > 1 && authorId) {
          for (let k = 1; k < chunks.length; k++) {
            await sendMessengerReply(page.page_access_token, authorId, chunks[k]);
          }
        }
        privateSent = true;
      }
    } catch (e) {
      console.warn("[private reply failed]", e instanceof Error ? e.message : e);
    }

    await supabaseAdmin
      .from("comments_log")
      .update({
        replied: true,
        replied_at: new Date().toISOString(),
        ai_response: `[${providerUsed}${privateSent ? "+MP" : "+public-only"}] ${finalPublic}${privateReply ? `\n---MP---\n${privateReply}` : ""}`,
      })
      .eq("comment_id", commentId);

    // MINI IA : réponse de secours envoyée (IA principale indisponible) →
    // on garde le commentaire en file d'attente pour une vraie réponse plus tard.
    if (providerUsed.startsWith("mini-ia:fallback") || providerUsed.startsWith("quota-manager")) {
      const { queuePendingRequest } = await import("./mini-ia.server");
      await queuePendingRequest({
        userId: page.user_id,
        question: content,
        requestType: "comment",
        commentId,
        postId,
        pageId: page.page_id,
        clientId: authorId,
      });
    }
    eventSucceeded = true;
  } catch (e) {
    console.error("[comment reply]", e);
  } finally {
    await finishFacebookEvent(eventJob, eventSucceeded);
  }
}

export async function processWebhookEvent(body: any) {
  if (body?.object !== "page") return;
  // Entries and events are handled in parallel: when several clients write at
  // the same moment, one slow AI generation must never delay (or drop) the
  // replies owed to the others.
  await Promise.allSettled(
    (body.entry ?? []).map(async (entry: any) => {
      const pageId = String(entry.id);
      const page = await getPage(pageId);
      if (!page) return;
      await Promise.allSettled([
        ...(entry.messaging ?? []).map((ev: any) =>
          handleMessengerEvent(page, ev).catch((e) => console.error("[messenger]", e)),
        ),
        ...(entry.changes ?? [])
          .filter((c: any) => c.field === "feed")
          .map((c: any) =>
            handleFeedChange(page, c.value).catch((e) => console.error("[feed]", e)),
          ),
      ]);
    }),
  );
}

/* --------------- Batch: reply to ALL pending private messages --------------- */

/** Fetch pending Messenger conversations directly from Facebook Graph API.
 *  A conversation is "pending" if its most recent message is from someone other than the page. */
async function fetchPendingConversations(
  page: any,
  maxConversations: number,
  lookbackHours: number,
) {
  const sinceMs = Date.now() - lookbackHours * 3600 * 1000;
  const url =
    `https://graph.facebook.com/v21.0/${page.page_id}/conversations` +
    `?platform=messenger&fields=participants,updated_time,messages.limit(5){id,message,from,created_time,attachments{mime_type,image_data,file_url,type}}` +
    `&limit=${Math.min(maxConversations, 50)}&access_token=${page.page_access_token}`;
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Graph conversations ${res.status}: ${t.slice(0, 200)}`);
  }
  const j: any = await res.json();
  const convos: any[] = j.data ?? [];
  const pending: Array<{
    senderId: string;
    senderName: string | null;
    lastText: string;
    lastAttachmentUrl: string | null;
    lastAttachmentType: string | null;
    lastMessageId: string | null;
    lastMessageTimeMs: number;
  }> = [];
  for (const c of convos) {
    const updatedMs = c.updated_time ? Date.parse(c.updated_time) : 0;
    if (updatedMs && updatedMs < sinceMs) continue;
    const msgs: any[] = c.messages?.data ?? [];
    if (msgs.length === 0) continue;
    const last = msgs[0]; // Graph returns newest first
    const fromId = last.from?.id;
    if (!fromId || fromId === page.page_id) continue;
    const participants: any[] = c.participants?.data ?? [];
    const other = participants.find((p) => p.id && p.id !== page.page_id);
    const senderId = other?.id ?? fromId;
    const senderName = other?.name ?? last.from?.name ?? null;
    const att = last.attachments?.data?.[0];
    const attUrl: string | null =
      att?.image_data?.url ?? att?.image_data?.preview_url ?? att?.file_url ?? null;
    const attType: string | null = att?.mime_type?.startsWith("image/")
      ? "image"
      : (att?.type ?? null);
    pending.push({
      senderId,
      senderName,
      lastText: last.message ?? "",
      lastAttachmentUrl: attUrl,
      lastAttachmentType: attType,
      lastMessageId: last.id ?? null,
      lastMessageTimeMs: last.created_time
        ? Date.parse(last.created_time)
        : updatedMs || Date.now(),
    });
    if (pending.length >= maxConversations) break;
  }
  return pending;
}

/** Second source of pending conversations, read from our own message log.
 *  The Graph "conversations" endpoint sometimes hides threads (paging, page
 *  echoes, permissions), which made the manual run report "0 message envoyé"
 *  while unanswered messages were clearly visible in the app. */
async function fetchPendingFromLogs(
  userId: string,
  page: any,
  lookbackHours: number,
  maxConversations: number,
): Promise<
  Array<{
    senderId: string;
    senderName: string | null;
    lastText: string;
    lastAttachmentUrl: string | null;
    lastAttachmentType: string | null;
    lastMessageId: string | null;
    lastMessageTimeMs: number;
  }>
> {
  const sinceIso = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from("messages_log")
    .select("sender_id,sender_name,content,direction,media_type,media_url,created_at")
    .eq("user_id", userId)
    .eq("page_id", page.page_id)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(600);

  const latestBySender = new Map<string, any>();
  for (const row of (data ?? []) as any[]) {
    if (!row.sender_id) continue;
    if (!latestBySender.has(row.sender_id)) latestBySender.set(row.sender_id, row);
  }

  const pending: Array<any> = [];
  for (const [senderId, row] of latestBySender) {
    if (row.direction !== INCOMING_DIRECTION) continue; // last entry is our answer
    pending.push({
      senderId,
      senderName: row.sender_name ?? null,
      lastText: row.content ?? "",
      lastAttachmentUrl: row.media_url ?? null,
      lastAttachmentType: row.media_type ?? null,
      lastMessageId: null,
      lastMessageTimeMs: row.created_at ? Date.parse(row.created_at) : Date.now(),
    });
    if (pending.length >= maxConversations) break;
  }
  return pending;
}

/** Guard against two overlapping ticks answering the same conversation. */
const inFlightReplies = new Set<string>();

/** True when a TEXT reply was already sent after the given moment (start of this turn).
 *  Image logs are ignored on purpose: photos sent during the current turn must
 *  never block the explanatory text that follows them, otherwise the client has
 *  to write twice before the assistant answers again. */
async function alreadyAnsweredAfter(
  userId: string,
  pageId: string,
  senderId: string,
  sinceMs: number,
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("messages_log")
    .select("created_at,direction,media_type")
    .eq("user_id", userId)
    .eq("page_id", pageId)
    .eq("sender_id", senderId)
    .eq("direction", OUTGOING_DIRECTION)
    .order("created_at", { ascending: false })
    .limit(5);
  const lastOut = (data ?? []).find((r: any) => !r.media_type);
  if (!lastOut?.created_at) return false;
  return Date.parse(lastOut.created_at) >= sinceMs;
}

/** Anti-doublon : le même texte a-t-il déjà été envoyé à ce client il y a peu ? */
const recentSentTexts = new Map<string, number>();
async function sentSameTextRecently(
  userId: string,
  pageId: string,
  senderId: string,
  text: string,
  windowMs = 3 * 60 * 1000,
): Promise<boolean> {
  const norm = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!norm) return false;
  const key = `${pageId}:${senderId}:${norm.slice(0, 300)}`;
  const now = Date.now();
  for (const [k, ts] of recentSentTexts) if (now - ts > windowMs) recentSentTexts.delete(k);
  if (recentSentTexts.has(key)) return true;
  const { data } = await supabaseAdmin
    .from("messages_log")
    .select("content,created_at")
    .eq("user_id", userId)
    .eq("page_id", pageId)
    .eq("sender_id", senderId)
    .eq("direction", OUTGOING_DIRECTION)
    .gte("created_at", new Date(now - windowMs).toISOString())
    .limit(10);
  const dup = (data ?? []).some(
    (r: any) => (r.content ?? "").replace(/\s+/g, " ").trim().toLowerCase() === norm,
  );
  recentSentTexts.set(key, now);
  return dup;
}

/** Reply to all conversations whose last message is unanswered, for one user.
 *  `force` = manual click on "Répondre à tous les messages privés": the run must
 *  never be silently skipped by in-memory caches or a stale conversation lock. */
export async function replyAllPendingForUser(
  userId: string,
  opts: { lookbackHours?: number; maxConversations?: number; force?: boolean } = {},
): Promise<{ processed: number; replied: number; errors: number; details: string[] }> {
  const force = opts.force ?? false;
  const lookbackHours = opts.lookbackHours ?? (force ? 24 * 7 : 23.5);
  const maxConversations = opts.maxConversations ?? 50;

  const details: string[] = [];
  let processed = 0;
  let replied = 0;
  let errors = 0;

  const { data: pages } = await supabaseAdmin
    .from("facebook_pages")
    .select("*")
    .eq("user_id", userId)
    .eq("is_connected", true);
  if (!pages || pages.length === 0) {
    return { processed, replied, errors, details: ["Aucune page connectée"] };
  }

  // Global stop-IA check
  const { data: settings } = await supabaseAdmin
    .from("settings")
    .select("global_ia_stopped")
    .eq("user_id", userId)
    .maybeSingle();
  if ((settings as any)?.global_ia_stopped) {
    return { processed, replied, errors, details: ["Stop IA global activé"] };
  }

  // Load per-client stop states once
  const { data: stopStates } = await supabaseAdmin
    .from("client_ia_state")
    .select("page_id,client_fb_id,ia_stopped")
    .eq("user_id", userId)
    .eq("ia_stopped", true);
  const stoppedSet = new Set((stopStates ?? []).map((s: any) => `${s.page_id}::${s.client_fb_id}`));

  for (const page of pages) {
    const systemPrompt = await buildSystemPrompt(userId, "message", page.page_id);
    if (!systemPrompt) {
      details.push(`- ${page.page_name ?? page.page_id} : aucun prompt configuré, IA désactivée`);
      continue;
    }
    let pending: Awaited<ReturnType<typeof fetchPendingConversations>> = [];
    let graphFailed = false;
    try {
      pending = await fetchPendingConversations(page, maxConversations, lookbackHours);
    } catch (e) {
      graphFailed = true;
      const msg = e instanceof Error ? e.message : String(e);
      details.push(`! ${page.page_name ?? page.page_id} (Graph): ${msg.slice(0, 160)}`);
    }

    // Complete the Graph list with the conversations our own log still shows as
    // unanswered, so a manual run never reports "0 message envoyé" while
    // pending messages exist in the app.
    try {
      const fromLogs = await fetchPendingFromLogs(userId, page, lookbackHours, maxConversations);
      const known = new Set(pending.map((p) => p.senderId));
      for (const p of fromLogs) {
        if (!known.has(p.senderId)) pending.push(p);
      }
    } catch (e) {
      console.warn("[batch] log fallback failed", e);
    }

    if (pending.length === 0 && graphFailed) {
      errors++;
      continue;
    }
    console.log(
      `[batch] page ${page.page_name ?? page.page_id}: ${pending.length} conversation(s) en attente`,
    );

    const processOne = async (p: (typeof pending)[number]) => {
      processed++;
      if (stoppedSet.has(`${page.page_id}::${p.senderId}`)) {
        details.push(
          `- ${page.page_name ?? page.page_id} → ${p.senderName ?? p.senderId} : IA arrêtée pour ce client`,
        );
        return;
      }
      const lockKey = `${page.page_id}::${p.senderId}`;
      if (inFlightReplies.has(lockKey)) {
        details.push(`- ${p.senderName ?? p.senderId} : réponse déjà en cours`);
        return;
      }
      // The in-memory mid cache is only a cheap guard for automatic ticks; a
      // manual run must always look at the real state in the database.
      if (!force && p.lastMessageId && isDuplicateMid(`batch:${p.lastMessageId}`)) return;
      if (await alreadyAnsweredAfter(userId, page.page_id, p.senderId, p.lastMessageTimeMs)) {
        details.push(`- ${p.senderName ?? p.senderId} : déjà répondu`);
        return;
      }
      // Shared conversation lock: the webhook path uses the exact same key, so
      // the same incoming message can never be answered twice. On a manual run
      // we wait for a busy conversation instead of skipping the client.
      const convoJob = await claimConversation(
        page.page_id,
        p.senderId,
        force ? 3 : 1,
        force ? 2500 : 1500,
      );
      if (!convoJob) {
        details.push(`- ${p.senderName ?? p.senderId} : conversation verrouillée, réessayez`);
        return;
      }
      inFlightReplies.add(lockKey);

      try {
        const parts: AiPart[] = [];
        if (p.lastText) parts.push({ text: p.lastText });
        if (p.lastAttachmentType === "image" && p.lastAttachmentUrl) {
          const ip = await fetchAsInlinePart(p.lastAttachmentUrl);
          if (ip) parts.push(ip);
        }
        if (parts.length === 0) parts.push({ text: "(message vide)" });

        const history = await fetchMessengerHistoryForReply(page, p.senderId, p.lastText, 24);
        const { text: reply, provider } = await generateAiReply({
          userId,
          systemPrompt,
          history,
          parts,
          allowLinks: true,
          conversationId: `${page.page_id}:${p.senderId}`,
          question: p.lastText ?? "",
          kind: "private",
        });
        const rawReply = reply || "Misaotra tamin'ny hafatrao. Handray anao tsy ho ela izahay.";
        const { cleanText: finalReply } = await processAiActionsForMessenger({
          userId,
          pageId: page.page_id,
          pageToken: page.page_access_token,
          senderId: p.senderId,
          senderName: p.senderName,
          rawReply,
          userMessageText: p.lastText,
        });
        if (
          finalReply &&
          !(await alreadyAnsweredAfter(userId, page.page_id, p.senderId, p.lastMessageTimeMs)) &&
          !(await sentSameTextRecently(userId, page.page_id, p.senderId, finalReply))
        ) {
          await sendMessengerReply(page.page_access_token, p.senderId, finalReply);
        }
        await insertMessageLog(
          [
            {
              user_id: userId,
              page_id: page.page_id,
              sender_id: p.senderId,
              sender_name: p.senderName,
              content: p.lastText || null,
              direction: INCOMING_DIRECTION,
              status: "received:batch",
              media_type: p.lastAttachmentType,
              media_url: p.lastAttachmentUrl,
            },
            {
              user_id: userId,
              page_id: page.page_id,
              sender_id: p.senderId,
              sender_name: p.senderName,
              content: finalReply,
              ai_response: finalReply,
              direction: OUTGOING_DIRECTION,
              status: `sent:batch:${provider}`,
            },
          ],
          "batch-success",
        );
        // Secours Mini IA : la question reste en attente d'une IA principale.
        if (
          (provider.startsWith("mini-ia:fallback") || provider.startsWith("quota-manager")) &&
          (p.lastText ?? "").trim()
        ) {
          const { queuePendingRequest } = await import("./mini-ia.server");
          await queuePendingRequest({
            userId,
            question: p.lastText ?? "",
            requestType: "message",
            pageId: page.page_id,
            clientId: p.senderId,
            conversationId: `${page.page_id}:${p.senderId}`,
          });
        }
        replied++;
        details.push(`✓ ${page.page_name ?? page.page_id} → ${p.senderName ?? p.senderId}`);
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[batch reply]", page.page_id, p.senderId, msg);
        details.push(
          `✗ ${page.page_name ?? page.page_id} → ${p.senderName ?? p.senderId} : ${msg.slice(0, 160)}`,
        );
        await insertMessageLog(
          {
            user_id: userId,
            page_id: page.page_id,
            sender_id: p.senderId,
            direction: OUTGOING_DIRECTION,
            status: `error:batch:${msg.slice(0, 120)}`,
          },
          "batch-error",
        );
      } finally {
        inFlightReplies.delete(lockKey);
        await releaseConversation(convoJob);
      }
    };

    // Answer several conversations at once so one slow reply never blocks the queue.
    const CONCURRENCY = 4;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      await Promise.allSettled(pending.slice(i, i + CONCURRENCY).map(processOne));
    }
  }

  return { processed, replied, errors, details };
}

/** Iterate every connected user's pages: used by the cron job. */
export async function replyAllPendingForAllUsers(): Promise<{
  users: number;
  processed: number;
  replied: number;
  errors: number;
}> {
  const { data: pages } = await supabaseAdmin
    .from("facebook_pages")
    .select("user_id")
    .eq("is_connected", true);
  const userIds = (
    [...new Set((pages ?? []).map((p) => p.user_id).filter(Boolean))] as string[]
  ).slice(0, 20);

  let processed = 0;
  let replied = 0;
  let errors = 0;
  // Users are handled in parallel batches so a slow page never delays the rest.
  const runUser = async (uid: string) => {
    try {
      const { data: settings } = await supabaseAdmin
        .from("settings")
        .select("auto_reply_messages")
        .eq("user_id", uid)
        .maybeSingle();
      if (!(settings?.auto_reply_messages ?? true)) return;
      const res = await replyAllPendingForUser(uid);
      processed += res.processed;
      replied += res.replied;
      errors += res.errors;
    } catch (e) {
      console.error("[replyAllPendingForAllUsers]", uid, e);
      errors++;
    }
  };
  for (let i = 0; i < userIds.length; i += 3) {
    await Promise.allSettled(userIds.slice(i, i + 3).map(runUser));
  }
  return { users: userIds.length, processed, replied, errors };
}

/** Scan recent published posts for a user's connected pages and auto-reply to unhandled comments. */
/** MINI IA : reprend les commentaires mis en file d'attente pendant l'indisponibilité de l'IA.
 *  La réponse définitive part en message privé, puis la demande passe en "processed". */
export async function processPendingComments(userId: string, limit = 10): Promise<number> {
  let done = 0;
  try {
    const { data } = await supabaseAdmin
      .from("ai_pending_requests")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending")
      .eq("request_type", "comment")
      .order("created_at", { ascending: false })
      .limit(limit);
    for (const row of (data ?? []) as any[]) {
      try {
        // Anti-blocage : trop vieux / trop d'essais → retiré de la file.
        const tooOld = Date.now() - Date.parse(row.created_at) > 7 * 24 * 60 * 60 * 1000;
        if (!row.page_id || !row.comment_id || tooOld || (row.retry_count ?? 0) >= 5) {
          await supabaseAdmin
            .from("ai_pending_requests")
            .update({
              status: tooOld ? "expired" : "failed",
              processed_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          continue;
        }
        const { data: page } = await supabaseAdmin
          .from("facebook_pages")
          .select("*")
          .eq("user_id", userId)
          .eq("page_id", row.page_id)
          .maybeSingle();
        if (!page) continue;
        const systemPrompt = await buildSystemPrompt(userId, "comment", page.page_id);
        if (!systemPrompt) continue;
        const res = await generateAiReply({
          userId,
          systemPrompt,
          parts: [{ text: row.question || "" }],
          allowLinks: true,
          question: row.question || "",
          kind: "comment",
        });
        const clean = extractAiActions(res.text ?? "").cleanText.trim();
        if (
          !clean ||
          res.provider.startsWith("mini-ia:fallback") ||
          res.provider.startsWith("quota-manager")
        ) {
          await supabaseAdmin
            .from("ai_pending_requests")
            .update({ retry_count: (row.retry_count ?? 0) + 1 })
            .eq("id", row.id);
          continue;
        }
        await sendPrivateReply(page.page_access_token, row.comment_id, clean);
        const { markPendingProcessed } = await import("./mini-ia.server");
        await markPendingProcessed(row.id, clean);
        done++;
      } catch (e) {
        console.warn("[mini-ia] pending comment failed", e instanceof Error ? e.message : e);
        await supabaseAdmin
          .from("ai_pending_requests")
          .update({ retry_count: (row.retry_count ?? 0) + 1 })
          .eq("id", row.id);
      }
    }
  } catch (e) {
    console.warn("[mini-ia] pending scan failed", e instanceof Error ? e.message : e);
  }
  return done;
}

/** Fenêtre Messenger : au-delà de 24h, Facebook refuse tout envoi (#10). */
const PENDING_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const PENDING_MAX_RETRIES = 5;

/** Sort une demande de la file (expirée / échec définitif) pour qu'elle cesse
 *  de bloquer les demandes plus récentes. */
async function closePendingRequest(id: string, status: string, note: string): Promise<void> {
  await supabaseAdmin
    .from("ai_pending_requests")
    .update({
      status,
      response: note.slice(0, 4000),
      processed_at: new Date().toISOString(),
    })
    .eq("id", id);
}

/** Incrémente le compteur, et abandonne définitivement après trop d'essais. */
async function bumpPendingRetry(row: any, reason: string): Promise<void> {
  const next = (row.retry_count ?? 0) + 1;
  if (next >= PENDING_MAX_RETRIES) {
    await closePendingRequest(row.id, "failed", `Abandon après ${next} essais : ${reason}`);
    return;
  }
  await supabaseAdmin.from("ai_pending_requests").update({ retry_count: next }).eq("id", row.id);
}

/** MINI IA : reprend les MESSAGES PRIVÉS mis en attente et les fait répondre
 *  par l'IA principale dès qu'une clé Gemini ou Lovable AI est de nouveau
 *  disponible. La réponse part directement au client en message privé.
 *  Les demandes trop vieilles (fenêtre Messenger dépassée) ou définitivement
 *  en échec sont retirées de la file : elles bloquaient les plus récentes. */
export async function processPendingMessages(userId: string, limit = 10): Promise<number> {
  let done = 0;
  try {
    const { data } = await supabaseAdmin
      .from("ai_pending_requests")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending")
      .eq("request_type", "message")
      // Les plus récentes d'abord : elles sont encore dans la fenêtre Messenger.
      .order("created_at", { ascending: false })
      .limit(limit);
    for (const row of (data ?? []) as any[]) {
      try {
        if (!row.page_id || !row.client_id) {
          await closePendingRequest(row.id, "failed", "Page ou client manquant.");
          continue;
        }
        const age = Date.now() - new Date(row.created_at).getTime();
        if (age > PENDING_SEND_WINDOW_MS) {
          await closePendingRequest(
            row.id,
            "expired",
            "Fenêtre Messenger de 24h dépassée : envoi impossible.",
          );
          continue;
        }
        // ANTI-DOUBLON : si le client a déjà reçu une vraie réponse (ou a écrit
        // un nouveau message traité par le webhook) depuis cette demande, on
        // n'envoie RIEN de plus — sinon il reçoit deux réponses.
        {
          const { data: later } = await supabaseAdmin
            .from("messages_log")
            .select("direction,status,media_type")
            .eq("user_id", userId)
            .eq("page_id", row.page_id)
            .eq("sender_id", row.client_id)
            .gt("created_at", row.created_at)
            .limit(50);
          const answered = (later ?? []).some(
            (r: any) =>
              r.direction === INCOMING_DIRECTION ||
              (r.direction === OUTGOING_DIRECTION &&
                String(r.status ?? "").startsWith("sent:") &&
                !/^sent:(mini-ia:fallback|quota-manager)/.test(String(r.status ?? ""))),
          );
          if (answered) {
            await closePendingRequest(row.id, "processed", "Déjà répondu dans la conversation.");
            continue;
          }
        }
        const { data: page } = await supabaseAdmin
          .from("facebook_pages")
          .select("*")
          .eq("user_id", userId)
          .eq("page_id", row.page_id)
          .maybeSingle();
        if (!page) {
          await closePendingRequest(row.id, "failed", "Page Facebook introuvable.");
          continue;
        }
        const systemPrompt = await buildSystemPrompt(userId, "message", page.page_id);
        if (!systemPrompt) {
          await bumpPendingRetry(row, "Prompt système indisponible.");
          continue;
        }
        const res = await generateAiReply({
          userId,
          systemPrompt,
          parts: [{ text: row.question || "" }],
          allowLinks: true,
          question: row.question || "",
          kind: "private",
          conversationId: row.conversation_id ?? `${page.page_id}:${row.client_id}`,
        });
        const clean = extractAiActions(res.text ?? "").cleanText.trim();
        // IA principale toujours indisponible : on réessaiera au prochain tour.
        if (
          !clean ||
          res.provider.startsWith("mini-ia:fallback") ||
          res.provider.startsWith("quota-manager")
        ) {
          await supabaseAdmin
            .from("ai_pending_requests")
            .update({ retry_count: (row.retry_count ?? 0) + 1 })
            .eq("id", row.id);
          continue;
        }
        // Dernière vérification juste avant l'envoi (la génération IA prend du temps).
        if (
          (await alreadyAnsweredAfter(
            userId,
            page.page_id,
            row.client_id,
            Date.parse(row.created_at) + 1,
          )) ||
          (await sentSameTextRecently(userId, page.page_id, row.client_id, clean))
        ) {
          await closePendingRequest(row.id, "processed", "Déjà répondu dans la conversation.");
          continue;
        }
        try {
          await sendMessengerReply(page.page_access_token, row.client_id, clean);
        } catch (sendErr) {
          const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          // (#10) hors fenêtre, (#551)/(#200) client injoignable : inutile de réessayer.
          if (/\(#10\)|outside of allowed window|\(#551\)|\(#200\)|#100/i.test(msg)) {
            await closePendingRequest(row.id, "expired", msg.slice(0, 300));
          } else {
            await bumpPendingRetry(row, msg.slice(0, 200));
          }
          continue;
        }
        await insertMessageLog(
          {
            user_id: userId,
            page_id: page.page_id,
            sender_id: row.client_id,
            content: clean,
            ai_response: clean,
            direction: OUTGOING_DIRECTION,
            status: `sent:${res.provider}:pending`,
          },
          "pending-message",
        );
        const { markPendingProcessed } = await import("./mini-ia.server");
        await markPendingProcessed(row.id, clean);
        done++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[mini-ia] pending message failed", msg);
        await bumpPendingRetry(row, msg.slice(0, 200)).catch(() => {});
      }
    }
  } catch (e) {
    console.warn("[mini-ia] pending message scan failed", e instanceof Error ? e.message : e);
  }
  return done;
}

/** Reprend toutes les demandes en attente (messages + commentaires) de tous les
 *  utilisateurs. Appelé par le worker : dès qu'une IA principale redevient
 *  disponible, les clients reçoivent enfin leur vraie réponse. */
export async function processAllPendingRequests(): Promise<{
  users: number;
  messages: number;
  comments: number;
}> {
  const { data } = await supabaseAdmin
    .from("ai_pending_requests")
    .select("user_id")
    .eq("status", "pending")
    .limit(500);
  const userIds = Array.from(new Set((data ?? []).map((r: any) => r.user_id).filter(Boolean)));
  let messages = 0;
  let comments = 0;
  for (const userId of userIds) {
    messages += await processPendingMessages(userId).catch(() => 0);
    comments += await processPendingComments(userId).catch(() => 0);
  }
  return { users: userIds.length, messages, comments };
}

export async function scanAndReplyCommentsForUser(
  userId: string,
  opts: { force?: boolean } = {},
): Promise<{
  scanned: number;
  replied: number;
  errors: number;
  details: string[];
}> {
  const force = opts.force ?? false;
  // Priorité aux commentaires en attente (IA revenue en ligne).
  await processPendingComments(userId).catch(() => 0);
  const details: string[] = [];
  let scanned = 0;
  let replied = 0;
  let errors = 0;

  const { data: pages } = await supabaseAdmin
    .from("facebook_pages")
    .select("*")
    .eq("user_id", userId)
    .eq("is_connected", true);

  if (!pages || pages.length === 0) {
    return { scanned, replied, errors, details: ["Aucune page Facebook connectée."] };
  }

  for (const page of pages) {
    try {
      const postsUrl =
        `https://graph.facebook.com/v21.0/${page.page_id}/published_posts` +
        `?fields=id,message,created_time,comments.limit(25){id,from,message,created_time}` +
        `&limit=10&access_token=${page.page_access_token}`;
      const res = await fetch(postsUrl);
      if (!res.ok) {
        const t = await res.text();
        errors++;
        const pageName = page.page_name ?? page.page_id;
        details.push(`✗ ${pageName} : Erreur Graph API (${res.status}) ${t.slice(0, 100)}`);
        continue;
      }
      const json: any = await res.json();
      const posts: any[] = json.data ?? [];

      // Flatten every comment first, then answer several of them at the same
      // time: one slow AI reply must not block the rest of the queue.
      const todo: Array<{ post: any; c: any }> = [];
      for (const post of posts) {
        for (const c of post.comments?.data ?? []) {
          scanned++;
          if (!c?.id || c.from?.id === page.page_id) continue;
          todo.push({ post, c });
        }
      }

      const handleOne = async ({ post, c }: { post: any; c: any }) => {
        const commentId = c.id;
        const authorId = c.from?.id;
        try {
          const { data: existing } = await supabaseAdmin
            .from("comments_log")
            .select("id,replied")
            .eq("comment_id", commentId)
            .maybeSingle();
          if (existing?.replied) return;

          await handleFeedChange(
            page,
            {
              item: "comment",
              verb: "add",
              comment_id: commentId,
              post_id: post.id,
              from: c.from ?? { id: "", name: null },
              message: c.message ?? "",
            },
            force,
          );

          const { data: updated } = await supabaseAdmin
            .from("comments_log")
            .select("replied")
            .eq("comment_id", commentId)
            .maybeSingle();

          if (updated?.replied) {
            replied++;
            details.push(`✓ Commentaire de ${c.from?.name ?? authorId} répondu.`);
          } else {
            details.push(`- Commentaire de ${c.from?.name ?? authorId} non répondu.`);
          }
        } catch (e) {
          errors++;
          details.push(
            `✗ Commentaire ${commentId} : ${e instanceof Error ? e.message.slice(0, 120) : "erreur"}`,
          );
        }
      };

      const CONCURRENCY = 4;
      for (let i = 0; i < todo.length; i += CONCURRENCY) {
        await Promise.allSettled(todo.slice(i, i + CONCURRENCY).map(handleOne));
      }
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      details.push(`✗ ${page.page_name ?? page.page_id} : ${msg.slice(0, 120)}`);
    }
  }

  return { scanned, replied, errors, details };
}

/** Scan comments for all connected users' pages: used by background cron. */
export async function scanAndReplyCommentsForAllUsers(): Promise<{
  users: number;
  scanned: number;
  replied: number;
  errors: number;
}> {
  const { data: pages } = await supabaseAdmin
    .from("facebook_pages")
    .select("user_id")
    .eq("is_connected", true);
  const userIds = (
    [...new Set((pages ?? []).map((p) => p.user_id).filter(Boolean))] as string[]
  ).slice(0, 20);

  let scanned = 0;
  let replied = 0;
  let errors = 0;
  // Users are handled in parallel batches: one slow page never blocks the others.
  const runUser = async (uid: string) => {
    try {
      const { data: settings } = await supabaseAdmin
        .from("settings")
        .select("auto_reply_comments")
        .eq("user_id", uid)
        .maybeSingle();
      if (!(settings?.auto_reply_comments ?? true)) return;
      const res = await scanAndReplyCommentsForUser(uid);
      scanned += res.scanned;
      replied += res.replied;
      errors += res.errors;
    } catch (e) {
      console.error("[scanAndReplyCommentsForAllUsers]", uid, e);
      errors++;
    }
  };
  for (let i = 0; i < userIds.length; i += 3) {
    await Promise.allSettled(userIds.slice(i, i + 3).map(runUser));
  }
  return { users: userIds.length, scanned, replied, errors };
}

/**
 * Notify the Messenger client when an order status changes (accepted, refused,
 * delivered). Best-effort: never throws to the caller.
 */
export async function notifyOrderStatusToClient(
  userId: string,
  orderId: string,
  status: string,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const { data: order } = await supabaseAdmin
      .from("orders")
      .select(
        "id, page_id, client_fb_id, client_fb_name, quantity, products(name), trainings(name)",
      )
      .eq("id", orderId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!order?.client_fb_id) return { sent: false, reason: "no_client" };

    let pageQuery = supabaseAdmin
      .from("facebook_pages")
      .select("page_id, page_access_token")
      .eq("user_id", userId)
      .eq("is_connected", true);
    if (order.page_id) pageQuery = pageQuery.eq("page_id", order.page_id);
    const { data: pages } = await pageQuery.limit(1);
    const page = pages?.[0];
    if (!page?.page_access_token) return { sent: false, reason: "no_page_token" };

    const itemName = (order as any).products?.name ?? (order as any).trainings?.name ?? "kaomandy";
    const qty = (order as any).quantity ?? 1;

    let text: string;
    if (status === "accepted") {
      text =
        `✅ Salama ${order.client_fb_name || ""}! Voaray sy neken'ny tompon'andraikitra ny kaomandinao : ` +
        `${itemName}${qty > 1 ? ` (×${qty})` : ""}. Hifandray aminao tsy ho ela izahay ho an'ny fandefasana. Misaotra betsaka! 🙏`;
    } else if (status === "delivered") {
      text = `📦 Efa lasa/voatolotra ny kaomandinao : ${itemName}. Misaotra amin'ny fitokisana!`;
    } else if (status === "refused") {
      text = `😔 Miala tsiny, tsy afaka nekena ny kaomandinao : ${itemName}. Afaka manontany anay raha mila fanazavana fanampiny.`;
    } else {
      return { sent: false, reason: "status_ignored" };
    }

    await sendMessengerReply(page.page_access_token, order.client_fb_id, text);

    // Fichier payant : envoi automatique après validation de l'admin.
    if (status === "accepted" || status === "delivered") {
      try {
        const { data: o2 } = await supabaseAdmin
          .from("orders")
          .select("prompt_file_id, file_delivered_at")
          .eq("id", orderId)
          .maybeSingle();
        if (o2?.prompt_file_id && !o2.file_delivered_at) {
          const { data: f } = await supabaseAdmin
            .from("prompt_files")
            .select(
              "id,label,description,media_type,mime_type,file_path,prompt_id,is_for_sale,price",
            )
            .eq("id", o2.prompt_file_id)
            .eq("user_id", userId)
            .maybeSingle();
          if (f) {
            await sendMessengerReply(
              page.page_access_token,
              order.client_fb_id,
              `📎 Indro ilay fichier novidianao : ${f.label}. Misaotra betsaka! 🙏`,
            );
            await sendMessengerPromptFile(
              page.page_access_token,
              order.client_fb_id,
              f as PromptFileRow,
            );
            await supabaseAdmin
              .from("orders")
              .update({ file_delivered_at: new Date().toISOString() })
              .eq("id", orderId);
          }
        }
      } catch (e) {
        console.error("[notifyOrderStatusToClient] paid file send error:", e);
      }
    }
    return { sent: true };
  } catch (e) {
    console.error("[notifyOrderStatusToClient] error:", e);
    return { sent: false, reason: "error" };
  }
}
