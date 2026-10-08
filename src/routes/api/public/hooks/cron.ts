// Master Cron endpoint for the few tasks Facebook cannot push to us:
// - Publish due scheduled posts
// - Scheduled AI push notifications
//
// Private messages AND comments are never scanned: Facebook sends each new
// message/comment to /api/public/fb/webhook, the AI answers there and the
// answer is sent back through Facebook to the client.

import { createFileRoute } from "@tanstack/react-router";
import { runBackgroundWorkerTick, getWorkerStatus } from "@/lib/background-worker.server";

async function handleCron() {
  try {
    // The worker tick already sends the scheduled pushes; calling them twice
    // only wasted quota.
    const result = await runBackgroundWorkerTick();
    const status = getWorkerStatus();
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "webhook-driven",
        timestamp: new Date().toISOString(),
        status,
        result,
      }),
      {
        headers: {
          "content-type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
}

export const Route = createFileRoute("/api/public/hooks/cron")({
  server: {
    handlers: {
      GET: async () => handleCron(),
      POST: async () => handleCron(),
    },
  },
});
