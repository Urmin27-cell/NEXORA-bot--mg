import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getSettings,
  updateSettings,
  replyAllPendingMessages,
  scanAndReplyCommentsNow,
} from "@/lib/dashboard.functions";
import {
  getSupabaseOAuthStatus,
  selectSupabaseProject,
  disconnectSupabaseOAuth,
  getSupabaseAuthUrl,
} from "@/lib/supabase-oauth.functions";
import { getAiQuotaHealth } from "@/lib/ai-health.functions";
import {
  Save,
  Send,
  Loader2,
  Facebook,
  KeyRound,
  Sparkles,
  Database,
  CheckCircle2,
  RefreshCw,
  ExternalLink,
  Zap,
  Clock,
  Copy,
  MessageSquare,
  AlertTriangle,
  ShieldCheck,
  LifeBuoy,
} from "lucide-react";
import { toast } from "sonner";
import { PushNotificationsCard } from "@/components/PushNotificationsCard";

const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: async () => {
    try {
      return await getSettings();
    } catch (e) {
      console.warn("Settings query error", e);
      return null;
    }
  },
});
const supabaseStatusQuery = queryOptions({
  queryKey: ["supabase-oauth-status"],
  queryFn: async () => {
    try {
      return await getSupabaseOAuthStatus();
    } catch (e) {
      console.warn("Supabase OAuth status query error", e);
      return { isConnected: false };
    }
  },
});

const aiHealthQuery = queryOptions({
  queryKey: ["ai-quota-health"],
  queryFn: async () => {
    try {
      return await getAiQuotaHealth();
    } catch (e) {
      console.warn("AI health query error", e);
      return null;
    }
  },
  // Vérification toutes les 10 minutes (au lieu de 5 s) pour économiser les crédits.
  refetchInterval: 10 * 60 * 1000,
  refetchIntervalInBackground: false,
  staleTime: 10 * 60 * 1000,
});

