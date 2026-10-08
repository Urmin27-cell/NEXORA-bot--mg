import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Tableau de bord interne du Gemini Quota Manager — admin uniquement. */
export const getQuotaMonitor = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: roleRow } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) return { isAdmin: false as const, snapshot: null };
    const { getQuotaSnapshot } = await import("./gemini-quota.server");
    return { isAdmin: true as const, snapshot: getQuotaSnapshot() };
  });
