/**
 * Gemini Quota Manager — mode économie de quota.
 *
 * Toutes les réponses IA passent par ici : cache, déduplication, limiteur de
 * débit (RPM / RPD / TPM), file d'attente à concurrence limitée, contexte
 * réduit, réponse limitée à 3 phrases, monitoring et alertes admin.
 *
 * Les limites sont configurables via variables d'environnement (serveur) :
 *   AI_MAX_RPM, AI_MAX_RPD, AI_MAX_TPM, AI_MAX_CONCURRENT, AI_MAX_RETRY,
 *   AI_MAX_CONTEXT_TURNS, AI_MAX_CONTEXT_CHARS, AI_MAX_OUTPUT_TOKENS,
 *   AI_MAX_REQUEST_PER_CONVERSATION, AI_CACHE_TTL_MIN, AI_QUEUE_WAIT_MS
 */

import type { ChatTurn, AiPart } from "./ai-engine.server";

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export function getQuotaConfig() {
  return {
    MAX_RPM: num("AI_MAX_RPM", 12),
    MAX_RPD: num("AI_MAX_RPD", 1200),
    MAX_TPM: num("AI_MAX_TPM", 200_000),
    MAX_CONCURRENT_AI_REQUESTS: num("AI_MAX_CONCURRENT", 3),
    MAX_RETRY: num("AI_MAX_RETRY", 3),
    MAX_CONTEXT_TURNS: num("AI_MAX_CONTEXT_TURNS", 8),
    MAX_CONTEXT_SIZE: num("AI_MAX_CONTEXT_CHARS", 3000),
    MAX_OUTPUT_TOKENS: num("AI_MAX_OUTPUT_TOKENS", 400),
    MAX_AI_REQUEST_PER_CONVERSATION: num("AI_MAX_REQUEST_PER_CONVERSATION", 60),
    CACHE_TTL_MS: num("AI_CACHE_TTL_MIN", 30) * 60_000,
    DEDUP_WINDOW_MS: 20_000,
    QUEUE_WAIT_MS: num("AI_QUEUE_WAIT_MS", 45_000),
  };
}

export const FALLBACK_REPLY =
  "Azafady, somary be ny fangatahana amin'izao fotoana izao; andramo indray afaka fotoana fohy.";

export const SHORT_REPLY_RULE =
  "\n\nFEPETRA FOHY (TSY AZO OVAINA) : Valio amin'ny MAXIMUM 3 phrases ihany. " +
  "Ataovy mazava, matihanina, mivantana ary feno information ilaina ny valiny (aza phrase fohy tsy misy dikany, aza miverimberina).";

// ---------------------------------------------------------------- stats ----
type Stats = {
  day: string;
  requestsToday: number;
  cacheHits: number;
  dedupHits: number;
  callsAvoided: number;
  errors: number;
  errors429: number;
  fallbacks: number;
  totalLatencyMs: number;
  latencyCount: number;
  estTokensToday: number;
  modelUsage: Record<string, number>;
  providerUsage: Record<string, number>;
  lastAlertLevel: number;
  alerts: { at: string; level: string; message: string }[];
  logs: LogEntry[];
};
type LogEntry = {
  at: string;
  type: string;
  model: string;
  project: string;
  status: string;
  latencyMs: number;
  estTokens: number;
  cache: "hit" | "miss" | "dedup";
  errorType?: string;
};

const today = () => new Date().toISOString().slice(0, 10);
const freshStats = (): Stats => ({
  day: today(),
  requestsToday: 0,
  cacheHits: 0,
  dedupHits: 0,
  callsAvoided: 0,
  errors: 0,
  errors429: 0,
  fallbacks: 0,
  totalLatencyMs: 0,
  latencyCount: 0,
  estTokensToday: 0,
  modelUsage: {},
  providerUsage: {},
  lastAlertLevel: 0,
  alerts: [],
  logs: [],
});
let stats = freshStats();
const requestTimes: number[] = []; // timestamps (ms) for the last 24h
const tokenTimes: { at: number; tokens: number }[] = [];
const convCounts = new Map<string, { day: string; n: number }>();

