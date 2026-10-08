import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Gauge } from "lucide-react";
import { getQuotaMonitor } from "@/lib/quota-monitor.functions";

const statusLabel: Record<string, string> = {
  ok: "Normal",
  info: "50% atteint",
  warning: "70% atteint",
  high: "85% atteint",
  critical: "Critique (95%)",
};

export function QuotaMonitorCard() {
  const fetchMonitor = useServerFn(getQuotaMonitor);
  const { data } = useQuery({
    queryKey: ["quota-monitor"],
    queryFn: () => fetchMonitor(),
    refetchInterval: 15_000,
  });
  if (!data?.isAdmin || !data.snapshot) return null;
  const s = data.snapshot;
  const items: [string, string | number][] = [
    ["Requêtes / minute", `${s.requestsThisMinute} / ${s.config.MAX_RPM}`],
    ["Requêtes / heure", s.requestsThisHour],
    ["Requêtes aujourd'hui", `${s.requestsToday} / ${s.config.MAX_RPD}`],
    ["Tokens estimés (jour)", s.estimatedTokensToday.toLocaleString()],
    ["Erreurs", s.errors],
    ["Erreurs 429", s.errors429],
    ["Temps de réponse moyen", `${s.avgResponseMs} ms`],
    ["Taux de cache", `${s.cacheHitRate}%`],
    ["Appels IA évités", s.callsAvoided],
    ["Réponses de secours", s.fallbacks],
    ["En cours / en file", `${s.activeRequests} / ${s.queued}`],
  ];
  const variant = s.status === "critical" || s.status === "high" ? "destructive" : "secondary";
  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-primary" />
          <h2 className="font-semibold">Quota Manager IA (admin)</h2>
        </div>
        <Badge variant={variant}>
          {statusLabel[s.status] ?? s.status} — {s.usagePct}%
        </Badge>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {items.map(([k, v]) => (
          <div key={k} className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">{k}</div>
            <div className="text-lg font-semibold">{v}</div>
          </div>
        ))}
      </div>
      {Object.keys(s.modelUsage).length > 0 && (
        <div className="text-sm">
          <span className="text-muted-foreground">Modèles : </span>
          {Object.entries(s.modelUsage)
            .map(([m, n]) => `${m} (${n})`)
            .join(", ")}
        </div>
      )}
      {s.alerts.length > 0 && (
        <div className="space-y-1">
          {s.alerts.map((a, i) => (
            <div key={i} className="text-sm text-destructive">
              {new Date(a.at).toLocaleTimeString()} — {a.message}
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Max 3 phrases par réponse, cache {s.config.CACHE_TTL_MS / 60000} min,{" "}
        {s.config.MAX_CONCURRENT_AI_REQUESTS} requêtes simultanées, {s.config.MAX_RETRY} essais max.
      </p>
    </Card>
  );
}
