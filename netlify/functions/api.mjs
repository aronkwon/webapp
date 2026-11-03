// 모임 API 입구 — 기능별 처리는 netlify/lib/*.mjs
//   /api/auth/...     카카오 로그인·로그아웃 (lib/auth.mjs)        ← 로그인 없이 접근
//   /api/config       로그인 화면용 공개 설정                      ← 로그인 없이 접근
//   /api/invites/{코드}/check  초대 링크 확인                     ← 로그인 없이 접근
//   /api/me, /api/members, /api/invites   내 정보·멤버·초대 (lib/auth.mjs)
//   /api/events...    일정 (lib/events.mjs)
//   /api/notices...   공지 (lib/notices.mjs)
//   /api/photos...    사진 (lib/photos.mjs)
//   /api/dues...      회비 내역 (lib/dues.mjs)
// 공개 경로를 뺀 나머지는 모두 로그인한 멤버만 사용 가능
import { fail } from "../lib/http.mjs";
import { handleAuth, handleConfig, handleMe, handleMembers, handleInvites, handleInviteCheck, currentUser } from "../lib/auth.mjs";
import { handleEvents } from "../lib/events.mjs";
import { handleNotices } from "../lib/notices.mjs";
import { handlePhotos } from "../lib/photos.mjs";
import { handleDues } from "../lib/dues.mjs";

const JSON_ROUTES = {
  events: handleEvents, notices: handleNotices, dues: handleDues,
  me: handleMe, members: handleMembers, invites: handleInvites,
};

export default async (req) => {
  const parts = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  try {
    // 공개 경로
    if (parts[0] === "auth") return await handleAuth(req, parts);
    if (parts[0] === "config") return handleConfig();
    if (parts[0] === "invites" && parts[2] === "check" && req.method === "GET") return await handleInviteCheck(parts[1]);

    // 여기부터 로그인 필요
    const user = await currentUser(req);
    if (!user) return fail("로그인이 필요해요", 401);

    if (parts[0] === "photos") return await handlePhotos(req, parts, user);
    const handler = JSON_ROUTES[parts[0]];
    if (!handler) return fail("없는 경로", 404);
    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      const text = await req.text();
      if (text.trim()) {
        try { body = JSON.parse(text); } catch { return fail("잘못된 요청 형식"); }
      }
    }
    return await handler(req, parts, body, user);
  } catch (e) {
    console.error(e);
    return fail("서버 오류가 났어요", 500);
  }
};

export const config = { path: "/api/*" };
