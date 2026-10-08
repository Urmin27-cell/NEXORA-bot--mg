import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ type: z.enum(["training", "sales", "all"]).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("orders")
      .select("*, trainings(name), products(name, stock), prompt_files(label, price)")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });

    if (data?.type && data.type !== "all") {
      query = query.eq("type", data.type);
    }

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

const createSchema = z.object({
  type: z.enum(["training", "sales"]),
  training_id: z.string().uuid().nullable().optional(),
  product_id: z.string().uuid().nullable().optional(),
  client_fb_id: z.string().max(200).nullable().optional(),
  client_fb_name: z.string().max(200).nullable().optional(),
  client_whatsapp: z.string().max(50).nullable().optional(),
  client_phone: z.string().max(50).nullable().optional(),
  payment_reference: z.string().max(200).nullable().optional(),
  quantity: z.number().int().min(1).default(1),
  notes: z.string().max(2000).nullable().optional(),
  page_id: z.string().max(200).nullable().optional(),
  status: z
    .enum(["pending", "awaiting_payment", "payment_sent", "accepted", "refused", "delivered"])
    .default("pending"),
});

export const createOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("orders")
      .insert({ ...data, user_id: context.userId });
    if (error) throw new Error(error.message);

    // Envoi temps réel sur WhatsApp (best effort).
    let whatsapp = false;
    try {
      const { notifyOrderOnWhatsApp } = await import("@/lib/whatsapp.server");
      let itemName: string | null = null;
      if (data.product_id) {
        const { data: p } = await context.supabase
          .from("products")
          .select("name")
          .eq("id", data.product_id)
          .maybeSingle();
        itemName = p?.name ?? null;
      } else if (data.training_id) {
        const { data: t } = await context.supabase
          .from("trainings")
          .select("name")
          .eq("id", data.training_id)
          .maybeSingle();
        itemName = t?.name ?? null;
      }
      const res = await notifyOrderOnWhatsApp({
        type: data.type,
        item: itemName ?? data.notes ?? null,
        quantity: data.quantity,
        client_fb_name: data.client_fb_name ?? null,
        client_phone: data.client_phone ?? null,
        client_whatsapp: data.client_whatsapp ?? null,
        payment_reference: data.payment_reference ?? null,
        notes: data.notes ?? null,
        status: data.status,
        source: "Site",
      });
      whatsapp = res.sent;
    } catch (e) {
      console.error("[createOrder] whatsapp error", e);
    }

    return { ok: true, whatsapp };
  });

export const updateOrderStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum([
          "pending",
          "awaiting_payment",
          "payment_sent",
          "accepted",
          "refused",
          "delivered",
        ]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: order, error } = await context.supabase
      .from("orders")
      .update({ status: data.status })
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    // Decrement stock on accept/delivered for sales
    if (
      order.type === "sales" &&
      order.product_id &&
      (data.status === "accepted" || data.status === "delivered")
    ) {
      const { data: prod } = await context.supabase
        .from("products")
        .select("stock")
        .eq("id", order.product_id)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (prod && prod.stock >= (order.quantity ?? 1)) {
        await context.supabase
          .from("products")
          .update({ stock: prod.stock - (order.quantity ?? 1) })
          .eq("id", order.product_id)
          .eq("user_id", context.userId);
      }
    }

    // Notify the Messenger client about the decision (best effort).
    let notified = false;
    if (["accepted", "refused", "delivered"].includes(data.status)) {
      try {
        const { notifyOrderStatusToClient } = await import("@/lib/ai-engine.server");
        const res = await notifyOrderStatusToClient(context.userId, data.id, data.status);
        notified = res.sent;
      } catch (e) {
        console.error("[updateOrderStatus] notify error", e);
      }
    }
    return { ok: true, notified };
  });

export const deleteOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("orders")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
