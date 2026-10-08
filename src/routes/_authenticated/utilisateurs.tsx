import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Facebook, RefreshCw, UserCheck } from "lucide-react";
import { getAdminUsersOverview } from "@/lib/admin-overview.functions";

export const Route = createFileRoute("/_authenticated/utilisateurs")({
  component: UtilisateursPage,
  head: () => ({
    meta: [
      { title: "Utilisateurs — NEXORA" },
      { name: "description", content: "Liste des utilisateurs et des pages Facebook connectées." },
      { property: "og:title", content: "Utilisateurs — NEXORA" },
      {
        property: "og:description",
        content: "Liste des utilisateurs et des pages Facebook connectées.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function fmtDate(d: string | null) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function UtilisateursPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin-users-overview"],
    queryFn: () => getAdminUsersOverview(),
    staleTime: 0,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
  const data = q.data;

  useEffect(() => {
    const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-users-overview"] });
    const channel = supabase
      .channel("admin-users-overview")
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "facebook_pages" }, invalidate)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" /> Utilisateurs
          </h1>
          <p className="text-muted-foreground text-sm">
            Liste des utilisateurs inscrits et des pages Facebook connectées.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${q.isFetching ? "animate-spin" : ""}`} />
          Actualiser
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Utilisateurs inscrits</CardDescription>
            <CardTitle className="text-3xl">{data?.totalUsers ?? "—"}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Utilisateurs avec page</CardDescription>
            <CardTitle className="text-3xl">{data?.usersWithPages.length ?? "—"}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pages connectées</CardDescription>
            <CardTitle className="text-3xl">{data?.totalPages ?? "—"}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" /> Tous les utilisateurs inscrits
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Nom</th>
                <th className="py-2 pr-4 font-medium">Email</th>
                <th className="py-2 font-medium">Inscrit le</th>
              </tr>
            </thead>
            <tbody>
              {(data?.users ?? []).map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">{u.display_name || "—"}</td>
                  <td className="py-2 pr-4">{u.email || "—"}</td>
                  <td className="py-2">{fmtDate(u.created_at)}</td>
                </tr>
              ))}
              {data && data.users.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-muted-foreground">
                    Aucun utilisateur.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCheck className="h-4 w-4" /> Utilisateurs ayant connecté une page
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Nom</th>
                <th className="py-2 pr-4 font-medium">Email</th>
                <th className="py-2 font-medium">Inscrit le</th>
              </tr>
            </thead>
            <tbody>
              {(data?.usersWithPages ?? []).map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">{u.display_name || "—"}</td>
                  <td className="py-2 pr-4">{u.email || "—"}</td>
                  <td className="py-2">{fmtDate(u.created_at)}</td>
                </tr>
              ))}
              {data && data.usersWithPages.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-muted-foreground">
                    Aucun utilisateur avec page.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Facebook className="h-4 w-4" /> Pages connectées ({data?.totalPages ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Page</th>
                <th className="py-2 pr-4 font-medium">Propriétaire</th>
                <th className="py-2 pr-4 font-medium">Statut</th>
                <th className="py-2 font-medium">Webhook</th>
              </tr>
            </thead>
            <tbody>
              {(data?.pages ?? []).map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium">{p.page_name}</td>
                  <td className="py-2 pr-4">{p.user_name || p.user_email || "—"}</td>
                  <td className="py-2 pr-4">
                    <Badge variant={p.is_connected ? "default" : "secondary"}>
                      {p.is_connected ? "Connectée" : "Déconnectée"}
                    </Badge>
                  </td>
                  <td className="py-2">
                    <Badge variant={p.webhook_subscribed ? "default" : "outline"}>
                      {p.webhook_subscribed ? "Actif" : "Inactif"}
                    </Badge>
                  </td>
                </tr>
              ))}
              {data && data.pages.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-muted-foreground">
                    Aucune page connectée.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
