import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Surveillance des quotas IA (Lovable AI + clés Gemini).
 * Utilisé par la page Paramètres pour afficher une alerte quand le crédit
 * Lovable AI est bas/épuisé ou quand trop de clés Gemini sont en pause,
 * avec une suggestion de clé de secours.
 */

export type AiQuotaHealth = {
  lovable: {
    status: "ok" | "exhausted" | "error" | "unknown";
    detail: string;
    /** Quota total de la fenêtre courante (null si inconnu). */
    limit: number | null;
    /** Crédit encore disponible dans la fenêtre courante. */
    remaining: number | null;
    /** Pourcentage déjà consommé (0-100). */
    usedPercent: number | null;
    /** Pourcentage encore disponible (0-100). */
    remainingPercent: number | null;
    /** Date de remise à zéro du quota. */
    resetAt: string | null;
  };
  gemini: {
    total: number;
    active: number;
    paused: number;
    status: "ok" | "low" | "exhausted" | "none";
  };
  /** Seuil d'alerte : nombre minimal de clés Gemini opérationnelles. */
  threshold: number;
  alert: boolean;
  alertMessage: string | null;
  suggestion: string | null;
  backupKeyLabel: string | null;
  checkedAt: string;
};

const GEMINI_ACTIVE_THRESHOLD = 1;

