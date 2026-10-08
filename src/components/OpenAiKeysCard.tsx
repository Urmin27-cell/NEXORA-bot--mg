import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Bot, Trash2, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  listOpenAiKeys,
  addOpenAiKey,
  testOpenAiKey,
  toggleOpenAiKey,
  deleteOpenAiKey,
} from "@/lib/openai-keys.functions";

export function OpenAiKeysCard() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["openai-keys"], queryFn: () => listOpenAiKeys() });
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["openai-keys"] });

  const add = async () => {
    setBusy("add");
    try {
      const r = await addOpenAiKey({ data: { label: label || "ChatGPT", api_key: apiKey } });
      toast.success(`Clé OpenAI validée — modèle choisi : ${r.model}`);
      setLabel("");
      setApiKey("");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(null);
    }
  };
  const test = async (id: string) => {
    setBusy(id);
    try {
      const r = await testOpenAiKey({ data: { id } });
      toast.success(`Fonctionnelle — modèle : ${r.model}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Clé inaccessible");
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <Card className="glass p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Bot className="h-5 w-5 text-primary" />
        <h2 className="text-xl font-semibold">Clés OpenAI (ChatGPT)</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Le meilleur modèle disponible sur votre compte est choisi automatiquement et vérifié.
      </p>
      <Button asChild variant="outline" size="sm" className="w-fit">
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
          Obtenir une clé API OpenAI ↗
        </a>
      </Button>
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] items-end">
        <div>
          <Label>Nom</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ChatGPT" />
        </div>
        <div>
          <Label>Clé API OpenAI</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />
        </div>
        <Button onClick={add} disabled={busy === "add" || apiKey.trim().length < 20}>
          {busy === "add" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Enregistrer & Valider
        </Button>
      </div>
      {data.length > 0 && (
        <div className="grid gap-2">
          {data.map((k: any) => (
            <div
              key={k.id}
              className="flex items-center gap-3 flex-wrap rounded-md border border-input p-3"
            >
              <span className="font-medium">{k.label}</span>
              <code className="text-xs text-muted-foreground">{k.api_key_masked}</code>
              {k.selected_model && <Badge variant="secondary">{k.selected_model}</Badge>}
              {k.error_count > 0 && <Badge variant="destructive">Erreur</Badge>}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => test(k.id)}
                  disabled={busy === k.id}
                >
                  {busy === k.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                </Button>
                <Switch
                  checked={k.is_active}
                  onCheckedChange={async (v) => {
                    await toggleOpenAiKey({ data: { id: k.id, is_active: v } });
                    refresh();
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!confirm("Supprimer cette clé ?")) return;
                    await deleteOpenAiKey({ data: { id: k.id } });
                    refresh();
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
