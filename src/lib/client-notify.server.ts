/**
 * Notifications Messenger ciblées.
 *
 * Seuls les PSID enregistrés et activés dans `notification_recipients`
 * reçoivent ces messages (quota Gemini épuisé, détails de commande).
 * Aucun autre client de la Page Facebook n'est contacté.
 *
 * Module strictement additif : ne modifie aucune logique existante.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendMessengerReply } from "@/lib/ai-engine.server";

/** Anti-spam : pas plus d'une alerte quota par destinataire toutes les 30 min. */
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;

type Recipient = {
  id: string;
  page_id: string;
  recipient_psid: string;
  label: string | null;
  last_quota_notified_at: string | null;
};

async function loadRecipients(userId: string, kind: "quota" | "orders"): Promise<Recipient[]> {
  const column = kind === "quota" ? "notify_quota" : "notify_orders";
  const { data, error } = await supabaseAdmin
    .from("notification_recipients")
    .select("id,page_id,recipient_psid,label,last_quota_notified_at")
    .eq("user_id", userId)
    .eq("is_active", true)
    .eq(column, true);
  if (error) {
    console.error("[client-notify] load error:", error.message);
    return [];
  }
  return (data ?? []) as Recipient[];
}

async function pageTokens(userId: string): Promise<Map<string, string>> {
  const { data } = await supabaseAdmin
    .from("facebook_pages")
    .select("page_id,page_access_token")
    .eq("user_id", userId)
    .eq("is_connected", true);
  const map = new Map<string, string>();
  for (const p of data ?? []) {
    if (p.page_id && p.page_access_token) map.set(p.page_id, p.page_access_token);
  }
  return map;
}

/** Envoi effectif, best-effort : n'interrompt jamais l'appelant. */
async function dispatch(
  userId: string,
  kind: "quota" | "orders",
  text: string,
): Promise<{ sent: number; skipped: number }> {
  let sent = 0;
  let skipped = 0;
  try {
    const recipients = await loadRecipients(userId, kind);
    if (recipients.length === 0) return { sent: 0, skipped: 0 };
    const tokens = await pageTokens(userId);
    const now = Date.now();

    for (const r of recipients) {
      const token = tokens.get(r.page_id);
      if (!token) {
        skipped++;
        continue;
      }
      if (kind === "quota" && r.last_quota_notified_at) {
        const last = new Date(r.last_quota_notified_at).getTime();
        if (Number.isFinite(last) && now - last < QUOTA_COOLDOWN_MS) {
          skipped++;
          continue;
        }
      }
      try {
        await sendMessengerReply(token, r.recipient_psid, text);
        sent++;
        const patch =
          kind === "quota"
            ? { last_quota_notified_at: new Date().toISOString() }
            : { last_order_notified_at: new Date().toISOString() };
        await supabaseAdmin.from("notification_recipients").update(patch).eq("id", r.id);
      } catch (e) {
        skipped++;
        console.warn(
          `[client-notify] envoi échoué pour ${r.recipient_psid}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  } catch (e) {
    console.error("[client-notify] dispatch error:", e);
  }
  return { sent, skipped };
}

/** Alerte « quota Gemini épuisé » aux destinataires enregistrés. */
export async function notifyQuotaExhausted(userId: string, detail?: string) {
  const text =
    "⚠️ Fampandrenesana automatique : lany ny quota Gemini API amin'izao fotoana izao. " +
    "Mety hihemotra kely ny valin'ny IA. Hiverina ho azy ny fandehany rehefa misokatra indray ny quota." +
    (detail ? `\nAntsipiriany : ${detail}` : "");
  return dispatch(userId, "quota", text);
}

export type OrderNotice = {
  type?: string | null;
  item?: string | null;
  quantity?: number | null;
  client_fb_name?: string | null;
  client_phone?: string | null;
  client_whatsapp?: string | null;
  client_address?: string | null;
  payment_reference?: string | null;
  notes?: string | null;
  status?: string | null;
};

/** Alerte « nouvelle commande » avec les détails, aux destinataires enregistrés. */
export async function notifyOrderToRecipients(userId: string, order: OrderNotice) {
  const lines = [
    "🛒 Commande vaovao",
    order.item ? `Entana : ${order.item}` : null,
    order.type ? `Karazana : ${order.type}` : null,
    order.quantity && order.quantity > 1 ? `Isa : ${order.quantity}` : null,
    order.client_fb_name ? `Mpanjifa : ${order.client_fb_name}` : null,
    order.client_phone ? `Finday : ${order.client_phone}` : null,
    order.client_whatsapp && order.client_whatsapp !== order.client_phone
      ? `WhatsApp : ${order.client_whatsapp}`
      : null,
    order.client_address ? `Adiresy : ${order.client_address}` : null,
    order.payment_reference ? `Réf. fandoavana : ${order.payment_reference}` : null,
    order.notes ? `Notes : ${order.notes}` : null,
    order.status ? `Statut : ${order.status}` : null,
  ].filter(Boolean);
  return dispatch(userId, "orders", lines.join("\n"));
}

/** Test manuel depuis l'interface Admin. */
export async function sendTestNotification(userId: string, recipientId: string) {
  const { data: r } = await supabaseAdmin
    .from("notification_recipients")
    .select("page_id,recipient_psid")
    .eq("id", recipientId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!r) return { sent: false, error: "Tsy hita ilay destinataire" };
  const tokens = await pageTokens(userId);
  const token = tokens.get(r.page_id);
  if (!token) return { sent: false, error: "Tsy misy jeton ho an'io Page io" };
  try {
    await sendMessengerReply(
      token,
      r.recipient_psid,
      "✅ Fitsapana : mandeha tsara ny fampandrenesana automatique avy amin'ny rafitra.",
    );
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : "Erreur" };
  }
}
