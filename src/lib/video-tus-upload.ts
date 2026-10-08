// Client-side resumable (TUS) upload to Supabase Storage, with progress + resume.
// Used by the Auto-poste page for videos up to 1 GB.
import { supabase } from "@/integrations/supabase/client";

export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1 Go
const CHUNK_SIZE = 6 * 1024 * 1024; // Supabase TUS requires 6 MB chunks

export type VideoUploadSession = {
  bucket: string;
  path: string;
  uploadUrl: string;
  size: number;
};

function b64(s: string) {
  return btoa(unescape(encodeURIComponent(s)));
}

function baseUrl() {
  return (import.meta.env["VITE_SUPABASE_URL"] as string).replace(/\/$/, "");
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? "";
  return {
    Authorization: `Bearer ${token}`,
    "x-upsert": "true",
    "Tus-Resumable": "1.0.0",
  } as Record<string, string>;
}

/** Creates a resumable upload session (call once per file). */
export async function createVideoUploadSession(file: File): Promise<VideoUploadSession> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? "anon";
  const bucket = "post-videos";
  const safeName = file.name.replace(/[^\w.\-]/g, "_");
  const path = `${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;

  const res = await fetch(`${baseUrl()}/storage/v1/upload/resumable`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Upload-Length": String(file.size),
      "Upload-Metadata": [
        `bucketName ${b64(bucket)}`,
        `objectName ${b64(path)}`,
        `contentType ${b64(file.type || "video/mp4")}`,
        `cacheControl ${b64("3600")}`,
      ].join(","),
    },
  });
  if (!res.ok) throw new Error(`Upload tsy afaka nanomboka (${res.status})`);
  const location = res.headers.get("location");
  if (!location) throw new Error("Upload URL tsy hita");
  const uploadUrl = location.startsWith("http") ? location : `${baseUrl()}${location}`;
  return { bucket, path, uploadUrl, size: file.size };
}

/** Asks the server how many bytes are already stored for this session. */
export async function getUploadedOffset(session: VideoUploadSession): Promise<number> {
  const res = await fetch(session.uploadUrl, {
    method: "HEAD",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`Tsy hita ny upload (${res.status})`);
  return Number(res.headers.get("upload-offset") ?? 0);
}

function patchChunk(
  uploadUrl: string,
  headers: Record<string, string>,
  chunk: Blob,
  offset: number,
  onByte: (uploaded: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", uploadUrl, true);
    Object.entries({
      ...headers,
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": String(offset),
    }).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => onByte(offset + e.loaded);
    xhr.onerror = () => reject(new Error("Tapaka ny fifandraisana"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(Number(xhr.getResponseHeader("upload-offset") ?? offset + chunk.size));
      } else {
        reject(new Error(`Upload nikatona (${xhr.status})`));
      }
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(chunk);
  });
}

/**
 * Uploads (or resumes) the file. Progress is reported 0-100.
 * Throws on failure — the same session can be passed again to continue.
 */
export async function uploadVideoResumable(
  file: File,
  session: VideoUploadSession,
  onProgress: (percent: number, uploadedBytes: number) => void,
  signal?: AbortSignal,
): Promise<{ path: string }> {
  const headers = await authHeaders();
  let offset = await getUploadedOffset(session);
  onProgress(Math.round((offset / file.size) * 100), offset);

  while (offset < file.size) {
    if (signal?.aborted) throw new Error("aborted");
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const chunk = file.slice(offset, end);
    // eslint-disable-next-line no-await-in-loop
    offset = await patchChunk(
      session.uploadUrl,
      headers,
      chunk,
      offset,
      (uploaded) => onProgress(Math.min(100, Math.round((uploaded / file.size) * 100)), uploaded),
      signal,
    );
    onProgress(Math.min(100, Math.round((offset / file.size) * 100)), offset);
  }
  return { path: session.path };
}
