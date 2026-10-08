import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { uploadMediaFile } from "@/lib/storage-helper.server";

export const listProducts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("products")
      .select("*, product_images(*)")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    // sign product image URLs
    const withUrls = await Promise.all(
      (data ?? []).map(async (p: any) => {
        const imgs = p.product_images ?? [];
        const signed = await Promise.all(
          imgs.map(async (img: any) => {
            if (!img.image_path) return { ...img, url: "" };
            if (
              img.image_path.startsWith("data:") ||
              img.image_path.startsWith("http://") ||
              img.image_path.startsWith("https://")
            ) {
              return { ...img, url: img.image_path };
            }
            try {
              if (
                context.supabase?.storage &&
                typeof context.supabase.storage.from === "function"
              ) {
                const bucket = context.supabase.storage.from("product-images");
                if (typeof bucket?.createSignedUrl === "function") {
                  const { data: s } = await bucket.createSignedUrl(img.image_path, 3600);
                  return { ...img, url: s?.signedUrl || img.image_path };
                }
              }
              return { ...img, url: img.image_path };
            } catch {
              return { ...img, url: img.image_path };
            }
          }),
        );
        return { ...p, product_images: signed };
      }),
    );
    return withUrls;
  });

const uploadImageSchema = z.object({
  product_id: z.string().uuid(),
  data_base64: z.string().min(1),
  content_type: z.string().default("image/jpeg"),
  filename: z.string().optional(),
  sort_order: z.number().int().default(0),
});

export const uploadProductImageServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => uploadImageSchema.parse(d))
  .handler(async ({ data, context }) => {
    const safeName = (data.filename || "image.jpg").replace(/[^\w.-]/g, "_");
    const contentType = data.content_type || "image/jpeg";
    const buffer = Buffer.from(data.data_base64, "base64");

    // Upload to Supabase Storage
    const publicUrl = await uploadMediaFile({
      userId: context.userId,
      bucket: "product-images",
      fileName: safeName,
      contentType,
      buffer,
      folder: data.product_id,
    });

    const { error: insErr } = await context.supabase.from("product_images").insert({
      product_id: data.product_id,
      image_path: publicUrl,
      sort_order: data.sort_order,
      user_id: context.userId,
    });
    if (insErr) throw new Error(insErr.message);

    return { ok: true, image_path: publicUrl };
  });

const upsertSchema = z.object({
  id: z.string().nullable().optional(),
  name: z.string().min(1, "Veuillez renseigner le nom du produit").max(200),
  price: z.number().min(0),
  stock: z.number().int().min(0),
  description: z.string().max(5000).nullable().optional(),
  payment_flow: z.enum(["admin_numbers", "client_contact"]),
  is_active: z.boolean().default(true),
  page_ids: z.array(z.string().max(100)).max(100).default([]),
});

export const upsertProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => upsertSchema.parse(d))
  .handler(async ({ data, context }) => {
    let res;
    const cleanId = data.id && data.id.trim().length > 0 ? data.id.trim() : undefined;
    const payload = {
      name: data.name.trim(),
      price: Number(data.price),
      stock: Number(data.stock),
      description: data.description ? data.description.trim() : null,
      payment_flow: data.payment_flow,
      is_active: data.is_active,
      page_ids: data.page_ids ?? [],
      user_id: context.userId,
    };

    if (cleanId) {
      res = await context.supabase
        .from("products")
        .update(payload)
        .eq("id", cleanId)
        .eq("user_id", context.userId)
        .select()
        .single();
    } else {
      res = await context.supabase.from("products").insert(payload).select().single();
    }
    if (res.error) throw new Error(res.error.message);
    return res.data;
  });

export const deleteProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("products")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const addProductImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        product_id: z.string().uuid(),
        image_path: z.string().min(1).max(500),
        sort_order: z.number().int().default(0),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("product_images")
      .insert({ ...data, user_id: context.userId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteProductImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("product_images")
      .select("image_path")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (
      row?.image_path &&
      context.supabase?.storage &&
      typeof context.supabase.storage.from === "function"
    ) {
      try {
        const bucket = context.supabase.storage.from("product-images");
        if (typeof bucket?.remove === "function") {
          await bucket.remove([row.image_path]);
        }
      } catch (e) {
        console.warn("[deleteProductImage] storage remove error:", e);
      }
    }
    const { error } = await context.supabase
      .from("product_images")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
