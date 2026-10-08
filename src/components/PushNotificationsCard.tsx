import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bell, BellRing, Loader2, MessageCircle, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { enablePush, listenForegroundPush } from "@/lib/push-client";
import {
  getPushState,
  savePushToken,
  setAutoAiPush,
  removePushDevice,
  sendTestPush,
} from "@/lib/push.functions";
import { useHasSession } from "@/hooks/useHasSession";

const WHATSAPP_LINK =
  "https://wa.me/261323911654?text=" +
  encodeURIComponent(
    "Bonjour, je souhaite installer NEXORA (IA) sur ma page Facebook et WhatsApp.",
  );

export function PushNotificationsCard() {
  const qc = useQueryClient();
  const [activating, setActivating] = useState(false);

  const hasSession = useHasSession();

  const state = useQuery({
    queryKey: ["push-state"],
    queryFn: () => getPushState(),
    staleTime: 15_000,
    enabled: hasSession,
    retry: false,
  });

  useEffect(() => {
    listenForegroundPush().catch(() => {});
  }, []);

  const autoMutation = useMutation({
    mutationFn: (enabled: boolean) => setAutoAiPush({ data: { enabled } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["push-state"] });
      toast.success("Préférence enregistrée");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removePushDevice({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["push-state"] });
      toast.success("Appareil retiré");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const testMutation = useMutation({
    mutationFn: () => sendTestPush(),
    onSuccess: (r) => toast.success(`Notification test envoyée (${r.sent} appareil(s))`),
    onError: (e: Error) => toast.error(e.message),
  });

  async function activate() {
    setActivating(true);
    try {
      const res = await enablePush();
      if (res.status === "registered") {
        await savePushToken({ data: { token: res.token, user_agent: navigator.userAgent } });
        qc.invalidateQueries({ queryKey: ["push-state"] });
        toast.success("Notifications activées sur cet appareil");
      } else if (res.status === "open-in-new-tab") {
        toast.error("Ouvrez l'application dans un onglet séparé pour autoriser les notifications.");
      } else if (res.status === "denied") {
        toast.error("Autorisation refusée. Activez les notifications dans votre navigateur.");
      } else if (res.status === "unsupported") {
        toast.error("Ce navigateur ne prend pas en charge les notifications push.");
      } else {
        toast.error("Notifications non configurées.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur d'activation");
    } finally {
      setActivating(false);
    }
  }

  const devices = state.data?.devices ?? [];

  return (
    <Card className="glass p-6 space-y-5">
      <div className="flex items-center gap-3">
        <img
          src="/notification-logo.png"
          alt="Logo NEXORA"
          loading="lazy"
          width={40}
          height={40}
          className="h-10 w-10 rounded-xl"
        />
        <div>
          <h2 className="text-lg font-semibold">Notifications push</h2>
          <p className="text-xs text-muted-foreground">
            Alertes dans la barre de notification, avec le logo NEXORA.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button onClick={activate} disabled={activating}>
          {activating ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <BellRing className="h-4 w-4 mr-2" />
          )}
          Activer sur cet appareil
        </Button>
        <Button
          variant="secondary"
          onClick={() => testMutation.mutate()}
          disabled={testMutation.isPending || devices.length === 0}
        >
          {testMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Bell className="h-4 w-4 mr-2" />
          )}
          Envoyer un test IA
        </Button>
        <Button asChild variant="outline">
          <a href={WHATSAPP_LINK} target="_blank" rel="noreferrer">
            <MessageCircle className="h-4 w-4 mr-2 text-emerald-500" />
            Discuter sur WhatsApp
          </a>
        </Button>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
        <div>
          <Label className="text-sm font-medium">
            Notifications automatiques générées par l'IA
          </Label>
          <p className="text-xs text-muted-foreground">
            Deux envois par jour : 13h et 20h (heure de Madagascar). Offre d'installation de l'IA
            sur Facebook et WhatsApp à 5 000 Ar, payable après configuration, avec bouton WhatsApp
            direct.
          </p>
        </div>
        <Switch
          checked={state.data?.autoAiEnabled ?? true}
          onCheckedChange={(v) => autoMutation.mutate(v)}
          disabled={autoMutation.isPending || state.isLoading}
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          Appareils enregistrés ({devices.length})
        </p>
        {devices.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun appareil pour l'instant.</p>
        ) : (
          devices.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
            >
              <span className="text-xs truncate">{d.user_agent ?? d.token_preview}</span>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => removeMutation.mutate(d.id)}
                aria-label="Retirer l'appareil"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