function rollDay() {
  if (stats.day !== today()) {
    const keepAlerts = stats.alerts.slice(-10);
    stats = freshStats();
    stats.alerts = keepAlerts;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

export function maskKey(key: string): string {
  const k = (key || "").trim();
  if (k.length <= 10) return "****";
  return `${k.slice(0, 4)}...****...${k.slice(-4)}`;
}

/** Retire toute clé API (AIza...) d'un message avant log/affichage. */
export function redactSecrets(text: string): string {
  return (text || "").replace(/AIza[0-9A-Za-z_\-]{20,}/g, (m) => maskKey(m));
}

function pushLog(e: LogEntry) {
  stats.logs.push(e);
  if (stats.logs.length > 100) stats.logs.shift();
}

function checkAlerts() {
  const cfg = getQuotaConfig();
  const usage = Math.max(countSince(60_000) / cfg.MAX_RPM, countSince(86_400_000) / cfg.MAX_RPD);
  const levels = [
    { p: 0.95, lvl: 4, name: "critical" },
    { p: 0.85, lvl: 3, name: "high warning" },
    { p: 0.7, lvl: 2, name: "warning" },
    { p: 0.5, lvl: 1, name: "information" },
  ];
  const hit = levels.find((l) => usage >= l.p);
  const lvl = hit?.lvl ?? 0;
  if (hit && lvl > stats.lastAlertLevel) {
    const message = `Utilisation IA à ${Math.round(usage * 100)}% de la limite (${hit.name}).`;
    stats.alerts.push({ at: new Date().toISOString(), level: hit.name, message });
    if (stats.alerts.length > 30) stats.alerts.shift();
    console.warn(`[quota-alert] ${message}`);
  }
  stats.lastAlertLevel = lvl;
}

// --------------------------------------------------------- rate limiter ----
function prune() {
  const dayAgo = Date.now() - 86_400_000;
  while (requestTimes.length && requestTimes[0]! < dayAgo) requestTimes.shift();
  const minAgo = Date.now() - 60_000;
  while (tokenTimes.length && tokenTimes[0]!.at < minAgo) tokenTimes.shift();
}
function countSince(ms: number): number {
  prune();
  const t = Date.now() - ms;
  let n = 0;
  for (let i = requestTimes.length - 1; i >= 0 && requestTimes[i]! >= t; i--) n++;
  return n;
}
function tokensLastMinute(): number {
  prune();
  return tokenTimes.reduce((s, x) => s + x.tokens, 0);
}

/** Temps d'attente (ms) avant de pouvoir envoyer ; -1 si la limite journalière est atteinte. */
function waitNeeded(estTokens: number): number {
  const cfg = getQuotaConfig();
  if (countSince(86_400_000) >= cfg.MAX_RPD) return -1;
  let wait = 0;
  if (countSince(60_000) >= cfg.MAX_RPM) {
    const oldestInMinute = requestTimes[requestTimes.length - cfg.MAX_RPM]!;
    wait = Math.max(wait, oldestInMinute + 60_000 - Date.now());
  }
  if (tokensLastMinute() + estTokens > cfg.MAX_TPM && tokenTimes.length) {
    wait = Math.max(wait, tokenTimes[0]!.at + 60_000 - Date.now());
  }
  return Math.max(0, wait);
}

// -------------------------------------------------------- request queue ----
let active = 0;
const waiters: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  const cfg = getQuotaConfig();
  if (active < cfg.MAX_CONCURRENT_AI_REQUESTS) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = waiters.indexOf(go);
      if (i >= 0) waiters.splice(i, 1);
      reject(Object.assign(new Error("AI queue timeout"), { isQueueTimeout: true }));
    }, cfg.QUEUE_WAIT_MS);
    const go = () => {
      clearTimeout(timer);
      active++;
      resolve();
    };
    waiters.push(go);
  });
}
function releaseSlot() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

// ------------------------------------------------------ cache & dedup ----
const cache = new Map<string, { text: string; provider: string; at: number }>();
const inflight = new Map<string, Promise<{ text: string; provider: string }>>();

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
export function normalizeQuestion(q: string): string {
  return (q || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Clé de cache : propriétaire + prompt système + (dernière question normalisée). */
function cacheKeyFor(userId: string, systemPrompt: string, parts: AiPart[]): string | null {
  if (parts.some((p) => !("text" in p))) return null; // images : pas de cache
  const q = normalizeQuestion(parts.map((p) => ("text" in p ? p.text : "")).join(" "));
  if (!q || q.length > 400) return null;
  return `${userId}:${hash(systemPrompt)}:${q}`;
}

// ------------------------------------------------------ context filter ----
/** Garde seulement les derniers échanges utiles, sans doublons, dans un budget de caractères. */
export function trimHistory(history: ChatTurn[]): ChatTurn[] {
  const cfg = getQuotaConfig();
  const dedup: ChatTurn[] = [];
  for (const t of history) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.role === t.role && normalizeQuestion(prev.text) === normalizeQuestion(t.text))
      continue;
    dedup.push(t);
  }
  const recent = dedup.slice(-cfg.MAX_CONTEXT_TURNS);
  const out: ChatTurn[] = [];
  let budget = cfg.MAX_CONTEXT_SIZE;
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i]!;
    const text = t.text.length > 600 ? `${t.text.slice(0, 600)}…` : t.text;
    if (budget - text.length < 0 && out.length) break;
    budget -= text.length;
    out.unshift({ role: t.role, text });
  }
  // Résumé compact des échanges plus anciens (sans appel IA).
  const older = dedup.slice(0, dedup.length - out.length).filter((t) => t.role === "user");
  if (older.length) {
    const summary = older
      .slice(-5)
      .map((t) => `- ${t.text.slice(0, 120)}`)
      .join("\n");
    out.unshift({ role: "user", text: `Résumé conversation précédente (client) :\n${summary}` });
    if (out[1]?.role === "user") out.splice(1, 0, { role: "assistant", text: "D'accord." });
  }
  return out;
}

