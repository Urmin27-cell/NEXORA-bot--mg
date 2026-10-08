/**
 * WhatsApp Cloud API (officiel) — envoi en temps réel des commandes.
 * Secrets requis : WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID.
 * Destinataire par défaut : WHATSAPP_NOTIFY_NUMBER (sinon +261 32 39 116 54).
 */

const DEFAULT_NOTIFY_NUMBER = "261323911654";
const GRAPH = "https://graph.facebook.com/v21.0";

function notifyNumber(): string {
  const raw = process.env["WHATSAPP_NOTIFY_NUMBER"] || DEFAULT_NOTIFY_NUMBER;
  return raw.replace(/[^\d]/g, "");
}

export async function sendWhatsAppText(
  to: string,
  body: string,
): Promise<{ sent: boolean; error?: string }> {
  const token = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!token || !phoneId) {
    return { sent: false, error: "WhatsApp non configuré (token / phone number id manquant)" };
  }
  const target = (to || "").replace(/[^\d]/g, "");
  if (!target) return { sent: false, error: "Numéro WhatsApp invalide" };

  try {
    const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: target,
        type: "text",
        text: { preview_url: false, body: body.slice(0, 4000) },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[whatsapp] send failed [${res.status}]: ${text}`);
      return { sent: false, error: `[${res.status}] ${text}` };
    }
    return { sent: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[whatsapp] send error", msg);
    return { sent: false, error: msg };
  }
}

export type WhatsAppOrderPayload = {
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
  source?: string | null;
};

export function formatOrderMessage(o: WhatsAppOrderPayload): string {
  const lines: string[] = [];
  lines.push("🛒 COMMANDE VAOVAO");
  lines.push(`Karazana : ${o.type === "training" ? "Formation" : "Vente"}`);
  if (o.item) lines.push(`Article : ${o.item}`);
  if (o.quantity && o.quantity > 1) lines.push(`Isa : ${o.quantity}`);
  if (o.client_fb_name) lines.push(`Mpanjifa : ${o.client_fb_name}`);
  if (o.client_phone) lines.push(`Finday : ${o.client_phone}`);
  if (o.client_whatsapp && o.client_whatsapp !== o.client_phone)
    lines.push(`WhatsApp : ${o.client_whatsapp}`);
  if (o.client_address) lines.push(`Adiresy : ${o.client_address}`);
  if (o.payment_reference) lines.push(`Réf. paiement : ${o.payment_reference}`);
  if (o.notes) lines.push(`Notes : ${o.notes}`);
  if (o.status) lines.push(`Statut : ${o.status}`);
  lines.push(`Source : ${o.source || "Site"}`);
  lines.push(`Daty : ${new Date().toLocaleString("fr-FR")}`);
  return lines.join("\n");
}

/** Envoie la commande au numéro WhatsApp de l'admin (best effort). */
export async function notifyOrderOnWhatsApp(
  o: WhatsAppOrderPayload,
): Promise<{ sent: boolean; error?: string }> {
  return sendWhatsAppText(notifyNumber(), formatOrderMessage(o));
}
