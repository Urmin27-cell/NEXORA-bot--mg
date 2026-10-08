// Clés OpenAI (ChatGPT) fournies par l'administrateur : détection automatique
// du meilleur modèle disponible et appel chat/completions.

const PREFERRED_MODELS = [
  "gpt-4.1-mini",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4.1-nano",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
];

export async function detectOpenAiModel(
  apiKey: string,
): Promise<{ ok: true; model: string; models: string[] } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `OpenAI ${res.status}: ${t.slice(0, 200)}` };
    }
    const j: any = await res.json();
    const ids: string[] = (j?.data ?? []).map((m: any) => String(m.id));
    const chatIds = ids.filter(
      (id) =>
        /^(gpt-|chatgpt-)/.test(id) &&
        !/(audio|realtime|transcribe|tts|image|search|instruct|embedding)/.test(id),
    );
    const candidates = [
      ...PREFERRED_MODELS.filter((m) => chatIds.includes(m)),
      ...chatIds.filter((m) => !PREFERRED_MODELS.includes(m)),
    ];
    // On vérifie réellement que le modèle répond (quota, accès).
    let lastErr = "Aucun modèle de chat disponible sur ce compte";
    for (const model of candidates.slice(0, 4)) {
      try {
        await callOpenAiChat(apiKey, model, [{ role: "user", content: "ping" }], 5);
        return { ok: true, model, models: chatIds };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (/401|insufficient_quota|429/.test(lastErr)) break;
      }
    }
    return { ok: false, error: lastErr };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function callOpenAiChat(
  apiKey: string,
  model: string,
  messages: any[],
  maxTokens = 1500,
): Promise<string> {
  const newStyle = /^(gpt-5|o\d)/.test(model);
  const body: Record<string, unknown> = { model, messages };
  if (newStyle) body.max_completion_tokens = Math.max(maxTokens, 16);
  else {
    body.max_tokens = maxTokens;
    body.temperature = 0.3;
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    const err: any = new Error(`OpenAI ${res.status}: ${t.slice(0, 200)}`);
    err.isQuota = res.status === 429 || t.includes("insufficient_quota");
    err.isAuth = res.status === 401;
    throw err;
  }
  const j: any = await res.json();
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("OpenAI: réponse vide");
  return text;
}