export const getAiQuotaHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AiQuotaHealth> => {
    // --- 1. État du crédit Lovable AI (sonde légère sur le catalogue) ---
    const emptyQuota = {
      limit: null as number | null,
      remaining: null as number | null,
      usedPercent: null as number | null,
      remainingPercent: null as number | null,
      resetAt: null as string | null,
    };

    let lovable: AiQuotaHealth["lovable"] = {
      status: "unknown",
      detail: "Vérification impossible",
      ...emptyQuota,
    };
    try {
      const key = process.env.LOVABLE_API_KEY;
      if (!key) {
        lovable = { status: "error", detail: "Clé Lovable AI absente", ...emptyQuota };
      } else {
        const res = await fetch("https://ai.gateway.lovable.dev/v1/models", {
          headers: { "Lovable-API-Key": key },
          signal: AbortSignal.timeout(8000),
        });

        // La passerelle renvoie le quota de la fenêtre courante dans les en-têtes.
        const num = (v: string | null) => {
          const n = v === null ? NaN : Number(v);
          return Number.isFinite(n) ? n : null;
        };
        const limit = num(res.headers.get("x-ratelimit-limit"));
        const remaining = num(res.headers.get("x-ratelimit-remaining"));
        const resetSec = num(res.headers.get("x-ratelimit-reset"));
        const quota = {
          limit,
          remaining,
          usedPercent:
            limit && limit > 0 && remaining !== null
              ? Math.min(100, Math.max(0, Math.round(((limit - remaining) / limit) * 100)))
              : null,
          remainingPercent:
            limit && limit > 0 && remaining !== null
              ? Math.min(100, Math.max(0, Math.round((remaining / limit) * 100)))
              : null,
          resetAt: resetSec ? new Date(resetSec * 1000).toISOString() : null,
        };

        if (res.ok) {
          lovable = {
            status: "ok",
            detail:
              quota.remainingPercent !== null
                ? `Crédit Lovable AI disponible — ${quota.remainingPercent}% restant`
                : "Crédit Lovable AI disponible",
            ...quota,
          };
        } else if (res.status === 402 || res.status === 429) {
          lovable = {
            status: "exhausted",
            detail: "Crédit Lovable AI épuisé ou quota dépassé",
            ...quota,
            usedPercent: 100,
            remainingPercent: 0,
          };
        } else if (res.status === 401 || res.status === 403) {
          lovable = { status: "error", detail: "Clé Lovable AI invalide", ...quota };
        } else {
          lovable = { status: "unknown", detail: `Réponse inattendue (${res.status})`, ...quota };
        }
      }
    } catch {
      lovable = {
        status: "unknown",
        detail: "Passerelle Lovable AI injoignable",
        ...emptyQuota,
      };
    }

    // --- 2. État des clés Gemini de l'utilisateur ---
    const { data: keys } = await context.supabase
      .from("gemini_keys")
      .select("id, label, error_count, disabled_until, is_active, last_used_at")
      .eq("user_id", context.userId);

    const now = Date.now();
    const all = (keys ?? []) as any[];
    const enabled = all.filter((k) => k.is_active !== false);
    const ready = enabled.filter(
      (k) => !k.disabled_until || new Date(k.disabled_until).getTime() <= now,
    );
    const paused = enabled.length - ready.length;

    let geminiStatus: AiQuotaHealth["gemini"]["status"] = "ok";
    if (all.length === 0) geminiStatus = "none";
    else if (ready.length === 0) geminiStatus = "exhausted";
    else if (ready.length <= GEMINI_ACTIVE_THRESHOLD) geminiStatus = "low";

    // --- 3. Suggestion de clé de secours (la plus fiable disponible) ---
    let backupKeyLabel: string | null = null;
    const backup =
      ready
        .slice()
        .sort(
          (a, b) =>
            (a.error_count ?? 0) - (b.error_count ?? 0) ||
            new Date(a.last_used_at ?? 0).getTime() - new Date(b.last_used_at ?? 0).getTime(),
        )[0] ?? null;
    if (backup) backupKeyLabel = backup.label || "Clé sans nom";

    // --- 4. Alerte globale ---
    let alertMessage: string | null = null;
    let suggestion: string | null = null;

    if (
      lovable.status === "exhausted" &&
      (geminiStatus === "exhausted" || geminiStatus === "none")
    ) {
      alertMessage =
        "Crédit Lovable AI épuisé ET aucune clé Gemini opérationnelle : l'IA ne peut plus répondre.";
      suggestion =
        "Ajoutez immédiatement une nouvelle clé Gemini dans la page « Clés API » pour rétablir les réponses automatiques.";
    } else if (lovable.status === "exhausted") {
      alertMessage = "Crédit Lovable AI épuisé : l'IA fonctionne uniquement sur vos clés Gemini.";
      suggestion = backupKeyLabel
        ? `Rechargez le crédit Lovable AI ou gardez la clé « ${backupKeyLabel} » comme clé de secours principale.`
        : "Ajoutez une clé Gemini de secours dans la page « Clés API ».";
    } else if (geminiStatus === "exhausted") {
      alertMessage =
        "Toutes vos clés Gemini sont en pause (quota dépassé) : seul Lovable AI répond actuellement.";
      suggestion =
        "Ajoutez une nouvelle clé Gemini de secours dans la page « Clés API » ou attendez la fin de la pause des clés existantes.";
    } else if (geminiStatus === "low") {
      alertMessage = `Quota Gemini faible : ${ready.length} seule clé opérationnelle sur ${enabled.length}.`;
      suggestion = backupKeyLabel
        ? `Ajoutez une clé Gemini supplémentaire ; la clé « ${backupKeyLabel} » sert actuellement de clé de secours.`
        : "Ajoutez une clé Gemini supplémentaire dans la page « Clés API ».";
    } else if (lovable.status === "error") {
      alertMessage = "La clé Lovable AI semble invalide.";
      suggestion = backupKeyLabel
        ? `Vérifiez la configuration Lovable AI ; la clé Gemini « ${backupKeyLabel} » assure le secours.`
        : "Vérifiez la configuration Lovable AI.";
    }

    return {
      lovable,
      gemini: {
        total: enabled.length,
        active: ready.length,
        paused,
        status: geminiStatus,
      },
      threshold: GEMINI_ACTIVE_THRESHOLD,
      alert: alertMessage !== null,
      alertMessage,
      suggestion,
      backupKeyLabel,
      checkedAt: new Date().toISOString(),
    };
  });
