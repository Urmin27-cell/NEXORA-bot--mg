import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getSettings } from "@/lib/dashboard.functions";
import { listOrders, updateOrderStatus, deleteOrder } from "@/lib/orders.functions";
import { ClipboardList, Check, X, Trash2, Package } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/orders")({
  component: OrdersPage,
});

const STATUS_LABELS: Record<string, string> = {
  pending: "En attente",
  awaiting_payment: "Attente paiement",
  payment_sent: "Paiement envoyé",
  accepted: "Accepté",
  refused: "Refusé",
  delivered: "Livré",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-warning/20 text-warning",
  awaiting_payment: "bg-warning/20 text-warning",
  payment_sent: "bg-primary/20 text-primary",
  accepted: "bg-accent/20 text-accent",
  refused: "bg-destructive/20 text-destructive",
  delivered: "bg-accent/20 text-accent",
};

function OrdersPage() {
  const [activeTab, setActiveTab] = useState<"all" | "sales" | "training">("all");

  const qc = useQueryClient();
  const { data: orders = [], isLoading } = useQuery({
    queryKey: ["orders", activeTab],
    queryFn: async () => {
      try {
        return await listOrders({ data: { type: activeTab } });
      } catch (e) {
        console.warn("Orders query error", e);
        return [];
      }
    },
  });

  const setStatus = async (id: string, status: any) => {
    try {
      const res: any = await updateOrderStatus({ data: { id, status } });
      toast.success(
        res?.notified ? "Statut mis à jour — confirmation envoyée au client" : "Statut mis à jour",
      );
      qc.invalidateQueries({ queryKey: ["orders"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Supprimer cette commande ?")) return;
    await deleteOrder({ data: { id } });
    qc.invalidateQueries({ queryKey: ["orders"] });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold gradient-text flex items-center gap-2">
            <ClipboardList className="h-8 w-8" /> Commandes
          </h1>
          <p className="text-muted-foreground mt-1">
            Vérifiez et validez toutes les commandes créées automatiquement par l'IA.
          </p>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-2 bg-muted/40 p-1 rounded-lg border border-border/50">
          <Button
            size="sm"
            variant={activeTab === "all" ? "default" : "ghost"}
            onClick={() => setActiveTab("all")}
          >
            Toutes
          </Button>
          <Button
            size="sm"
            variant={activeTab === "sales" ? "default" : "ghost"}
            onClick={() => setActiveTab("sales")}
          >
            Ventes (Produits)
          </Button>
          <Button
            size="sm"
            variant={activeTab === "training" ? "default" : "ghost"}
            onClick={() => setActiveTab("training")}
          >
            Formations
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {orders.map((o: any) => {
          const itemTitle =
            o.products?.name ??
            o.trainings?.name ??
            (o.notes && o.notes.startsWith("Article:")
              ? o.notes.replace("Article:", "").trim()
              : null) ??
            "Commande produit";

          return (
            <Card key={o.id} className="glass p-5 space-y-3">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Package className="h-4 w-4 text-primary" />
                    <span className="font-semibold text-lg">{itemTitle}</span>
                    {o.quantity > 1 && (
                      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-muted">
                        ×{o.quantity}
                      </span>
                    )}
                    <Badge className={STATUS_COLORS[o.status] || "bg-muted text-foreground"}>
                      {STATUS_LABELS[o.status] || o.status}
                    </Badge>
                    <Badge variant="outline" className="text-xs uppercase">
                      {o.type === "training" ? "Formation" : "Vente"}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Créée le {new Date(o.created_at).toLocaleString()}
                  </div>
                </div>

                <div className="flex gap-1">
                  {o.status !== "accepted" && o.status !== "delivered" && (
                    <Button size="sm" variant="default" onClick={() => setStatus(o.id, "accepted")}>
                      <Check className="h-4 w-4 mr-1" />
                      Accepter
                    </Button>
                  )}
                  {o.status !== "refused" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setStatus(o.id, "refused")}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Refuser
                    </Button>
                  )}
                  {o.status === "accepted" && (
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => setStatus(o.id, "delivered")}
                    >
                      Marquer livré
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" onClick={() => remove(o.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-2 text-sm bg-muted/40 rounded-lg p-3.5 border border-border/30">
                <div>
                  <span className="text-muted-foreground font-medium">
                    Nom Mpanjifa (Facebook) :
                  </span>{" "}
                  <span className="font-semibold text-foreground">
                    {o.client_fb_name || "Mpanjifa Messenger"}
                  </span>
                </div>

                {(o.client_phone || o.client_whatsapp) && (
                  <div>
                    <span className="text-muted-foreground font-medium">
                      Laharana Finday / Phone :
                    </span>{" "}
                    <span className="font-semibold text-primary">
                      {o.client_phone || o.client_whatsapp}
                    </span>
                  </div>
                )}

                {o.client_whatsapp && o.client_whatsapp !== o.client_phone && (
                  <div>
                    <span className="text-muted-foreground font-medium">WhatsApp :</span>{" "}
                    <span className="font-semibold">{o.client_whatsapp}</span>
                  </div>
                )}

                {o.client_address && (
                  <div className="col-span-full">
                    <span className="text-muted-foreground font-medium">
                      Adiresy Mazava / Adresse :
                    </span>{" "}
                    <span className="font-medium text-foreground bg-background/60 px-2 py-0.5 rounded">
                      {o.client_address}
                    </span>
                  </div>
                )}

                {(o as any).prompt_files?.label && (
                  <div>
                    <span className="text-muted-foreground font-medium">Fichier payant :</span>{" "}
                    <span className="font-medium">
                      {(o as any).prompt_files.label}
                      {(o as any).prompt_files.price
                        ? ` — ${Number((o as any).prompt_files.price).toLocaleString("fr-FR")} Ar`
                        : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {(o as any).file_delivered_at
                        ? " · ✅ efa nalefa"
                        : " · halefa ho azy rehefa ekena"}
                    </span>
                  </div>
                )}

                {o.payment_reference && (
                  <div>
                    <span className="text-muted-foreground font-medium">Réf. Paiement :</span>{" "}
                    <span className="font-mono text-xs bg-primary/10 px-2 py-0.5 rounded text-primary">
                      {o.payment_reference}
                    </span>
                  </div>
                )}

                {(() => {
                  const extra = String(o.notes ?? "")
                    .split("|")
                    .map((s: string) => s.trim())
                    .filter((s: string) => s && !s.startsWith("Article:"))
                    .join(" | ");
                  if (!extra) return null;
                  return (
                    <div className="col-span-full">
                      <span className="text-muted-foreground font-medium">
                        Notes / Tsindrim-peo :
                      </span>{" "}
                      <span>{extra}</span>
                    </div>
                  );
                })()}
              </div>
            </Card>
          );
        })}

        {orders.length === 0 && !isLoading && (
          <Card className="glass p-8 text-center text-muted-foreground">
            Mbola tsy misy commande voaray (Aucune commande pour le moment).
          </Card>
        )}
      </div>
    </div>
  );
}
