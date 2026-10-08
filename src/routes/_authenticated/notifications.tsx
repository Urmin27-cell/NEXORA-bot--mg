import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listNotificationRecipients,
  saveNotificationRecipient,
  toggleNotificationRecipient,
  deleteNotificationRecipient,
  testNotificationRecipient,
} from "@/lib/client-notify.functions";
import { BellRing, Plus, Trash2, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications clients — ID Messenger | Nexora" },
      {
        name: "description",
        content:
          "Enregistrez et activez les ID Messenger des clients qui reçoivent les alertes quota et commandes.",
      },
      { property: "og:title", content: "Notifications clients — ID Messenger | Nexora" },
      {
        property: "og:description",
        content:
          "Gestion ciblée des destinataires Messenger : alertes de quota Gemini et détails de commande.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: NotificationsPage,
});

type Row = {
  id: string;
  page_id: string;
  recipient_psid: string;
  label: string | null;
  is_active: boolean;
  notify_quota: boolean;
  notify_orders: boolean;
  created_at: string;
};

const EMPTY = {
  page_id: "",
  recipient_psid: "",
  label: "",
  notify_quota: true,
  notify_orders: true,
};

function NotificationsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["notification-recipients"],
    queryFn: () => listNotificationRecipients(),
  });

  const rows = (data?.rows ?? []) as Row[];
  const pages = data?.pages ?? [];

  const refresh = () => qc.invalidateQueries({ queryKey: ["notification-recipients"] });

  const add = async () => {
    if (!form.page_id) return toast.error("Safidio ny Page Facebook");
    if (form.recipient_psid.trim().length < 3) return toast.error("Ampidiro ny ID / PSID");
    setSaving(true);
    try {
      await saveNotificationRecipient({
        data: {
          page_id: form.page_id,
          recipient_psid: form.recipient_psid.trim(),
          label: form.label.trim(),
          is_active: true,
          notify_quota: form.notify_quota,
          notify_orders: form.notify_orders,
        },
      });
      toast.success("Voatahiry ny ID client");
      setForm({ ...EMPTY });
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Tsy voatahiry");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (
    row: Row,
    key: "is_active" | "notify_quota" | "notify_orders",
    v: boolean,
  ) => {
    try {
      if (key === "is_active") {
        await toggleNotificationRecipient({ data: { id: row.id, is_active: v } });
      } else {
        await saveNotificationRecipient({
          data: {
            id: row.id,
            page_id: row.page_id,
            recipient_psid: row.recipient_psid,
            label: row.label ?? "",
            is_active: row.is_active,
            notify_quota: key === "notify_quota" ? v : row.notify_quota,
            notify_orders: key === "notify_orders" ? v : row.notify_orders,
          },
        });
      }
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Erreur");
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteNotificationRecipient({ data: { id } });
      toast.success("Voafafa");
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Erreur");
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    try {
      const res = await testNotificationRecipient({ data: { id } });
      if (res.sent) toast.success("Lasa ny hafatra fitsapana");
      else toast.error(res.error ?? "Tsy lasa");
    } catch (e: any) {
      toast.error(e?.message ?? "Erreur");
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BellRing className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">Notifications clients</h1>
          <p className="text-sm text-muted-foreground">
            Ireo ID Messenger voasoratra sy activé ihany no mandray ny fampandrenesana.
          </p>
        </div>
      </div>

      <Card className="p-5 space-y-4">
        <h2 className="font-medium">Ampidiro ID client vaovao</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label>Page Facebook</Label>
            <Select
              value={form.page_id}
              onValueChange={(v) => setForm((f) => ({ ...f, page_id: v }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Safidio ny Page" />
              </SelectTrigger>
              <SelectContent>
                {pages.map((p) => (
                  <SelectItem key={p.page_id} value={p.page_id}>
                    {p.page_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>ID / PSID client</Label>
            <Input
              value={form.recipient_psid}
              onChange={(e) => setForm((f) => ({ ...f, recipient_psid: e.target.value }))}
              placeholder="Ex. 7412589630145"
            />
          </div>
          <div className="space-y-2">
            <Label>Anarana (facultatif)</Label>
            <Input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="Ex. Responsable vente"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={form.notify_quota}
              onCheckedChange={(v) => setForm((f) => ({ ...f, notify_quota: v }))}
            />
            Alerte quota lany
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={form.notify_orders}
              onCheckedChange={(v) => setForm((f) => ({ ...f, notify_orders: v }))}
            />
            Alerte commande
          </label>
          <Button onClick={add} disabled={saving} className="ml-auto">
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            Ampidiro
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Ny ID / PSID dia hita ao amin'ny resaka Messenger efa nisy tamin'ilay olona (pejy
          Messages).
        </p>
      </Card>

      <Card className="p-5 space-y-4">
        <h2 className="font-medium">Lisitry ny destinataires</h2>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Eo am-pakàna…
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Mbola tsy misy ID voasoratra.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => {
              const page = pages.find((p) => p.page_id === row.page_id);
              return (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center gap-4 rounded-lg border p-4"
                >
                  <div className="min-w-[200px] flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.label || "Sans nom"}</span>
                      <Badge variant={row.is_active ? "default" : "secondary"}>
                        {row.is_active ? "Actif" : "Inactif"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {row.recipient_psid} · {page?.page_name ?? row.page_id}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={row.notify_quota}
                      onCheckedChange={(v) => toggle(row, "notify_quota", v)}
                    />
                    Quota
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={row.notify_orders}
                      onCheckedChange={(v) => toggle(row, "notify_orders", v)}
                    />
                    Commandes
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={row.is_active}
                      onCheckedChange={(v) => toggle(row, "is_active", v)}
                    />
                    Activation
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => test(row.id)}
                    disabled={testing === row.id}
                  >
                    {testing === row.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="mr-2 h-4 w-4" />
                    )}
                    Tester
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(row.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
