// Manual-only endpoint.
//
// The platform is webhook-driven: Facebook pushes every new private message to
// /api/public/fb/webhook and the AI answers immediately. Scanning all
// conversations again on a schedule duplicated that work and burned Graph API
// and AI quota, so this endpoint no longer runs automatically.
//
// It is kept as a manual safety net (e.g. after a Facebook outage) and only
// runs when explicitly called with ?manual=1.

import { createFileRoute } from "@tanstack/react-router";

async function handleReplyAll(request: Request) {
  const url = new URL(request.url);
  const manual = url.searchParams.get("manual") === "1" || url.searchParams.get("force") === "1";
  if (!manual) {
    return new Response(
      JSON.stringify({
        ok: true,
        skipped: true,
        mode: "webhook-driven",
        message:
          "Scan automatique désactivé : Facebook envoie les nouveaux messages au webhook et l'IA répond en direct. Ajoutez ?manual=1 pour forcer un rattrapage.",
      }),
      { headers: { "content-type": "application/json", "Cache-Control": "no-store" } },
    );
  }

  try {
    const { replyAllPendingForAllUsers } = await import("@/lib/ai-engine.server");
    const result = await replyAllPendingForAllUsers();
    console.log("[manual reply-all messages]", result);
    return new Response(
      JSON.stringify({ ok: true, manual: true, timestamp: new Date().toISOString(), ...result }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  } catch (e) {
    console.error("[manual reply-all messages] error", e);
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "unknown" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

export const Route = createFileRoute("/api/public/hooks/reply-all-messages")({
  server: {
    handlers: {
      GET: async ({ request }) => handleReplyAll(request),
      POST: async ({ request }) => handleReplyAll(request),
    },
  },
});
