import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  listPrompts,
  upsertPrompt,
  deletePrompt,
  listFacebookPages,
} from "@/lib/dashboard.functions";
import {
  listPromptFiles,
  uploadPromptFile,
  deletePromptFile,
  updatePromptFileSale,
} from "@/lib/prompt-files.functions";
import {
  Plus,
  Pencil,
  Trash2,
  Sparkles,
  Paperclip,
  FileText,
  ImageIcon,
  Music,
  Video,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

const promptsQuery = queryOptions({
  queryKey: ["prompts"],
  queryFn: async () => {
    try {
      return await listPrompts();
    } catch (e) {
      console.warn("Prompts query error", e);
      return [];
    }
  },
});
const pagesQuery = queryOptions({
  queryKey: ["fb-pages"],
  queryFn: async () => {
    try {
      return await listFacebookPages();
    } catch (e) {
      console.warn("Pages query error", e);
      return [];
    }
  },
});
const promptFilesQuery = queryOptions({
  queryKey: ["prompt-files"],
  queryFn: async () => {
    try {
      return await listPromptFiles();
    } catch (e) {
      console.warn("Prompt files query error", e);
      return [];
    }
  },
});

export const Route = createFileRoute("/_authenticated/prompts")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(promptsQuery),
      context.queryClient.ensureQueryData(pagesQuery),
      context.queryClient.ensureQueryData(promptFilesQuery),
    ]),
  component: PromptsPage,
});

const FILE_ICONS: Record<string, typeof FileText> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  file: FileText,
};

const ACCEPTED_FILES = "application/pdf,image/*,audio/*,video/*";