export const Route = createFileRoute("/_authenticated/settings")({
  loader: ({ context }) => {
    return Promise.all([
      context.queryClient.ensureQueryData(settingsQuery),
      context.queryClient.ensureQueryData(supabaseStatusQuery),
    ]);
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { data } = useSuspenseQuery(settingsQuery);
  const { data: sbStatusRaw } = useSuspenseQuery(supabaseStatusQuery);
  const {
    data: health,
    refetch: refetchHealth,
    isFetching: healthChecking,
  } = useQuery(aiHealthQuery);
  const sbStatus = sbStatusRaw as any;
  const qc = useQueryClient();
  const [sbConnecting, setSbConnecting] = useState(false);
  const [sbSelecting, setSbSelecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replying, setReplying] = useState(false);
  const [scanningComments, setScanningComments] = useState(false);
  const [form, setForm] = useState({
    assistance_type: (data as any)?.assistance_type ?? "online_work",
    auto_reply_messages: data?.auto_reply_messages ?? true,
    auto_reply_comments: data?.auto_reply_comments ?? true,
    comment_scan_interval_minutes: data?.comment_scan_interval_minutes ?? 5,
    use_lovable_ai_fallback: data?.use_lovable_ai_fallback ?? true,
    default_model: data?.default_model || "gemini-3.6-flash",
    private_message_link: data?.private_message_link ?? "",
    facebook_app_id: data?.facebook_app_id ?? "",
    facebook_app_secret: data?.facebook_app_secret ?? "",
    facebook_verify_token: data?.facebook_verify_token ?? "",
  });

  useEffect(() => {
    if (data) {
      setForm({
        assistance_type: (data as any).assistance_type ?? "online_work",
        auto_reply_messages: data.auto_reply_messages ?? true,
        auto_reply_comments: data.auto_reply_comments ?? true,
        comment_scan_interval_minutes: data.comment_scan_interval_minutes ?? 5,
        use_lovable_ai_fallback: data.use_lovable_ai_fallback ?? true,
        default_model: data.default_model || "gemini-3.6-flash",
        private_message_link: data.private_message_link ?? "",
        facebook_app_id: data.facebook_app_id ?? "",
        facebook_app_secret: data.facebook_app_secret ?? "",
        facebook_verify_token: data.facebook_verify_token ?? "",
      });
    }
  }, [data]);

  const connectSupabase = async () => {
    setSbConnecting(true);
    try {
      const redirectUri = `${window.location.origin}/api/public/supabase/callback`;
      const { url } = await getSupabaseAuthUrl({
        data: {
          redirectUri,
          userId: data?.user_id || "current_user",
          mode: "connect",
        },
      });

      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        url,
        "supabase_oauth",
        `width=${width},height=${height},left=${left},top=${top},status=no,toolbar=no,menubar=no`,
      );

      if (!popup || popup.closed || typeof popup.closed === "undefined") {
        window.location.href = url;
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur OAuth Supabase");
    } finally {
      setSbConnecting(false);
    }
  };

  const handleSelectProject = async (projectId: string) => {
    setSbSelecting(true);
    try {
      await selectSupabaseProject({ data: { projectId } });
      toast.success("Projet Supabase activé pour votre compte !");
      qc.invalidateQueries({ queryKey: ["supabase-oauth-status"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur de sélection");
    } finally {
      setSbSelecting(false);
    }
  };

  const handleDisconnectSupabase = async () => {
    if (!confirm("Voulez-vous déconnecter votre compte Supabase ?")) return;
    try {
      await disconnectSupabaseOAuth();
      toast.success("Compte Supabase déconnecté.");
      qc.invalidateQueries({ queryKey: ["supabase-oauth-status"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "SUPABASE_OAUTH_SUCCESS") {
        toast.success("Compte Supabase connecté avec succès !");
        qc.invalidateQueries({ queryKey: ["supabase-oauth-status"] });
        qc.invalidateQueries({ queryKey: ["settings"] });
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [qc]);

  const save = async () => {
    try {
      await updateSettings({
        data: {
          ...form,
          private_message_link: form.private_message_link || null,
          facebook_app_id: form.facebook_app_id || null,
          facebook_app_secret: form.facebook_app_secret || null,
          facebook_verify_token: form.facebook_verify_token || null,
        } as any,
      });
      toast.success("Paramètres enregistrés");
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  };

  const replyAll = async () => {
    setReplying(true);
    try {
      const res = await replyAllPendingMessages();
      const detailStr = res.details?.length ? `\n${res.details.join("\n")}` : "";
      if (res.errors > 0 && res.replied === 0) {
        toast.error(
          `${res.replied} réponse(s) envoyée(s) sur ${res.processed} conversation(s) — ${res.errors} erreur(s)${detailStr}`,
        );
      } else {
        toast.success(
          `${res.replied} réponse(s) envoyée(s) sur ${res.processed} conversation(s) en attente${
            res.errors ? ` (${res.errors} erreur(s))` : ""
          }${detailStr}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["messages-log"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setReplying(false);
    }
  };

  const scanComments = async () => {
    setScanningComments(true);
    try {
      const res = await scanAndReplyCommentsNow();
      const detailStr = res.details?.length ? `\n${res.details.join("\n")}` : "";
      if (res.errors > 0 && res.replied === 0) {
        toast.error(
          `${res.replied} réponse(s) sur ${res.scanned} commentaire(s) — ${res.errors} erreur(s)${detailStr}`,
        );
      } else {
        toast.success(
          `${res.replied} commentaire(s) répondu(s) sur ${res.scanned} analysé(s)${
            res.errors ? ` (${res.errors} erreur(s))` : ""
          }${detailStr}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["comments-log"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setScanningComments(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copié dans le presse-papier !`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold gradient-text">Paramètres</h1>
        <p className="text-muted-foreground mt-1">Comportement de l'IA et de l'automatisation.</p>
      </div>

      <Card className="glass p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Type d'assistance</h2>
            <p className="text-xs text-muted-foreground">
              Change complètement le comportement de l'IA et le menu latéral.
            </p>
          </div>
        </div>
        <Select
          value={form.assistance_type}
          onValueChange={(v) => setForm({ ...form, assistance_type: v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="online_work">1. Travail en ligne</SelectItem>
            <SelectItem value="training">2. Formation</SelectItem>
            <SelectItem value="sales">3. Vente</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Enregistre pour appliquer ; le menu latéral s'adapte automatiquement.
        </p>
      </Card>

      <Card className="glass p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Répondre automatiquement aux messages privés</Label>
            <p className="text-xs text-muted-foreground">
              L'IA répond aux DM Messenger en temps réel.
            </p>
          </div>
          <Switch
            checked={form.auto_reply_messages}
            onCheckedChange={(v) => setForm({ ...form, auto_reply_messages: v })}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Répondre automatiquement aux commentaires</Label>
            <p className="text-xs text-muted-foreground">
              Scan périodique + réponse automatique des commentaires sans réponse.
            </p>
          </div>
          <Switch
            checked={form.auto_reply_comments}
            onCheckedChange={(v) => setForm({ ...form, auto_reply_comments: v })}
          />
        </div>

        <div>
          <Label>Intervalle de scan des commentaires (minutes)</Label>
          <Input
            type="number"
            min={1}
            max={60}
            value={form.comment_scan_interval_minutes}
            onChange={(e) =>
              setForm({ ...form, comment_scan_interval_minutes: Number(e.target.value) })
            }
          />
        </div>

        <div>
          <Label>Modèle IA par défaut</Label>
          <Select
            value={form.default_model}
            onValueChange={(v) => setForm({ ...form, default_model: v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gemini-3.6-flash">Gemini 3.6 Flash (recommandé)</SelectItem>
              <SelectItem value="gemini-flash-latest">Gemini Flash (dernier)</SelectItem>
              <SelectItem value="gemini-3.5-flash">Gemini 3.5 Flash</SelectItem>
              <SelectItem value="gemini-pro-latest">Gemini Pro (dernier)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Fallback Lovable AI</Label>
            <p className="text-xs text-muted-foreground">
              Si toutes les clés Gemini sont épuisées, utiliser Lovable AI.
            </p>
          </div>
          <Switch
            checked={form.use_lovable_ai_fallback}
            onCheckedChange={(v) => setForm({ ...form, use_lovable_ai_fallback: v })}
          />
        </div>

        <div>
          <Label>Lien à envoyer en message privé (optionnel)</Label>
          <Input
            type="url"
            placeholder="https://votresite.com/produit"
            value={form.private_message_link}
            onChange={(e) => setForm({ ...form, private_message_link: e.target.value })}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Ce lien peut être inséré dans les messages privés mais jamais dans un commentaire.
          </p>
        </div>

        <Button onClick={save}>
          <Save className="h-4 w-4 mr-2" />
          Enregistrer
        </Button>
      </Card>

      {/* Alerte quota IA (Lovable AI + Gemini) */}
      <Card
        className={`glass p-6 space-y-4 ${
          health?.alert ? "border-amber-500/40" : "border-emerald-500/20"
        }`}
      >
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div
              className={`h-10 w-10 rounded-xl flex items-center justify-center ${
                health?.alert
                  ? "bg-amber-500/15 text-amber-400"
                  : "bg-emerald-500/15 text-emerald-400"
              }`}
            >
              {health?.alert ? (
                <AlertTriangle className="h-5 w-5" />
              ) : (
                <ShieldCheck className="h-5 w-5" />
              )}
            </div>
            <div>
              <h2 className="text-lg font-semibold">Surveillance des quotas IA</h2>
              <p className="text-xs text-muted-foreground">
                Alerte quand le crédit Lovable AI ou le quota Gemini passe sous le seuil.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetchHealth()}
            disabled={healthChecking}
            className="text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${healthChecking ? "animate-spin" : ""}`} />
            Vérifier
          </Button>
        </div>

        {health ? (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg bg-black/40 border border-white/5 p-3">
                <div className="text-xs text-muted-foreground mb-1">Lovable AI</div>
                <div
                  className={`font-medium ${
                    health.lovable.status === "ok"
                      ? "text-emerald-400"
                      : health.lovable.status === "exhausted"
                        ? "text-red-400"
                        : "text-amber-400"
                  }`}
                >
                  {health.lovable.status === "ok"
                    ? "Crédit disponible"
                    : health.lovable.status === "exhausted"
                      ? "Crédit épuisé"
                      : health.lovable.status === "error"
                        ? "Clé invalide"
                        : "État inconnu"}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {health.lovable.detail}
                </div>
                {health.lovable.usedPercent !== null &&
                  health.lovable.remainingPercent !== null && (
                    <div className="mt-2 space-y-1">
                      <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            health.lovable.remainingPercent <= 10
                              ? "bg-red-400"
                              : health.lovable.remainingPercent <= 30
                                ? "bg-amber-400"
                                : "bg-emerald-400"
                          }`}
                          style={{
                            width: `${health.lovable.limit && health.lovable.remaining !== null ? ((health.lovable.limit - health.lovable.remaining) / health.lovable.limit) * 100 : health.lovable.usedPercent}%`,
                          }}
                        />
                      </div>
                      <div className="flex justify-between text-[11px] text-muted-foreground">
                        <span>
                          Consommé :{" "}
                          {health.lovable.limit && health.lovable.remaining !== null
                            ? `${(((health.lovable.limit - health.lovable.remaining) / health.lovable.limit) * 100).toFixed(2)}% (${(health.lovable.limit - health.lovable.remaining).toLocaleString("fr-FR")})`
                            : `${health.lovable.usedPercent}%`}
                        </span>
                        <span>
                          Restant :{" "}
                          {health.lovable.limit && health.lovable.remaining !== null
                            ? `${((health.lovable.remaining / health.lovable.limit) * 100).toFixed(2)}% (${health.lovable.remaining.toLocaleString("fr-FR")} / ${health.lovable.limit.toLocaleString("fr-FR")})`
                            : `${health.lovable.remainingPercent}%`}
                        </span>
                      </div>
                      <div className="text-[10px] text-emerald-400/80">
                        ● En temps réel — mis à jour toutes les 5 s
                        {health.checkedAt
                          ? ` (${new Date(health.checkedAt).toLocaleTimeString("fr-FR")})`
                          : ""}
                      </div>
                    </div>
                  )}
              </div>
              <div className="rounded-lg bg-black/40 border border-white/5 p-3">
                <div className="text-xs text-muted-foreground mb-1">Clés Gemini</div>
                <div
                  className={`font-medium ${
                    health.gemini.status === "ok"
                      ? "text-emerald-400"
                      : health.gemini.status === "low"
                        ? "text-amber-400"
                        : "text-red-400"
                  }`}
                >
                  {health.gemini.active} opérationnelle(s) / {health.gemini.total}
                  {health.gemini.paused > 0 ? ` (${health.gemini.paused} en pause)` : ""}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Seuil d'alerte : moins de {health.threshold + 1} clé(s) opérationnelle(s)
                </div>
              </div>
            </div>

            {health.alert && health.alertMessage && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-amber-300 text-xs font-medium">{health.alertMessage}</p>
                </div>
                {health.suggestion && (
                  <div className="flex items-start gap-2">
                    <LifeBuoy className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-muted-foreground">
                      <span className="text-emerald-400 font-medium">Suggestion : </span>
                      {health.suggestion}
                    </p>
                  </div>
                )}
                {health.backupKeyLabel && (
                  <p className="text-[11px] text-muted-foreground pl-6">
                    Clé de secours recommandée :{" "}
                    <span className="font-medium text-foreground">« {health.backupKeyLabel} »</span>
                  </p>
                )}
              </div>
            )}

            {!health.alert && (
              <p className="text-xs text-emerald-400/80">
                Tout est en ordre : Lovable AI et vos clés Gemini peuvent répondre aux clients.
              </p>
            )}

            <p className="text-[10px] text-muted-foreground">
              Dernière vérification : {new Date(health.checkedAt).toLocaleTimeString("fr-FR")} —
              actualisation automatique toutes les 60 s.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Vérification des quotas en cours…</p>
        )}
      </Card>

      {/* Supabase OAuth Integration */}
      <Card className="glass p-6 space-y-4 border-emerald-500/20">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">Base de Données Supabase (OAuth)</h2>
                {sbStatus.isConnected && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" /> Connecté
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Connexion directe à votre organisation Supabase pour synchroniser la base de données
                et le stockage.
              </p>
            </div>
          </div>

          <div>
            {sbStatus.isConnected ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={connectSupabase}
                  disabled={sbConnecting}
                  className="text-xs"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 mr-1.5 ${sbConnecting ? "animate-spin" : ""}`}
                  />
                  Resynchroniser
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDisconnectSupabase}
                  className="text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
                >
                  Déconnecter
                </Button>
              </div>
            ) : (
              <Button
                onClick={connectSupabase}
                disabled={sbConnecting}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow-lg shadow-emerald-950/40"
              >
                {sbConnecting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M21.362 9.354H12V.343a.343.343 0 0 0-.583-.244L.367 11.15a.343.343 0 0 0 .243.585h9.39v9.011a.343.343 0 0 0 .584.244l11.05-11.051a.343.343 0 0 0-.272-.585z" />
                  </svg>
                )}
                Connecter avec Supabase
              </Button>
            )}
          </div>
        </div>

        {/* Redirect URI helper for Supabase Dashboard */}
        <div className="rounded-lg bg-black/40 border border-emerald-500/20 p-3 text-xs space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-emerald-400">
              🔗 Redirect URLs à coller dans votre Supabase Dashboard (OAuth Apps) :
            </span>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 bg-black/60 p-2 rounded">
              <code className="text-emerald-300 font-mono text-[11px] truncate">
                https://ai-service-client-facebook.lovable.app/api/public/supabase/callback
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-[10px] shrink-0 border-emerald-500/30 hover:bg-emerald-500/10"
                onClick={() => {
                  navigator.clipboard.writeText(
                    "https://ai-service-client-facebook.lovable.app/api/public/supabase/callback",
                  );
                  toast.success("Lien production copié !");
                }}
              >
                Copier production
              </Button>
            </div>

            {typeof window !== "undefined" && !window.location.origin.includes("vercel.app") && (
              <div className="flex items-center justify-between gap-2 bg-black/60 p-2 rounded">
                <code className="text-emerald-300 font-mono text-[11px] truncate">
                  {`${window.location.origin}/api/public/supabase/callback`}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 text-[10px] shrink-0 border-emerald-500/30 hover:bg-emerald-500/10"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `${window.location.origin}/api/public/supabase/callback`,
                    );
                    toast.success("Lien actuel copié !");
                  }}
                >
                  Copier actuel
                </Button>
              </div>
            )}
          </div>
        </div>

        {sbStatus.isConnected && (
          <div className="space-y-4 pt-2 border-t border-border/50">
            {sbStatus.projects.length > 0 && (
              <div>
                <Label className="text-xs text-muted-foreground uppercase font-semibold">
                  Projet actif lié à votre compte
                </Label>
                <div className="mt-1.5 flex gap-2">
                  <Select
                    value={sbStatus.selectedProjectId || ""}
                    onValueChange={(val) => handleSelectProject(val)}
                    disabled={sbSelecting}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Sélectionner un projet Supabase" />
                    </SelectTrigger>
                    <SelectContent>
                      {sbStatus.projects.map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} ({p.id}) {p.region ? `— ${p.region}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2 text-xs bg-muted/40 p-3 rounded-lg border border-border/40">
              <div>
                <span className="text-muted-foreground block">URL du Projet :</span>
                <span className="font-mono text-foreground font-medium break-all">
                  {sbStatus.selectedProjectUrl || "Non configuré"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block">Organisation(s) liée(s) :</span>
                <span className="text-foreground font-medium">
                  {sbStatus.organizations.length > 0
                    ? sbStatus.organizations.map((o: any) => o.name).join(", ")
                    : "Organisation Supabase"}
                </span>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card className="glass p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Facebook className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Identifiants Facebook Developer</h2>
            <p className="text-xs text-muted-foreground">
              Vous pouvez remplacer l'App ID à tout moment. Ces valeurs sont utilisées pour la
              connexion des pages et le webhook.
            </p>
          </div>
        </div>

        <div>
          <Label>Facebook App ID</Label>
          <Input
            placeholder="1234567890123456"
            value={form.facebook_app_id}
            onChange={(e) => setForm({ ...form, facebook_app_id: e.target.value })}
          />
        </div>

        <div>
          <Label>Facebook App Secret</Label>
          <Input
            type="password"
            placeholder="••••••••••••"
            value={form.facebook_app_secret}
            onChange={(e) => setForm({ ...form, facebook_app_secret: e.target.value })}
          />
        </div>

        <div>
          <Label>Verify Token (Webhook)</Label>
          <Input
            placeholder="mon-verify-token"
            value={form.facebook_verify_token}
            onChange={(e) => setForm({ ...form, facebook_verify_token: e.target.value })}
          />
        </div>

        <Button onClick={save} variant="secondary">
          <KeyRound className="h-4 w-4 mr-2" />
          Enregistrer les identifiants Facebook
        </Button>
      </Card>

      <Card className="glass p-6 space-y-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-amber-500 animate-pulse" />
              <h2 className="text-lg font-semibold">Automatisation & Cron IA (Arrière-plan)</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Les webhooks répondent en temps réel aux messages et commentaires. Un contrôle de
              secours automatique s'exécute chaque minute pour récupérer les événements manqués.
            </p>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/30 rounded-full text-emerald-600 text-xs font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Temps réel + secours 1 min</span>
          </div>
        </div>

        <div className="bg-background/60 rounded-lg p-4 border space-y-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Endpoints Cron Publics (Pour Crons externes / Vercel Cron / pg_cron)
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 p-2 bg-muted/40 rounded border text-xs">
              <span className="font-mono truncate text-muted-foreground">
                {typeof window !== "undefined"
                  ? `${window.location.origin}/api/public/hooks/cron`
                  : "/api/public/hooks/cron"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs shrink-0"
                onClick={() =>
                  copyToClipboard(
                    `${window.location.origin}/api/public/hooks/cron`,
                    "URL Cron Global",
                  )
                }
              >
                <Copy className="h-3.5 w-3.5 mr-1" />
                Copier
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2 p-2 bg-muted/40 rounded border text-xs">
              <span className="font-mono truncate text-muted-foreground">
                {typeof window !== "undefined"
                  ? `${window.location.origin}/api/public/hooks/reply-all-messages`
                  : "/api/public/hooks/reply-all-messages"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs shrink-0"
                onClick={() =>
                  copyToClipboard(
                    `${window.location.origin}/api/public/hooks/reply-all-messages`,
                    "URL Cron Messages",
                  )
                }
              >
                <Copy className="h-3.5 w-3.5 mr-1" />
                Copier
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            💡 Vous pouvez utiliser gratuitement un service comme{" "}
            <a
              href="https://cron-job.org"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              cron-job.org
            </a>{" "}
            ou{" "}
            <a
              href="https://uptimerobot.com"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              UptimeRobot
            </a>{" "}
            pour appeler cette URL toutes les minutes si vous souhaitez une redondance externe 24/7.
          </p>
        </div>

        <div className="pt-2 border-t space-y-3">
          <h3 className="text-sm font-semibold">Déclencheurs Manuels Immédiats</h3>
          <div className="flex flex-wrap gap-3">
            <Button onClick={replyAll} disabled={replying} variant="secondary">
              {replying ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2 text-primary" />
              )}
              {replying ? "Réponses en cours…" : "Répondre à tous les messages privés"}
            </Button>

            <Button onClick={scanComments} disabled={scanningComments} variant="outline">
              {scanningComments ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <MessageSquare className="h-4 w-4 mr-2 text-emerald-500" />
              )}
              {scanningComments ? "Scan en cours…" : "Scanner & répondre aux commentaires"}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="glass p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/15 text-primary flex items-center justify-center">
              <ExternalLink className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Créer votre site Web gratuit</h2>
              <p className="text-xs text-muted-foreground">
                Lancez votre propre site Web gratuitement en quelques minutes.
              </p>
            </div>
          </div>
          <Button asChild>
            <a href="https://supersite-mg.lovable.app" target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4 mr-2" />
              Créer votre site Web gratuit
            </a>
          </Button>
        </div>
      </Card>

      <PushNotificationsCard />
    </div>
  );
}
