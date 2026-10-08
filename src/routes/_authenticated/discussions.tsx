import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Users,
  Send,
  Search,
  Copy,
  Check,
  CheckCheck,
  ImagePlus,
  Mic,
  X,
  Loader2,
  ArrowLeft,
  Maximize2,
  Minimize2,
} from "lucide-react";

import {
  listConversations,
  listConversationMessages,
  sendDiscussionMessage,
  sendDiscussionAttachment,
} from "@/lib/discussions.functions";
import { setClientIaStopped } from "@/lib/ia-control.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/discussions")({
  component: DiscussionsPage,
  head: () => ({
    meta: [
      { title: "Discussions clients | Nexora" },
      {
        name: "description",
        content:
          "Répondez à vos clients Messenger : messages, images et notes vocales en direct depuis Nexora.",
      },
      { property: "og:title", content: "Discussions clients | Nexora" },
      {
        property: "og:description",
        content: "Messagerie Messenger unifiée : recherche client, images et messages vocaux.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const READ_KEY = "nexora_discussions_read";

function loadRead(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) || "{}");
  } catch {
    return {};
  }
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Lecture du fichier impossible"));
    reader.readAsDataURL(file);
  });
}

function DiscussionsPage() {
  const qc = useQueryClient();
  const { data: convs = [] } = useQuery({
    queryKey: ["conversations"],
    queryFn: async () => {
      try {
        return await listConversations();
      } catch (e) {
        console.warn("Conversations query error", e);
        return [];
      }
    },
    refetchInterval: 15000,
  });
  const [selected, setSelected] = useState<any | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const [read, setRead] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRead(loadRead());
  }, []);

  const { data: messages = [] } = useQuery({
    queryKey: ["conversation", selected?.page_id, selected?.client_fb_id],
    queryFn: async () => {
      try {
        return await listConversationMessages({
          data: { page_id: selected.page_id, client_fb_id: selected.client_fb_id },
        });
      } catch (e) {
        console.warn("Conversation messages query error", e);
        return [];
      }
    },
    enabled: !!selected,
    refetchInterval: 10000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, selected?.client_fb_id]);

  const markRead = (c: any) => {
    const key = `${c.page_id}::${c.client_fb_id}`;
    const next = { ...loadRead(), [key]: c.last_at ?? new Date().toISOString() };
    localStorage.setItem(READ_KEY, JSON.stringify(next));
    setRead(next);
  };

  const openConv = (c: any) => {
    setSelected(c);
    setFullscreen(true);
    markRead(c);
  };

  // Close fullscreen with the Escape key.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const isUnread = (c: any) => {
    if (!c.unread) return false;
    const seen = read[`${c.page_id}::${c.client_fb_id}`];
    return !seen || (c.last_at && new Date(c.last_at) > new Date(seen));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return convs;
    return (convs as any[]).filter(
      (c) =>
        String(c.client_fb_name ?? "")
          .toLowerCase()
          .includes(q) || String(c.client_fb_id ?? "").includes(q),
    );
  }, [convs, search]);

  const copyId = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.client_fb_id);
      setCopied(true);
      toast.success("ID copié");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copie impossible");
    }
  };

  const send = async () => {
    if (!selected || !text.trim()) return;
    setSending(true);
    try {
      await sendDiscussionMessage({
        data: { page_id: selected.page_id, client_fb_id: selected.client_fb_id, text: text.trim() },
      });
      setText("");
      qc.invalidateQueries({ queryKey: ["conversation", selected.page_id, selected.client_fb_id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setSending(false);
    }
  };

  const sendBlob = async (blob: Blob, kind: "image" | "audio", filename: string) => {
    if (!selected) return;
    setUploading(true);
    try {
      const data_base64 = await fileToBase64(blob);
      await sendDiscussionAttachment({
        data: {
          page_id: selected.page_id,
          client_fb_id: selected.client_fb_id,
          kind,
          filename,
          content_type: blob.type || (kind === "image" ? "image/jpeg" : "audio/mp4"),
          data_base64,
        },
      });
      toast.success(kind === "image" ? "Image envoyée" : "Message vocal envoyé");
      qc.invalidateQueries({ queryKey: ["conversation", selected.page_id, selected.client_fb_id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur d'envoi");
    } finally {
      setUploading(false);
    }
  };

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await sendBlob(file, "image", file.name);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/mp4" });
        if (blob.size > 0) {
          const ext = (rec.mimeType || "").includes("webm") ? "webm" : "m4a";
          await sendBlob(blob, "audio", `vocal-${Date.now()}.${ext}`);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setRecSeconds(0);
    } catch {
      toast.error("Micro indisponible");
    }
  };

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const stopRecording = (send = true) => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (!send) rec.onstop = () => rec.stream.getTracks().forEach((t) => t.stop());
    rec.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  const toggleIa = async (v: boolean) => {
    if (!selected) return;
    try {
      await setClientIaStopped({
        data: {
          page_id: selected.page_id,
          client_fb_id: selected.client_fb_id,
          client_fb_name: selected.client_fb_name,
          ia_stopped: v,
        },
      });
      toast.success(v ? "IA arrêtée pour ce client" : "IA réactivée");
      qc.invalidateQueries({ queryKey: ["conversations"] });
      setSelected({ ...selected, ia_stopped: v });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold gradient-text flex items-center gap-2">
          <Users className="h-8 w-8" /> Discussions
        </h1>
        <p className="text-muted-foreground mt-1">Reprenez la main sur une conversation client.</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4 h-[72vh]">
        <Card className="glass p-0 flex flex-col overflow-hidden">
          <div className="p-3 border-b border-border space-y-2">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Rechercher un nom…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-8"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Effacer"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="text-xs font-medium text-muted-foreground px-1">
              {filtered.length} conversation(s)
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filtered.map((c: any) => {
              const unread = isUnread(c);
              return (
                <button
                  key={`${c.page_id}::${c.client_fb_id}`}
                  onClick={() => openConv(c)}
                  className={`w-full text-left rounded-lg p-2.5 transition flex items-center gap-3 ${
                    selected?.client_fb_id === c.client_fb_id
                      ? "bg-primary/10 border border-primary/30"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <div className="h-10 w-10 shrink-0 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold">
                    {initials(String(c.client_fb_name || "?"))}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`truncate text-sm ${unread ? "font-bold" : "font-medium"}`}>
                        {c.client_fb_name}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {c.last_at
                          ? new Date(c.last_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : ""}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-xs truncate ${
                          unread ? "text-foreground font-medium" : "text-muted-foreground"
                        }`}
                      >
                        {c.last_direction === "outgoing" && (
                          <CheckCheck className="inline h-3 w-3 mr-1 text-primary" />
                        )}
                        {c.last_message}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        {c.ia_stopped && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive">
                            IA off
                          </span>
                        )}
                        {unread && (
                          <span className="h-2.5 w-2.5 rounded-full bg-green-500 inline-block" />
                        )}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="text-center text-xs text-muted-foreground py-6">
                Aucune conversation.
              </div>
            )}
          </div>
        </Card>

        <Card
          className={
            fullscreen && selected
              ? "glass p-0 flex flex-col overflow-hidden fixed inset-0 z-50 rounded-none border-0 h-screen w-screen"
              : "glass p-0 md:col-span-2 flex flex-col overflow-hidden"
          }
        >
          {selected ? (
            <>
              <div className="p-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  {fullscreen && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setFullscreen(false)}
                      title="Retour"
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                  )}
                  <div className="h-10 w-10 shrink-0 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold">
                    {initials(String(selected.client_fb_name || "?"))}
                  </div>

                  <div className="min-w-0">
                    <div className="font-semibold truncate">{selected.client_fb_name}</div>
                    <button
                      onClick={copyId}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 font-mono"
                      title="Copier l'ID"
                    >
                      ID : {selected.client_fb_id}
                      {copied ? (
                        <Check className="h-3 w-3 text-green-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span>Stop IA</span>
                  <Switch checked={selected.ia_stopped ?? false} onCheckedChange={toggleIa} />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setFullscreen((v) => !v)}
                    title={fullscreen ? "Réduire" : "Plein écran"}
                  >
                    {fullscreen ? (
                      <Minimize2 className="h-4 w-4" />
                    ) : (
                      <Maximize2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-muted/20">
                {messages.map((m: any) => {
                  const isAi = m.direction === "outgoing";
                  return (
                    <div key={m.id} className={`flex ${isAi ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[75%] px-3 py-2 text-sm shadow-sm ${
                          isAi
                            ? "bg-primary text-primary-foreground rounded-2xl rounded-br-sm"
                            : "bg-card rounded-2xl rounded-bl-sm"
                        }`}
                      >
                        {m.media_url && m.media_type === "audio" ? (
                          <audio controls src={m.media_url} className="max-w-[220px]" />
                        ) : null}
                        {m.media_url && m.media_type !== "audio" && (
                          <div className="mb-1 overflow-hidden rounded-lg border border-white/10 max-w-xs">
                            <img
                              src={m.media_url}
                              alt="Sary"
                              className="w-full max-h-64 object-cover"
                              loading="lazy"
                            />
                          </div>
                        )}
                        <div className="whitespace-pre-wrap break-words">
                          {m.content || m.ai_response}
                        </div>
                        <div
                          className={`flex items-center justify-end gap-1 text-[10px] mt-1 ${
                            isAi ? "opacity-80" : "text-muted-foreground"
                          }`}
                        >
                          {new Date(m.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          {isAi && <CheckCheck className="h-3 w-3" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {messages.length === 0 && (
                  <div className="text-center text-sm text-muted-foreground py-8">
                    Aucun message.
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              <div className="p-3 border-t border-border flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickImage}
                />
                {recording ? (
                  <div className="flex-1 flex items-center gap-3">
                    <span className="flex items-center gap-2 text-sm text-destructive">
                      <span className="h-2.5 w-2.5 rounded-full bg-destructive animate-pulse" />
                      {String(Math.floor(recSeconds / 60)).padStart(2, "0")}:
                      {String(recSeconds % 60).padStart(2, "0")}
                    </span>
                    <Button variant="ghost" size="icon" onClick={() => stopRecording(false)}>
                      <X className="h-4 w-4" />
                    </Button>
                    <Button onClick={() => stopRecording(true)} className="ml-auto">
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={uploading}
                      onClick={() => fileRef.current?.click()}
                      title="Envoyer une image"
                    >
                      {uploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ImagePlus className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={uploading}
                      onClick={startRecording}
                      title="Message vocal"
                    >
                      <Mic className="h-4 w-4" />
                    </Button>
                    <Input
                      placeholder="Écrire un message…"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
                    />
                    <Button onClick={send} disabled={sending || !text.trim()}>
                      {sending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Sélectionnez une conversation.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