function FileSaleControls({ file }: { file: any }) {
  const qc = useQueryClient();
  const [forSale, setForSale] = useState<boolean>(!!file.is_for_sale);
  const [price, setPrice] = useState<string>(file.price != null ? String(file.price) : "");
  const [saving, setSaving] = useState(false);

  const save = async (nextForSale: boolean, nextPrice: string) => {
    const p = nextPrice.trim() === "" ? null : Number(nextPrice);
    if (nextForSale && (p == null || isNaN(p) || p <= 0)) {
      toast.error("Ampidiro ny vidin'ilay fichier");
      return;
    }
    setSaving(true);
    try {
      await updatePromptFileSale({ data: { id: file.id, is_for_sale: nextForSale, price: p } });
      toast.success(nextForSale ? "Fichier amidy (paiement requis)" : "Fichier maimaimpoana");
      qc.invalidateQueries({ queryKey: ["prompt-files"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 pl-7">
      <div className="flex items-center gap-2">
        <Switch
          checked={forSale}
          disabled={saving}
          onCheckedChange={(v) => {
            setForSale(v);
            if (!v) save(false, "");
          }}
        />
        <span className="text-xs">
          {forSale ? "Amidy — paiement requis" : "Tsy amidy (maimaimpoana)"}
        </span>
      </div>
      {forSale && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            placeholder="Vidiny (Ar)"
            className="h-8 w-32"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <Button size="sm" variant="secondary" disabled={saving} onClick={() => save(true, price)}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enregistrer"}
          </Button>
        </div>
      )}
    </div>
  );
}

function PromptFilesSection({ promptId }: { promptId?: string | null }) {
  const { data: files } = useSuspenseQuery(promptFilesQuery);
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);

  const visible = promptId ? (files as any[]).filter((f) => f.prompt_id === promptId) : [];

  if (!promptId) {
    return (
      <div className="rounded-md border border-input p-3">
        <Label className="flex items-center gap-2">
          <Paperclip className="h-4 w-4" />
          Fichiers envoyables par l'IA
        </Label>
        <p className="text-xs text-muted-foreground mt-2">
          Enregistrez d'abord ce prompt, puis rouvrez-le pour y ajouter des fichiers (ils seront
          liés uniquement à ce prompt).
        </p>
      </div>
    );
  }

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        if (file.size > 50 * 1024 * 1024) {
          toast.error(`${file.name} : trop volumineux (max 50 Mo)`);
          continue;
        }
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        await uploadPromptFile({
          data: {
            prompt_id: promptId ?? null,
            label: file.name.replace(/\.[^.]+$/, ""),
            filename: file.name,
            mime_type: file.type || "application/octet-stream",
            data_base64: btoa(binary),
          },
        });
      }
      toast.success("Fichier(s) ajouté(s)");
      qc.invalidateQueries({ queryKey: ["prompt-files"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur d'envoi du fichier");
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Supprimer ce fichier ?")) return;
    try {
      await deletePromptFile({ data: { id } });
      toast.success("Fichier supprimé");
      qc.invalidateQueries({ queryKey: ["prompt-files"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  };

  return (
    <div className="rounded-md border border-input p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-2">
          <Paperclip className="h-4 w-4" />
          Fichiers envoyables par l'IA (PDF, image, audio, vidéo)
        </Label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={uploading}
          onClick={() => document.getElementById("prompt-file-input")?.click()}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Plus className="h-4 w-4 mr-2" />
          )}
          Ajouter
        </Button>
        <input
          id="prompt-file-input"
          type="file"
          multiple
          accept={ACCEPTED_FILES}
          className="hidden"
          onChange={(e) => {
            handleUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Aucun fichier. Ajoutez un PDF, une image, un audio ou une vidéo : l'IA l'enverra
          directement en message privé quand un client le demande.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {visible.map((f) => {
            const Icon = FILE_ICONS[f.media_type] ?? FileText;
            return (
              <div key={f.id} className="py-2 space-y-2">
                <div className="flex items-center gap-3">
                  <Icon className="h-4 w-4 text-primary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">{f.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {f.mime_type}
                      {f.size_bytes ? ` · ${Math.round(Number(f.size_bytes) / 1024)} Ko` : ""}
                    </p>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => remove(f.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
                <FileSaleControls file={f} />
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        L'IA utilise le nom du fichier pour savoir quoi envoyer. Exemple : « Catalogue 2026 ».
      </p>
    </div>
  );
}

type PromptRow = Omit<Awaited<ReturnType<typeof listPrompts>>[number], "assistance_type"> & {
  page_id?: string | null;
  page_ids?: string[] | null;
  assistance_type?: string | null;
};

const CATEGORY_LABELS: Record<string, string> = {
  global: "Global",
  message: "Messages privés",
  comment: "Commentaires",
  md: "Messages directs (MD)",
  tutorial: "Tutoriels",
};

const TYPE_LABELS: Record<string, string> = {
  online_work: "Travail en ligne",
  training: "Formation",
  sales: "Vente",
};

const ALL_TYPES = "__all__";

function PromptsPage() {
  const { data } = useSuspenseQuery(promptsQuery);
  const { data: pages } = useSuspenseQuery(pagesQuery);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PromptRow | null>(null);
  const [form, setForm] = useState({
    name: "",
    content: "",
    category: "global",
    is_active: true,
    page_ids: [] as string[],
    assistance_type: ALL_TYPES as string,
  });

  const openNew = () => {
    setEditing(null);
    setForm({
      name: "",
      content: "",
      category: "global",
      is_active: true,
      page_ids: [],
      assistance_type: ALL_TYPES,
    });
    setOpen(true);
  };
  const openEdit = (p: PromptRow) => {
    setEditing(p);
    setForm({
      name: p.name,
      content: p.content,
      category: p.category,
      is_active: p.is_active,
      page_ids: p.page_ids?.length ? p.page_ids : p.page_id ? [p.page_id] : [],
      assistance_type: p.assistance_type ?? ALL_TYPES,
    });
    setOpen(true);
  };
  const togglePage = (pid: string) =>
    setForm((f) => ({
      ...f,
      page_ids: f.page_ids.includes(pid)
        ? f.page_ids.filter((x) => x !== pid)
        : [...f.page_ids, pid],
    }));
  const save = async () => {
    if (form.page_ids.length === 0) {
      toast.error("Choisissez au moins une page Facebook");
      return;
    }
    const categoryLabel = CATEGORY_LABELS[form.category] || form.category;
    const finalName = form.name.trim() || `Prompt ${categoryLabel}`;
    try {
      await upsertPrompt({
        data: {
          id: editing?.id,
          name: finalName,
          content: form.content,
          category: form.category as PromptRow["category"],
          is_active: form.is_active,
          page_ids: form.page_ids,
          assistance_type:
            form.assistance_type === ALL_TYPES
              ? null
              : (form.assistance_type as "online_work" | "training" | "sales"),
        },
      });
      toast.success("Prompt enregistré");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["prompts"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  };
  const remove = async (id: string) => {
    if (!confirm("Supprimer ce prompt ?")) return;
    await deletePrompt({ data: { id } });
    toast.success("Supprimé");
    qc.invalidateQueries({ queryKey: ["prompts"] });
  };

  const pageNames = (p: PromptRow) => {
    const ids = p.page_ids?.length ? p.page_ids : p.page_id ? [p.page_id] : [];
    if (ids.length === 0) return ["Aucune page"];
    return ids.map((pid) => pages.find((x) => x.page_id === pid)?.page_name ?? pid);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold gradient-text">Prompts IA</h1>
          <p className="text-muted-foreground mt-1">
            Instructions envoyées à l'IA. Une page sans prompt attribué ne recevra pas de réponse
            automatique.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4 mr-2" />
              Nouveau prompt
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing ? "Modifier le prompt" : "Nouveau prompt"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Nom</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex : Ton de la marque"
                />
              </div>
              <div>
                <Label>Catégorie</Label>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm({ ...form, category: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label>Pages Facebook (sélection multiple)</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setForm({ ...form, page_ids: pages.map((p) => p.page_id) })}
                    >
                      Tout cocher
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setForm({ ...form, page_ids: [] })}
                    >
                      Tout décocher
                    </Button>
                  </div>
                </div>
                <div className="mt-2 max-h-52 overflow-y-auto rounded-md border border-input divide-y divide-border">
                  {pages.length === 0 && (
                    <p className="p-3 text-sm text-muted-foreground">Aucune page connectée.</p>
                  )}
                  {pages.map((p) => (
                    <label
                      key={p.id}
                      className="flex items-center gap-3 p-2 text-sm cursor-pointer hover:bg-accent"
                    >
                      <Checkbox
                        checked={form.page_ids.includes(p.page_id)}
                        onCheckedChange={() => togglePage(p.page_id)}
                      />
                      <span>{p.page_name ?? p.page_id}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Ce prompt ne s'appliquera qu'aux pages cochées. Une page sans prompt n'aura pas de
                  réponse IA.
                </p>
              </div>
              <div>
                <Label>Type d'assistance</Label>
                <Select
                  value={form.assistance_type}
                  onValueChange={(v) => setForm({ ...form, assistance_type: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_TYPES}>Tous les types</SelectItem>
                    {Object.entries(TYPE_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Contenu</Label>
                <Textarea
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  rows={10}
                  placeholder="Vous êtes une assistante virtuelle sympathique qui répond en malgache..."
                />
              </div>
              <PromptFilesSection promptId={editing?.id ?? null} />
              <div className="flex items-center gap-3">
                <Switch
                  checked={form.is_active}
                  onCheckedChange={(v) => setForm({ ...form, is_active: v })}
                />
                <Label>Actif</Label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Annuler
              </Button>
              <Button onClick={save}>Enregistrer</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {data.length === 0 ? (
        <Card className="glass p-12 text-center">
          <Sparkles className="h-10 w-10 text-primary mx-auto mb-3" />
          <p className="text-muted-foreground">
            Aucun prompt encore. Créez-en un pour guider votre IA.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {(data as PromptRow[]).map((p) => (
            <Card key={p.id} className="glass p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold">{p.name}</h3>
                    <Badge variant="secondary">{CATEGORY_LABELS[p.category] ?? p.category}</Badge>
                    {pageNames(p).map((n) => (
                      <Badge key={n} variant="outline">
                        {n}
                      </Badge>
                    ))}
                    <Badge variant="outline">
                      {p.assistance_type
                        ? (TYPE_LABELS[p.assistance_type] ?? p.assistance_type)
                        : "Tous les types"}
                    </Badge>
                    {p.is_active ? (
                      <Badge className="bg-success text-success-foreground">Actif</Badge>
                    ) : (
                      <Badge variant="outline">Inactif</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-2 line-clamp-3 whitespace-pre-wrap">
                    {p.content}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" onClick={() => openEdit(p)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => remove(p.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
