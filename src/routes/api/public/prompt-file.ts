import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Public proxy so Messenger can fetch a prompt file stored in the private bucket. */
export const Route = createFileRoute("/api/public/prompt-file")({
  server: {
    handlers: {
      GET: async (ctx) => {
        try {
          const url = new URL(ctx.request.url);
          const id = url.searchParams.get("id");
          if (!id) return new Response("Missing id", { status: 400 });

          const { data: row } = await supabaseAdmin
            .from("prompt_files")
            .select("file_path,mime_type,label")
            .eq("id", id)
            .maybeSingle();

          if (!row?.file_path) return new Response("File not found", { status: 404 });

          const { data: blob, error } = await supabaseAdmin.storage
            .from("prompt-files")
            .download(row.file_path);
          if (error || !blob) return new Response("File not found", { status: 404 });

          const buffer = Buffer.from(await blob.arrayBuffer());
          return new Response(buffer as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": row.mime_type || "application/octet-stream",
              "Content-Length": String(buffer.length),
              "Cache-Control": "public, max-age=86400",
            },
          });
        } catch (e) {
          console.error("[/api/public/prompt-file] error:", e);
          return new Response("Internal server error", { status: 500 });
        }
      },
    },
  },
});
