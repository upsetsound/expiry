// Card background photos for the signed-in user.
// GET: their photos (newest first, signed preview URLs) and the last background used.
// POST multipart "file": a cropped 1200x670 JPEG from the browser (re-encoded there, so no photo metadata);
//   stored under <userId>/<uuid>.jpg, keeping the newest 5. POST JSON {use}: remember the last background used.
import { NextResponse } from "next/server";
import { BUCKET } from "@/lib/server/card";
import { currentUserId, supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const KEEP = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function list(userId: string) {
  const store = supabaseAdmin().storage.from(BUCKET);
  const { data } = await store.list(userId, { sortBy: { column: "created_at", order: "desc" }, limit: 100 });
  return (data ?? []).filter((f) => f.name.endsWith(".jpg"));
}

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "signed_out" }, { status: 401 });
  const files = (await list(userId)).slice(0, KEEP);
  const store = supabaseAdmin().storage.from(BUCKET);
  const photos = await Promise.all(
    files.map(async (f) => ({ id: f.name.replace(/\.jpg$/, ""), url: (await store.createSignedUrl(`${userId}/${f.name}`, 3600)).data?.signedUrl ?? null })),
  );
  const { data: prof } = await supabaseAdmin().from("profiles").select("card_bg").eq("id", userId).maybeSingle();
  return NextResponse.json({ photos, last: prof?.card_bg ?? "purple" });
}

export async function POST(request: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "signed_out", message: "Sign in first" }, { status: 401 });
  const db = supabaseAdmin();

  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    const { use } = (await request.json().catch(() => ({}))) as { use?: string };
    if (use !== "purple" && !(use && UUID.test(use))) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    await db.from("profiles").update({ card_bg: use }).eq("id", userId);
    return NextResponse.json({ ok: true });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "bad_request", message: "No photo" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "too_big", message: "Photos up to 5 MB" }, { status: 400 });
  if (file.type !== "image/jpeg") return NextResponse.json({ error: "bad_type", message: "Upload JPG, PNG or WebP" }, { status: 400 });

  const id = crypto.randomUUID();
  const store = db.storage.from(BUCKET);
  const { error } = await store.upload(`${userId}/${id}.jpg`, file, { contentType: "image/jpeg", upsert: false });
  if (error) {
    console.error("card bg upload failed", { userId, message: error.message });
    return NextResponse.json({ error: "server", message: "Upload failed. Try again." }, { status: 500 });
  }
  const old = (await list(userId)).slice(KEEP);
  if (old.length) await store.remove(old.map((f) => `${userId}/${f.name}`));
  await db.from("profiles").update({ card_bg: id }).eq("id", userId);
  return NextResponse.json({ ok: true, id });
}
