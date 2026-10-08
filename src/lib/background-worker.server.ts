import { supabaseAdmin } from "@/integrations/supabase/client.server";

let isWorkerStarted = false;
let isWorkerRunning = false;
let lastRunTimestamp = 0;

/**
 * Runs one tick of the background worker.
 *
 * The AI NEVER scans Facebook. Facebook pushes every new private message and
 * every new comment to /api/public/fb/webhook, the AI answers there and the
 * answer goes straight back to Facebook, which delivers it to the client.
 *
 * This tick therefore only handles work Facebook cannot push:
 * 1. Scheduled AI push notifications.
 * 2. Publishing due scheduled Facebook posts.
 */

export async function runBackgroundWorkerTick(): Promise<{
  messages?: any;
  posts?: any;
  comments?: any;
  pending?: any;
  skipped?: boolean;
}> {
  if (isWorkerRunning) {
    return { skipped: true };
  }

  const hasSupabaseAdmin = Boolean(
    (process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"]) &&
    process.env["SUPABASE_SERVICE_ROLE_KEY"],
  );

  if (!hasSupabaseAdmin) {
    return { skipped: true };
  }

  const { data: claimed, error: claimError } = await (supabaseAdmin as any).rpc(
    "claim_background_job",
    { _job_name: "facebook-automation", _lease_seconds: 120 },
  );
  if (claimError) throw new Error(`Worker lock failed: ${claimError.message}`);
  if (!claimed) return { skipped: true };

  isWorkerRunning = true;
  lastRunTimestamp = Date.now();

  try {
    // 0. Scheduled AI push notifications (13h & 20h Madagascar)
    try {
      const { maybeSendScheduledPush } = await import("@/lib/push-notify.server");
      await maybeSendScheduledPush();
    } catch (e) {
      console.error("[background-worker] push error:", e);
    }

    // 1. Messenger private messages are NOT polled here.
    //    Facebook itself signals new messages through the webhook
    //    (/api/public/fb/webhook), which replies immediately.
    const messagesResult = null;

    // 2. Publish due scheduled posts
    let postsResult = null;
    try {
      const { runScheduledPost } = await import("@/lib/post-publisher.server");
      const nowIso = new Date().toISOString();
      const { data: duePosts } = await supabaseAdmin
        .from("scheduled_posts")
        .select("id")
        .eq("status", "pending")
        .lte("scheduled_at", nowIso)
        .order("scheduled_at", { ascending: true })
        .limit(10);

      if (duePosts && duePosts.length > 0) {
        const results = [];
        for (const post of duePosts) {
          try {
            const r = await runScheduledPost(post.id);
            results.push({ id: post.id, ...r });
          } catch (postErr) {
            results.push({
              id: post.id,
              ok: false,
              error: postErr instanceof Error ? postErr.message : String(postErr),
            });
          }
        }
        postsResult = { processed: results.length, results };
        console.log("[background-worker] Scheduled posts published:", postsResult);
      }
    } catch (e) {
      console.error("[background-worker] Posts error:", e);
    }

    // 3. Comments are NOT scanned anymore: Facebook pushes each new comment to
    //    the webhook, the AI answers there. Polling burned Graph + AI quota.
    const commentsResult = null;

    // 4. MINI IA : questions laissées en attente pendant l'indisponibilité de
    //    l'IA principale. Dès qu'une clé Gemini / Lovable AI répond de nouveau,
    //    le client reçoit sa vraie réponse.
    let pendingResult = null;
    try {
      const { processAllPendingRequests } = await import("@/lib/ai-engine.server");
      const r = await processAllPendingRequests();
      if (r.messages > 0 || r.comments > 0) {
        pendingResult = r;
        console.log("[background-worker] Mini IA pending handled:", r);
      }
    } catch (e) {
      console.error("[background-worker] Mini IA pending error:", e);
    }

    const result = {
      messages: messagesResult,
      posts: postsResult,
      comments: commentsResult,
      pending: pendingResult,
    };
    await (supabaseAdmin as any).rpc("finish_background_job", {
      _job_name: "facebook-automation",
      _status: "idle",
      _result: result,
    });
    return result;
  } catch (error) {
    await (supabaseAdmin as any).rpc("finish_background_job", {
      _job_name: "facebook-automation",
      _status: "failed",
      _result: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  } finally {
    isWorkerRunning = false;
  }
}

/** Starts a best-effort local loop. Production scheduling is database-backed.
 *  Replies no longer depend on this loop (Facebook webhook does that), so the
 *  tick is slow on purpose: it only publishes due posts and scheduled pushes. */
const TICK_INTERVAL_MS = 60 * 1000; // 1 minute — quota friendly

export function startBackgroundWorker(): void {
  if (isWorkerStarted) return;
  isWorkerStarted = true;

  const hasSupabaseAdmin = Boolean(
    (process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"]) &&
    process.env["SUPABASE_SERVICE_ROLE_KEY"],
  );

  if (!hasSupabaseAdmin) {
    console.log(
      "[background-worker] Supabase service role key not configured — background worker idle.",
    );
    return;
  }

  console.log("[background-worker] Starting light scheduler loop (every 60s)...");

  // Run first tick shortly after boot (10s)
  setTimeout(() => {
    runBackgroundWorkerTick().catch((err) =>
      console.error("[background-worker] Initial tick error:", err),
    );
  }, 10000);

  setInterval(() => {
    runBackgroundWorkerTick().catch((err) =>
      console.error("[background-worker] Periodic tick error:", err),
    );
  }, TICK_INTERVAL_MS);
}

/**
 * Serverless-safe fallback: triggered by incoming requests.
 * If more than one minute elapsed since the last tick, run one in the
 * background. No message/comment scanning happens here.
 */
export function maybeTickOnRequest(waitUntil?: (p: Promise<unknown>) => void): void {
  if (isWorkerRunning) return;
  const hasSupabaseAdmin = Boolean(
    (process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"]) &&
    process.env["SUPABASE_SERVICE_ROLE_KEY"],
  );
  if (!hasSupabaseAdmin) return;
  if (Date.now() - lastRunTimestamp < TICK_INTERVAL_MS) return;
  const p = runBackgroundWorkerTick().catch((err) =>
    console.error("[background-worker] Request tick error:", err),
  );
  if (waitUntil) {
    try {
      waitUntil(p);
    } catch {
      /* ignore */
    }
  }
}

export function getWorkerStatus() {
  return {
    isWorkerStarted,
    isWorkerRunning,
    lastRunTimestamp,
    lastRunAgoSeconds: lastRunTimestamp ? Math.round((Date.now() - lastRunTimestamp) / 1000) : null,
  };
}
