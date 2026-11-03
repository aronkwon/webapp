// API 공통 도구
import { getStore } from "@netlify/blobs";

// 글(JSON) 저장소와 사진(바이너리) 저장소를 분리
export const store = () => getStore({ name: "moim", consistency: "strong" });
export const photoStore = () => getStore({ name: "moim-photos", consistency: "strong" });

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
export const fail = (error, status = 400) => json({ error }, status);
export const badMethod = () => fail("허용되지 않는 메서드", 405);

export const clean = (v, max) => String(v ?? "").trim().slice(0, max);
export const rid = () => Math.random().toString(36).slice(2, 10);
export const newId = () => Date.now().toString(36) + rid().slice(0, 4);
export const ID_RE = /^[a-z0-9]{1,24}$/;

export async function readAll(s, prefix) {
  const { blobs } = await s.list({ prefix });
  return (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
}
