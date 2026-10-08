import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface AdminUserRow {
  id: string;
  email: string | null;
  display_name: string | null;
  created_at: string | null;
}

export interface AdminPageRow {
  id: string;
  page_id: string;
  page_name: string;
  is_connected: boolean;
  webhook_subscribed: boolean;
  user_email: string | null;
  user_name: string | null;
}

export interface AdminUsersOverview {
  users: AdminUserRow[];
  usersWithPages: AdminUserRow[];
  pages: AdminPageRow[];
  totalUsers: number;
  totalPages: number;
}

export const getAdminUsersOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminUsersOverview> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: roleRow } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    const isAdmin = !!roleRow;
    if (!isAdmin) {
      return { users: [], usersWithPages: [], pages: [], totalUsers: 0, totalPages: 0 };
    }

    const [{ data: profiles }, { data: pages }] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id,email,display_name,created_at")
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("facebook_pages")
        .select("id,user_id,page_id,page_name,is_connected,webhook_subscribed")
        .order("created_at", { ascending: false }),
    ]);

    const users: AdminUserRow[] = (profiles ?? []) as AdminUserRow[];
    const byId = new Map(users.map((u) => [u.id, u]));

    const pageRows: AdminPageRow[] = (pages ?? []).map((p: any) => ({
      id: p.id,
      page_id: p.page_id,
      page_name: p.page_name,
      is_connected: !!p.is_connected,
      webhook_subscribed: !!p.webhook_subscribed,
      user_email: byId.get(p.user_id)?.email ?? null,
      user_name: byId.get(p.user_id)?.display_name ?? null,
    }));

    const withPagesIds = new Set((pages ?? []).map((p: any) => p.user_id));
    const usersWithPages = users.filter((u) => withPagesIds.has(u.id));

    return {
      users,
      usersWithPages,
      pages: pageRows,
      totalUsers: users.length,
      totalPages: pageRows.length,
    };
  });