// ---------------------------------------------------- 3-phrase limiter ----
/** Limite la partie visible à 3 phrases, en conservant liens et blocs techniques [[...]]. */
export function limitToThreeSentences(text: string): string {
  const blocks: string[] = [];
  const body = text.replace(/\[\[[\s\S]*?\]\]/g, (m) => {
    blocks.push(m);
    return "";
  });
  const links = body.match(/https?:\/\/\S+/g) ?? [];
  const noLinks = body.replace(/https?:\/\/\S+/g, " ").trim();
  const sentences = noLinks
    .match(/[^.!?…]+(?:[.!?…]+|$)/g)
    ?.map((s) => s.trim())
    .filter(Boolean);
  let visible = body.trim();
  if (sentences && sentences.length > 3) {
    visible = sentences.slice(0, 3).join(" ");
    if (links.length) visible += `\n${links.join("\n")}`;
  }
  return [visible, ...blocks].filter(Boolean).join("\n");
}

// ------------------------------------------------------------- retry ----
export function isRetryable(err: any): boolean {
  const msg = String(err?.message ?? err ?? "");
  if (err?.isAuth || /\b(400|401|403)\b|INVALID_ARGUMENT|UNAUTHENTICATED/.test(msg)) return false;
  return Boolean(
    err?.isQuota || /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|timeout|UNAVAILABLE/i.test(msg),
  );
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ manager ----
export type ManagedCall = () => Promise<{ text: string; provider: string }>;

export async function runManagedAiCall(opts: {
  userId: string;
  systemPrompt: string;
  parts: AiPart[];
  history: ChatTurn[];
  conversationId?: string;
  shortReply: boolean;
  useCache: boolean;
  type: string;
  call: (history: ChatTurn[]) => Promise<{ text: string; provider: string }>;
}): Promise<{ text: string; provider: string }> {
  rollDay();
  const cfg = getQuotaConfig();
  const started = Date.now();
  const key = opts.useCache ? cacheKeyFor(opts.userId, opts.systemPrompt, opts.parts) : null;

  // 1. Cache
  if (key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cfg.CACHE_TTL_MS) {
      stats.cacheHits++;
      stats.callsAvoided++;
      pushLog({
        at: new Date().toISOString(),
        type: opts.type,
        model: "-",
        project: "cache",
        status: "ok",
        latencyMs: 0,
        estTokens: 0,
        cache: "hit",
      });
      return { text: hit.text, provider: `cache:${hit.provider}` };
    }
    if (hit) cache.delete(key);
    // 2. Déduplication (même question en cours)
    const pending = inflight.get(key);
    if (pending) {
      stats.dedupHits++;
      stats.callsAvoided++;
      return pending;
    }
  }

  // 3. Limite par conversation
  if (opts.conversationId) {
    const c = convCounts.get(opts.conversationId);
    const n = c && c.day === today() ? c.n + 1 : 1;
    convCounts.set(opts.conversationId, { day: today(), n });
    if (convCounts.size > 5000) convCounts.clear();
    if (n > cfg.MAX_AI_REQUEST_PER_CONVERSATION) {
      stats.callsAvoided++;
      stats.fallbacks++;
      return { text: FALLBACK_REPLY, provider: "quota-manager:conversation-limit" };
    }
  }

  const history = trimHistory(opts.history);
  const systemPrompt = opts.shortReply ? opts.systemPrompt + SHORT_REPLY_RULE : opts.systemPrompt;
  const estIn =
    estimateTokens(systemPrompt) +
    history.reduce((s, t) => s + estimateTokens(t.text), 0) +
    opts.parts.reduce((s, p) => s + ("text" in p ? estimateTokens(p.text) : 260), 0);

  const exec = async () => {
    await acquireSlot();
    try {
      let lastErr: any;
      for (let attempt = 0; attempt < cfg.MAX_RETRY; attempt++) {
        const wait = waitNeeded(estIn);
        if (wait < 0)
          throw Object.assign(new Error("Daily AI limit reached"), {
            isQuota: true,
            noRetry: true,
          });
        if (wait > 0) {
          if (wait > cfg.QUEUE_WAIT_MS)
            throw Object.assign(new Error("Rate limit wait too long"), { isQuota: true });
          await sleep(wait);
        }
        requestTimes.push(Date.now());
        stats.requestsToday++;
        checkAlerts();
        try {
          const res = await opts.call(history);
          const estOut = estimateTokens(res.text);
          tokenTimes.push({ at: Date.now(), tokens: estIn + estOut });
          stats.estTokensToday += estIn + estOut;
          const latency = Date.now() - started;
          stats.totalLatencyMs += latency;
          stats.latencyCount++;
          const [prov, model = "-"] = res.provider.split(":");
          stats.providerUsage[prov!] = (stats.providerUsage[prov!] ?? 0) + 1;
          stats.modelUsage[model] = (stats.modelUsage[model] ?? 0) + 1;
          pushLog({
            at: new Date().toISOString(),
            type: opts.type,
            model,
            project: prov!,
            status: "ok",
            latencyMs: latency,
            estTokens: estIn + estOut,
            cache: "miss",
          });
          return res;
        } catch (e: any) {
          lastErr = e;
          const msg = redactSecrets(String(e?.message ?? e));
          stats.errors++;
          const is429 = Boolean(e?.isQuota || /429|RESOURCE_EXHAUSTED|quota/i.test(msg));
          if (is429) stats.errors429++;
          pushLog({
            at: new Date().toISOString(),
            type: opts.type,
            model: "-",
            project: "-",
            status: "error",
            latencyMs: Date.now() - started,
            estTokens: estIn,
            cache: "miss",
            errorType: is429 ? "429" : msg.slice(0, 80),
          });
          console.warn(
            `[quota-manager] tentative ${attempt + 1}/${cfg.MAX_RETRY} échouée: ${msg.slice(0, 200)}`,
          );
          if (!isRetryable(e) || attempt === cfg.MAX_RETRY - 1) break;
          const backoff = Math.min(20_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
          await sleep(backoff);
        }
      }
      throw lastErr ?? new Error("AI call failed");
    } finally {
      releaseSlot();
    }
  };

  const p = (async () => {
    let res = await exec();
    if (opts.shortReply) res = { ...res, text: limitToThreeSentences(res.text) };
    if (key && res.text && !res.text.includes("[[")) {
      cache.set(key, { text: res.text, provider: res.provider, at: Date.now() });
      if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    }
    return res;
  })();

  if (key) inflight.set(key, p);
  try {
    return await p;
  } catch (e: any) {
    const msg = redactSecrets(String(e?.message ?? e));
    if (e?.isQuota || e?.isQueueTimeout || /429|RESOURCE_EXHAUSTED|quota|Quota/i.test(msg)) {
      stats.fallbacks++;
      console.error(`[quota-manager] fallback client (quota/queue): ${msg.slice(0, 200)}`);
      if (opts.shortReply) return { text: FALLBACK_REPLY, provider: "quota-manager:fallback" };
    }
    throw Object.assign(new Error(msg), { isQuota: e?.isQuota, isAuth: e?.isAuth });
  } finally {
    if (key) inflight.delete(key);
  }
}

// --------------------------------------------------------- monitoring ----
export function getQuotaSnapshot() {
  rollDay();
  const cfg = getQuotaConfig();
  const perMin = countSince(60_000);
  const perHour = countSince(3_600_000);
  const perDay = countSince(86_400_000);
  const totalAsked = stats.requestsToday + stats.callsAvoided;
  const usagePct = Math.round(Math.max(perMin / cfg.MAX_RPM, perDay / cfg.MAX_RPD) * 100);
  return {
    config: { ...cfg },
    requestsThisMinute: perMin,
    requestsThisHour: perHour,
    requestsToday: perDay,
    estimatedTokensToday: stats.estTokensToday,
    tokensLastMinute: tokensLastMinute(),
    errors: stats.errors,
    errors429: stats.errors429,
    fallbacks: stats.fallbacks,
    avgResponseMs: stats.latencyCount ? Math.round(stats.totalLatencyMs / stats.latencyCount) : 0,
    cacheHits: stats.cacheHits,
    dedupHits: stats.dedupHits,
    cacheHitRate: totalAsked ? Math.round((stats.cacheHits / totalAsked) * 100) : 0,
    callsAvoided: stats.callsAvoided,
    usagePct,
    status:
      usagePct >= 95
        ? "critical"
        : usagePct >= 85
          ? "high"
          : usagePct >= 70
            ? "warning"
            : usagePct >= 50
              ? "info"
              : "ok",
    activeRequests: active,
    queued: waiters.length,
    modelUsage: stats.modelUsage,
    providerUsage: stats.providerUsage,
    alerts: stats.alerts.slice(-10).reverse(),
    logs: stats.logs.slice(-25).reverse(),
  };
}
