import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, ExternalLink, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  enablePush,
  pushPermissionStatus,
  subscribeForegroundPush,
  type ForegroundPush,
} from "@/lib/push-client";
import { getPushState, savePushToken } from "@/lib/push.functions";
import { useHasSession } from "@/hooks/useHasSession";

/**
 * Bandeau de notification en haut de l'écran + fenêtre d'activation obligatoire.
 * N'altère aucune logique existante : composant additionnel.
 */
export function PushGate() {
  const qc = useQueryClient();
  const [banner, setBanner] = useState<ForegroundPush | null>(null);
  const [activating, setActivating] = useState(false);
  const [permission, setPermission] = useState<string>("default");
  const [inIframe, setInIframe] = useState(false);
  const [dismissedOnce, setDismissedOnce] = useState(false);

  const hasSession = useHasSession();

  const state = useQuery({
    queryKey: ["push-state"],
    queryFn: () => getPushState(),
    staleTime: 15_000,
    enabled: hasSession,
    retry: false,
  });

  useEffect(() => {
    setPermission(pushPermissionStatus());
    setInIframe(typeof window !== "undefined" && window.top !== window.self);
  }, []);

  // Bandeau temps réel quand l'application est ouverte
  useEffect(() => {
    let off: (() => void) | undefined;
    subscribeForegroundPush((n) => {
      setBanner(n);
      window.setTimeout(() => setBanner(null), 9000);
    })
      .then((u) => {
        off = u;
      })
      .catch(() => {});
    return () => off?.();
  }, []);

  const activate = useCallback(async () => {
    setActivating(true);
    try {
      const res = await enablePush();
      if (res.status === "registered") {
        await savePushToken({ data: { token: res.token, user_agent: navigator.userAgent } });
        setPermission("granted");
        qc.invalidateQueries({ queryKey: ["push-state"] });
      } else if (res.status === "open-in-new-tab") {
        setInIframe(true);
      } else if (res.status === "denied") {
        setPermission(pushPermissionStatus());
      }
    } finally {
      setActivating(false);
    }
  }, [qc]);

  // Ré-enregistre le jeton en silence si l'autorisation existe déjà
  useEffect(() => {
    if (permission === "granted" && state.data && state.data.devices.length === 0 && !activating) {
      activate();
    }
  }, [permission, state.data, activate, activating]);

  const needsActivation =
    state.isSuccess && (permission !== "granted" || state.data.devices.length === 0);

  return (
    <>
      {banner && (
        <div className="fixed top-0 inset-x-0 z-[60] px-3 pt-3 pointer-events-none">
          <div className="pointer-events-auto mx-auto max-w-md rounded-2xl border border-border bg-card/95 backdrop-blur shadow-lg p-3 flex items-start gap-3 animate-in slide-in-from-top">
            <img
              src="/notification-logo.png"
              alt="NEXORA"
              width={36}
              height={36}
              className="h-9 w-9 rounded-lg"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">{banner.title}</p>
              <p className="text-xs text-muted-foreground line-clamp-3">{banner.body}</p>
              {banner.link && (
                <a
                  href={banner.link}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs text-primary"
                >
                  Ouvrir <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <button
              onClick={() => setBanner(null)}
              aria-label="Fermer la notification"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <Dialog open={Boolean(needsActivation) && !dismissedOnce}>
        <DialogContent
          className="max-w-sm [&>button]:hidden"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex flex-col items-center text-center gap-3">
            <img
              src="/notification-logo.png"
              alt="NEXORA"
              width={64}
              height={64}
              className="h-16 w-16 rounded-2xl"
            />
            <DialogTitle>Activez les notifications</DialogTitle>
            <DialogDescription>
              Recevez les alertes de NEXORA directement dans la barre de notification de votre
              téléphone, en temps réel.
            </DialogDescription>

            {inIframe ? (
              <div className="w-full space-y-2">
                <p className="text-xs text-muted-foreground">
                  Ouvrez l'application dans un onglet séparé pour autoriser les notifications.
                </p>
                <Button asChild className="w-full">
                  <a
                    href={typeof window !== "undefined" ? window.location.href : "#"}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Ouvrir dans un onglet
                  </a>
                </Button>
              </div>
            ) : permission === "denied" ? (
              <p className="text-xs text-destructive">
                Les notifications sont bloquées. Autorisez-les dans les réglages du navigateur pour
                ce site, puis rechargez la page.
              </p>
            ) : (
              <Button className="w-full" onClick={activate} disabled={activating}>
                {activating ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <BellRing className="h-4 w-4 mr-2" />
                )}
                Activer maintenant
              </Button>
            )}

            <button
              className="text-xs text-muted-foreground underline"
              onClick={() => setDismissedOnce(true)}
            >
              Plus tard
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
