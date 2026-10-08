import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  listKnowledge,
  updateKnowledge,
  deleteKnowledge,
  createKnowledge,
  listPendingRequests,
  importPastConversations,
  getAdminContactSetting,
  setAdminContactSetting,
  processPendingNow,
  deleteAllPending,
  getFallbackEnabled,
  setFallbackEnabled,
} from "@/lib/mini-ia.functions";
import {
  Brain,
  Plus,
  Pencil,
  Trash2,
  Search,
  BadgeCheck,
  Clock,
  Loader2,
  DownloadCloud,
  PhoneCall,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/mini-ia")({
  head: () => ({
    meta: [
      { title: "Mini IA — Mémoire et questions clients | Nexora" },
      {
        name: "description",
        content:
          "Gérez la mémoire de la Mini IA : questions clients enregistrées, réponses vérifiées et demandes en attente.",
      },
      { property: "og:title", content: "Mini IA — Mémoire et questions clients | Nexora" },
      {
        property: "og:description",
        content:
          "Consultez les questions mémorisées, corrigez les réponses et validez la connaissance de la Mini IA.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MiniIaPage,
});

const PAGE_SIZE = 5;

type Row = {
  id: string;
  question: string;
  answer?: string;
  is_verified: boolean;
  usage_count: number;
  source: string;
  created_at: string;
};

function MiniIaPage() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ question: "", answer: "" });
  const [saving, setSaving] = useState(false);

  const limit = expanded ? 50 : PAGE_SIZE;
  const { data, isLoading } = useQuery({
    queryKey: ["mini-ia-knowledge", expanded, search],
    queryFn: () =>
      listKnowledge({
        data: { offset: 0, limit, search, withAnswer: true },
      }),
  });
  const [processingNow, setProcessingNow] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const { data: pending } = useQuery({
    queryKey: ["mini-ia-pending"],
    queryFn: () => listPendingRequests(),
  });

  const { data: contactData } = useQuery({
    queryKey: ["mini-ia-contact"],
    queryFn: () => getAdminContactSetting(),
  });
  const fallbackQ = useQuery({
    queryKey: ["mini-ia-fallback"],
    queryFn: () => getFallbackEnabled(),
  });
  const fallbackOn = fallbackQ.data?.enabled !== false;
  const [savingFallback, setSavingFallback] = useState(false);
  const toggleFallback = async () => {
    setSavingFallback(true);
    try {
      await setFallbackEnabled({ data: { enabled: !fallbackOn } });
      toast.success(!fallbackOn ? "Fallback activé" : "Fallback désactivé");
      qc.invalidateQueries({ queryKey: ["mini-ia-fallback"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setSavingFallback(false);
    }
  };
  const [contact, setContact] = useState("");
  const [contactLoaded, setContactLoaded] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  useEffect(() => {
    if (contactData && !contactLoaded) {
      setContact(contactData.admin_contact ?? "");
      setContactLoaded(true);
    }
  }, [contactData, contactLoaded]);

  const saveContact = async () => {
    setSavingContact(true);
    try {
      await setAdminContactSetting({ data: { admin_contact: contact } });
      toast.success("Contact enregistré");
      qc.invalidateQueries({ queryKey: ["mini-ia-contact"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setSavingContact(false);
    }
  };

  const rows = (data?.rows ?? []) as Row[];
  const total = data?.total ?? 0;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["mini-ia-knowledge"] });
    qc.invalidateQueries({ queryKey: ["mini-ia-pending"] });
  };

  const [importing, setImporting] = useState(false);
  const runImport = async () => {
    setImporting(true);
    try {
      const res = await importPastConversations();
      toast.success(`${res.imported} discussion(s) ajoutée(s) à la mémoire.`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import impossible");
    } finally {
      setImporting(false);
    }
  };

  const openEdit = (row: Row) => {
    setEditing(row);
    setForm({ question: row.question, answer: row.answer ?? "" });
  };

  const openCreate = () => {
    setCreating(true);
    setForm({ question: "", answer: "" });
  };

  const save = async () => {
    if (!form.question.trim() || !form.answer.trim()) {
      toast.error("Question et réponse obligatoires");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateKnowledge({
          data: { id: editing.id, question: form.question, answer: form.answer },
        });
      } else {
        await createKnowledge({
          data: { question: form.question, answer: form.answer, is_verified: true },
        });
      }
      toast.success("Enregistré");
      setEditing(null);
      setCreating(false);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setSaving(false);
    }
  };

  const toggleVerified = async (row: Row) => {
    try {
      await updateKnowledge({ data: { id: row.id, is_verified: !row.is_verified } });
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  };

  const remove = async (row: Row) => {
    if (!confirm("Supprimer cette question et sa réponse ?")) return;
    try {
      await deleteKnowledge({ data: { id: row.id } });
      toast.success("Supprimé");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Brain className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold">Mini IA</h1>
            <p className="text-sm text-muted-foreground">
              Questions et réponses mémorisées, utilisées quand l'IA principale est indisponible.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={runImport} disabled={importing}>
            {importing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <DownloadCloud className="mr-2 h-4 w-4" />
            )}
            Importer les discussions
          </Button>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> Ajouter
          </Button>
        </div>
      </div>

      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Réponse automatique de secours (Fallback)</h2>
          <p className="text-sm text-muted-foreground">
            Envoyée seulement quand le quota de toutes les IA principales est épuisé. Désactivée :
            la Mini IA n'envoie aucun message de secours.
          </p>
        </div>
        <Button
          variant={fallbackOn ? "default" : "destructive"}
          disabled={fallbackQ.isLoading || savingFallback}
          onClick={toggleFallback}
        >
          {savingFallback ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {fallbackOn ? "Activé — cliquer pour désactiver" : "Désactivé — cliquer pour activer"}
        </Button>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-primary" />
          <h2 className="font-semibold">Contact de secours (Admin)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Donné au client par la Mini IA quand elle ne trouve pas de réponse fiable : elle l'invite
          à patienter et lui propose ce contact s'il est pressé.
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-[220px] flex-1"
            placeholder="Ex. 034 00 000 00 / WhatsApp / lien Messenger"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />
          <Button onClick={saveContact} disabled={savingContact}>
            {savingContact ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Enregistrer
          </Button>
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Rechercher une question…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Aucune question enregistrée pour le moment.
          </p>
        ) : (
          <ol className="space-y-3">
            {rows.map((row, i) => (
              <li key={row.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {i + 1}. {row.question}
                    </p>
                    {expanded && row.answer ? (
                      <p className="mt-2 whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-sm">
                        <span className="font-semibold">Réponse : </span>
                        {row.answer}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant={row.is_verified ? "default" : "secondary"}>
                        {row.is_verified ? "Vérifiée" : "Non vérifiée"}
                      </Badge>
                      <Badge variant="outline">Utilisée {row.usage_count}×</Badge>
                      <Badge variant="outline">{row.source}</Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      title={row.is_verified ? "Marquer non vérifiée" : "Marquer vérifiée"}
                      onClick={() => toggleVerified(row)}
                    >
                      <BadgeCheck
                        className={`h-4 w-4 ${row.is_verified ? "text-primary" : "text-muted-foreground"}`}
                      />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => openEdit(row)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => remove(row)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}

        {!expanded && total > PAGE_SIZE ? (
          <Button variant="outline" className="w-full" onClick={() => setExpanded(true)}>
            VOIR PLUS ({total - PAGE_SIZE} autres)
          </Button>
        ) : null}
        {expanded ? (
          <Button variant="ghost" className="w-full" onClick={() => setExpanded(false)}>
            Réduire
          </Button>
        ) : null}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Clock className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-semibold">Questions en attente</h2>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            disabled={processingNow}
            onClick={async () => {
              setProcessingNow(true);
              try {
                const r = await processPendingNow();
                const parts = [`${r.messages} message(s) et ${r.comments} commentaire(s) répondus`];
                if (r.closed > 0)
                  parts.push(`${r.closed} trop ancien(s) retiré(s) (délai 24h Facebook dépassé)`);
                if (r.remaining > 0)
                  parts.push(
                    `${r.remaining} encore en attente (IA principale indisponible ou quota épuisé)`,
                  );
                toast.success(parts.join(" · "));
                qc.invalidateQueries({ queryKey: ["mini-ia-pending"] });
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Erreur");
              } finally {
                setProcessingNow(false);
              }
            }}
          >
            {processingNow ? <Loader2 className="h-4 w-4 animate-spin" /> : "Traiter maintenant"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={deletingAll || (pending ?? []).length === 0}
            onClick={async () => {
              if (!confirm("Supprimer toutes les questions en attente ?")) return;
              setDeletingAll(true);
              try {
                const r = await deleteAllPending();
                toast.success(`${r.deleted} question(s) en attente supprimée(s)`);
                qc.invalidateQueries({ queryKey: ["mini-ia-pending"] });
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Erreur");
              } finally {
                setDeletingAll(false);
              }
            }}
          >
            {deletingAll ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Trash2 className="mr-1 h-4 w-4" /> Supprimer tout
              </>
            )}
          </Button>
        </div>
        {(pending ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune question en attente.</p>
        ) : (
          <ul className="space-y-2">
            {(pending as any[]).map((p) => (
              <li key={p.id} className="rounded-md border p-2 text-sm">
                <span className="font-medium">{p.question || "(sans texte)"}</span>
                <span className="ml-2 text-muted-foreground">
                  · {p.request_type} · {new Date(p.created_at).toLocaleString("fr-FR")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog
        open={Boolean(editing) || creating}
        onOpenChange={(o) => {
          if (!o) {
            setEditing(null);
            setCreating(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Modifier" : "Ajouter"} une connaissance</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Question</Label>
              <Input
                value={form.question}
                onChange={(e) => setForm({ ...form, question: e.target.value })}
              />
            </div>
            <div>
              <Label>Réponse (3 phrases max conseillées)</Label>
              <Textarea
                rows={5}
                value={form.answer}
                onChange={(e) => setForm({ ...form, answer: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
