import { GoogleGenAI } from "@google/genai";
import type { ChatTurn, AiPart } from "./ai-engine.server";

/**
 * Modèles Gemini modernes officiels pris en charge pour la rotation.
 * gemini-3.8-flash : ultra rapide, intelligent, idéal pour le service client et messages
 * gemini-flash-latest : dernière version stable Flash
 * gemini-3.1-flash-lite : modèle ultra-léger et économique
 * gemini-3.1-pro-preview : grand modèle de raisonnement complexe
 */
export const GEMINI_ROTATION_MODELS = [
  "gemini-3.8-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview",
] as const;

export type GeminiModel = (typeof GEMINI_ROTATION_MODELS)[number];

// Compteur global pour la rotation cyclique des modèles à chaque message
let rotationCounter = 0;

// Registre de mise en pause temporaire des modèles ayant atteint leur quota ou un 503 temporaire
const modelCooldowns = new Map<string, number>();

export function isModelCoolingDown(model: string): boolean {
  const until = modelCooldowns.get(model);
  if (!until) return false;
  if (Date.now() > until) {
    modelCooldowns.delete(model);
    return false;
  }
  return true;
}

export function setModelCooldown(model: string, durationMs = 60_000) {
  modelCooldowns.set(model, Date.now() + durationMs);
}

/**
 * Retourne une instance de GoogleGenAI configurée selon les standards AI Studio Build.
 */
export function getGeminiClient(customApiKey?: string): GoogleGenAI {
  const apiKey = (customApiKey || process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error(
      "Clé API Gemini introuvable. Configurez GEMINI_API_KEY sur le serveur ou ajoutez une clé dans les paramètres.",
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

/**
 * Prépare les messages pour l'API @google/genai (format alterné user/model).
 */
export function formatContentsForGenAi(history: ChatTurn[], parts: AiPart[]) {
  const turns: Array<{ role: "user" | "model"; parts: any[] }> = [];

  for (const h of history) {
    const role = h.role === "assistant" ? "model" : "user";
    const text = (h.text || "").trim();
    if (!text) continue;
    turns.push({
      role,
      parts: [{ text }],
    });
  }

  // Formatage des parties du message actuel
  const currentParts: any[] = [];
  for (const p of parts) {
    if ("text" in p && typeof p.text === "string" && p.text.trim()) {
      currentParts.push({ text: p.text });
    } else if ("inline_data" in p && p.inline_data) {
      currentParts.push({
        inlineData: {
          mimeType: p.inline_data.mime_type,
          data: p.inline_data.data,
        },
      });
    } else if ("inlineData" in (p as any) && (p as any).inlineData) {
      currentParts.push({
        inlineData: (p as any).inlineData,
      });
    }
  }

  if (currentParts.length === 0) {
    currentParts.push({ text: "(message)" });
  }

  turns.push({
    role: "user",
    parts: currentParts,
  });

  // Fusionner les tours consécutifs ayant le même rôle
  const merged: Array<{ role: "user" | "model"; parts: any[] }> = [];
  for (const turn of turns) {
    if (merged.length > 0 && merged[merged.length - 1]!.role === turn.role) {
      merged[merged.length - 1]!.parts.push(...turn.parts);
    } else {
      merged.push({ role: turn.role, parts: [...turn.parts] });
    }
  }

  // S'assurer que le premier tour commence par "user"
  if (merged.length > 0 && merged[0]!.role === "model") {
    merged.shift();
  }

  if (merged.length === 0) {
    return [{ role: "user", parts: [{ text: "(message)" }] }];
  }

  return merged;
}

/**
 * Exécute un appel Gemini avec rotation automatique entre TOUS les modèles disponibles.
 * Si le modèle actif subit un quota (429), une surcharge (503) ou une erreur,
 * la requête bascule immédiatement vers le modèle suivant dans la boucle de rotation.
 */
export async function callGeminiWithRotation(opts: {
  strictSystemPrompt: string;
  history: ChatTurn[];
  parts: AiPart[];
  maxTokens?: number;
  preferredModel?: string | null;
  apiKey?: string;
}): Promise<{ text: string; model: string; provider: string }> {
  const maxTokens = opts.maxTokens ?? 1500;
  const apiKey = (opts.apiKey || process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Clé API Gemini non définie pour la rotation des modèles.");
  }

  const ai = getGeminiClient(apiKey);
  const contents = formatContentsForGenAi(opts.history, opts.parts);

  // Construction de la liste ordonnée des modèles pour cette requête
  const basePool = [...GEMINI_ROTATION_MODELS];
  let candidateOrder: string[] = [];

  const pref = (opts.preferredModel || "").trim();
  if (pref && pref !== "gemini-rotation" && basePool.includes(pref as any)) {
    // Si l'utilisateur a choisi un modèle précis, on le teste en premier
    const others = basePool.filter((m) => m !== pref);
    candidateOrder = [pref, ...others];
  } else {
    // Rotation circulaire entre tous les modèles
    const startIdx = rotationCounter % basePool.length;
    rotationCounter = (rotationCounter + 1) % 1_000_000;
    candidateOrder = [...basePool.slice(startIdx), ...basePool.slice(0, startIdx)];
  }

  // Prioriser les modèles qui ne sont pas en refroidissement
  candidateOrder.sort((a, b) => {
    const aCool = isModelCoolingDown(a) ? 1 : 0;
    const bCool = isModelCoolingDown(b) ? 1 : 0;
    return aCool - bCool;
  });

  const errors: string[] = [];

  for (const model of candidateOrder) {
    try {
      console.log(`[gemini-rotation] Envoi au modèle: ${model}...`);
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: opts.strictSystemPrompt,
          temperature: 0.3,
          maxOutputTokens: maxTokens,
        },
      });

      // Règle skill: accéder à .text directement, ne JAMAIS appeler .text()
      const rawText = response.text || "";
      const text = rawText.trim();

      if (!text) {
        throw new Error(`Réponse vide reçue du modèle ${model}`);
      }

      // Succès: lever le cooldown éventuel
      modelCooldowns.delete(model);
      console.log(`[gemini-rotation] Succès avec ${model} (${text.length} caractères)`);

      return {
        text,
        model,
        provider: `gemini:${model}`,
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[gemini-rotation] Échec sur le modèle ${model}:`, errMsg);
      errors.push(`${model}: ${errMsg.slice(0, 150)}`);

      // Quota (429), indisponibilité (503), ou ressource épuisée
      if (
        errMsg.includes("429") ||
        errMsg.includes("503") ||
        errMsg.includes("RESOURCE_EXHAUSTED") ||
        errMsg.toLowerCase().includes("quota")
      ) {
        setModelCooldown(model, 60_000);
      }

      // Clé invalide globale (401 / 403 / unauthenticated)
      if (
        errMsg.includes("401") ||
        errMsg.includes("403") ||
        errMsg.includes("UNAUTHENTICATED") ||
        errMsg.includes("API key not valid")
      ) {
        throw new Error(`Clé API Gemini invalide : ${errMsg}`);
      }

      // Continuer la rotation vers le modèle suivant dans la liste
      continue;
    }
  }

  // Si tous les modèles du pool ont échoué
  throw new Error(`Tous les modèles Gemini de la rotation ont échoué : [${errors.join(" | ")}]`);
}
