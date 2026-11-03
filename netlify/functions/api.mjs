// 모임 API 입구 — 기능별 처리는 netlify/lib/*.mjs
//   /api/events...   일정 (lib/events.mjs)
//   /api/notices...  공지 (lib/notices.mjs)
//   /api/photos...   사진 (lib/photos.mjs)
//   /api/dues...     회비 내역 (lib/dues.mjs)
import { fail } from "../lib/http.mjs";
import { handleEvents } from "../lib/events.mjs";
import { handleNotices } from "../lib/notices.mjs";
import { handlePhotos } from "../lib/photos.mjs";
import { handleDues } from "../lib/dues.mjs";

const JSON_ROUTES = { events: handleEvents, notices: handleNotices, dues: handleDues };

export default async (req) => {
  const parts = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  try {
    if (parts[0] === "photos") return await handlePhotos(req, parts);
    const handler = JSON_ROUTES[parts[0]];
    if (!handler) return fail("없는 경로", 404);
    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try { body = await req.json(); } catch { return fail("잘못된 요청 형식"); }
    }
    return await handler(req, parts, body);
  } catch (e) {
    console.error(e);
    return fail("서버 오류가 났어요", 500);
  }
};

export const config = { path: "/api/*" };
