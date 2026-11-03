// 사진 — 일정·공지 등 어떤 글에든 붙일 수 있음
// 저장 구조
//   moim-photos 저장소: {photoId}/full, {photoId}/thumb   (이미지 바이트, 폰에서 줄여서 올림)
//   moim 저장소:        pm/{parent}/{photoId}               (사진 정보, parent 예: e-일정ID, n-공지ID)
// 사람마다/사진마다 키를 나눠서 여러 명이 동시에 올려도 서로 덮어쓰지 않음
import { store, photoStore, json, fail, badMethod, clean, newId, ID_RE, readAll } from "./http.mjs";

const PARENT_RE = /^(e|n)-([a-z0-9]{1,24})$/;
const PARENT_PREFIX = { e: "events/", n: "notices/" };
const MAX_FULL = 1.5 * 1024 * 1024;
const MAX_THUMB = 200 * 1024;
const MAX_PER_PARENT = 10;
const TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);

export async function parentExists(parent) {
  const m = PARENT_RE.exec(parent || "");
  if (!m) return false;
  return !!(await store().getMetadata(PARENT_PREFIX[m[1]] + m[2]));
}

export const listPhotos = async (parent) =>
  (await readAll(store(), `pm/${parent}/`)).sort((a, b) => a.at.localeCompare(b.at));

// 글별 사진 개수 (목록 화면용) — 키 목록만 읽음
export async function photoCounts() {
  const { blobs } = await store().list({ prefix: "pm/" });
  const n = {};
  for (const { key } of blobs) { const p = key.split("/")[1]; n[p] = (n[p] || 0) + 1; }
  return n;
}

export async function deletePhotosOf(parent) {
  const s = store(), ps = photoStore();
  const { blobs } = await s.list({ prefix: `pm/${parent}/` });
  await Promise.all(blobs.flatMap((b) => {
    const id = b.key.split("/")[2];
    return [s.delete(b.key), ps.delete(`${id}/full`), ps.delete(`${id}/thumb`)];
  }));
}

// /api/photos...
export async function handlePhotos(req, parts) {
  const method = req.method;
  const url = new URL(req.url);

  // GET /api/photos/:id/(full|thumb) — 이미지 바이트. 한 번 받으면 브라우저가 계속 재사용
  if (parts.length === 3 && method === "GET") {
    const [, id, size] = parts;
    if (!ID_RE.test(id) || !["full", "thumb"].includes(size)) return fail("잘못된 사진 주소", 404);
    const r = await photoStore().getWithMetadata(`${id}/${size}`, { type: "arrayBuffer" });
    if (!r) return fail("사진이 없어요", 404);
    return new Response(r.data, {
      headers: {
        "content-type": r.metadata?.type || "image/webp",
        "cache-control": "public, max-age=31536000, immutable",
        "netlify-cdn-cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (parts.length === 1) {
    // GET /api/photos?parent=e-ID
    if (method === "GET") {
      const parent = url.searchParams.get("parent");
      if (!PARENT_RE.test(parent || "")) return fail("잘못된 대상");
      return json({ photos: await listPhotos(parent) });
    }
    // POST /api/photos  (multipart: parent, by, full, thumb, w, h)
    if (method === "POST") {
      let form;
      try { form = await req.formData(); } catch { return fail("잘못된 업로드 형식"); }
      const parent = String(form.get("parent") || "");
      const full = form.get("full"), thumb = form.get("thumb");
      if (!(await parentExists(parent))) return fail("사진을 붙일 글을 찾을 수 없어요", 404);
      if (!full || typeof full === "string" || !thumb || typeof thumb === "string") return fail("사진 파일이 없어요");
      if (!TYPES.has(full.type) || !TYPES.has(thumb.type)) return fail("이미지 파일만 올릴 수 있어요");
      if (full.size > MAX_FULL || thumb.size > MAX_THUMB) return fail("사진이 너무 커요");
      const { blobs } = await store().list({ prefix: `pm/${parent}/` });
      if (blobs.length >= MAX_PER_PARENT) return fail(`사진은 글 하나에 ${MAX_PER_PARENT}장까지예요`);

      const id = newId();
      const ps = photoStore();
      await Promise.all([
        ps.set(`${id}/full`, await full.arrayBuffer(), { metadata: { type: full.type } }),
        ps.set(`${id}/thumb`, await thumb.arrayBuffer(), { metadata: { type: thumb.type } }),
      ]);
      const meta = {
        id, parent,
        by: clean(form.get("by"), 20),
        w: Math.min(+form.get("w") || 0, 10000), h: Math.min(+form.get("h") || 0, 10000),
        size: full.size,
        at: new Date().toISOString(),
      };
      await store().setJSON(`pm/${parent}/${id}`, meta);
      return json({ photo: meta }, 201);
    }
    return badMethod();
  }

  // DELETE /api/photos/:id?parent=e-ID
  if (parts.length === 2 && method === "DELETE") {
    const id = parts[1], parent = url.searchParams.get("parent") || "";
    if (!ID_RE.test(id) || !PARENT_RE.test(parent)) return fail("잘못된 요청");
    const ps = photoStore();
    await Promise.all([store().delete(`pm/${parent}/${id}`), ps.delete(`${id}/full`), ps.delete(`${id}/thumb`)]);
    return json({ ok: true });
  }
  return fail("없는 경로", 404);
}
