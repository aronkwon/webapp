// 로그인·멤버·초대 (IAM)
//
// 흐름
//   1) 방장/운영진이 초대 링크를 만들어 카카오톡으로 공유  →  https://사이트/#/join/{초대코드}
//   2) 친구가 링크를 열고 "카카오로 시작하기"  →  /api/auth/kakao?invite=코드  →  카카오 로그인
//   3) 카카오가 /api/auth/kakao/callback 으로 돌려보내면 사용자 정보 확인 후 멤버로 등록하고 세션 쿠키 발급
//   * 멤버가 한 명도 없을 때 처음 로그인한 사람은 초대 없이 '방장(owner)'이 됨
//
// 저장 구조 (moim 저장소)
//   users/{uid}       멤버 (uid = "k" + 카카오 회원번호): name, kakaoName, avatar, role, joinedAt, lastSeenAt, invitedBy
//   invites/{code}    초대 링크: createdBy, createdAt, expiresAt, uses
//
// 필요한 환경 변수 (Netlify > Site configuration > Environment variables)
//   KAKAO_REST_API_KEY    카카오 앱 REST API 키
//   KAKAO_CLIENT_SECRET   REST API 키의 클라이언트 시크릿 (카카오에서 기본으로 켜져 있음)
//   KAKAO_JS_KEY          JavaScript 키 (카카오톡 공유용, 없으면 휴대폰 공유창으로 대신)
//   SESSION_SECRET        아무 긴 무작위 문자열 (32자 이상)
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { store, json, fail, badMethod, clean } from "./http.mjs";

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? "").trim();
const SESSION_COOKIE = "moim_sid";
const STATE_COOKIE = "moim_oauth";
const SESSION_DAYS = 90;
const INVITE_DAYS = 7;
const ROLES = ["owner", "admin", "member"];
export const isAdmin = (u) => u && (u.role === "owner" || u.role === "admin");

// ---------- 서명된 쿠키 ----------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function sign(payload) {
  const secret = env("SESSION_SECRET");
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
}
function verify(token) {
  const secret = env("SESSION_SECRET");
  if (!secret || !token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const want = createHmac("sha256", secret).update(body).digest();
  let got;
  try { got = Buffer.from(sig, "base64url"); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp && p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function readCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
const cookie = (name, value, maxAge, path = "/") =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function redirect(location, cookies = []) {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

// ---------- 세션 확인 (모든 API에서 사용) ----------
export async function currentUser(req) {
  const p = verify(readCookie(req, SESSION_COOKIE));
  if (!p?.uid) return null;
  const s = store();
  const u = await s.get(`users/${p.uid}`, { type: "json" });
  if (!u) return null; // 내보낸 멤버는 바로 접속 끊김
  // 하루에 한 번만 마지막 접속 시각 갱신
  if (!u.lastSeenAt || Date.now() - Date.parse(u.lastSeenAt) > 864e5) {
    u.lastSeenAt = new Date().toISOString();
    await s.setJSON(`users/${u.uid}`, u);
  }
  return u;
}

const publicUser = (u) => ({ uid: u.uid, name: u.name, avatar: u.avatar, role: u.role, joinedAt: u.joinedAt, lastSeenAt: u.lastSeenAt });

async function validInvite(code) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(code || "")) return null;
  const inv = await store().get(`invites/${code}`, { type: "json" });
  return inv && Date.parse(inv.expiresAt) > Date.now() ? inv : null;
}

// ---------- 카카오 로그인 ----------
async function kakaoProfile(code, redirectUri) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env("KAKAO_REST_API_KEY"),
    redirect_uri: redirectUri,
    code,
  });
  if (env("KAKAO_CLIENT_SECRET")) form.set("client_secret", env("KAKAO_CLIENT_SECRET"));
  const t = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: form,
    signal: AbortSignal.timeout(6000),
  });
  const tok = await t.json().catch(() => ({}));
  if (!t.ok || !tok.access_token) throw new Error("token: " + (tok.error_code || tok.error || t.status));
  const r = await fetch("https://kapi.kakao.com/v2/user/me", {
    headers: { authorization: `Bearer ${tok.access_token}` },
    signal: AbortSignal.timeout(6000),
  });
  const me = await r.json().catch(() => ({}));
  if (!r.ok || !me.id) throw new Error("profile: " + r.status);
  const prof = me.kakao_account?.profile || {};
  return {
    kakaoId: String(me.id),
    nickname: clean(prof.nickname || me.properties?.nickname || "", 20),
    avatar: prof.thumbnail_image_url || prof.profile_image_url || "",
  };
}

// /api/auth/... (로그인 안 해도 접근 가능)
export async function handleAuth(req, parts) {
  const url = new URL(req.url);
  const origin = url.origin;
  const redirectUri = `${origin}/api/auth/kakao/callback`;

  // GET /api/auth/kakao?invite=코드  → 카카오 로그인 화면으로
  if (parts[1] === "kakao" && !parts[2] && req.method === "GET") {
    if (!env("KAKAO_REST_API_KEY") || !env("SESSION_SECRET")) return redirect("/#/login?error=config");
    const state = b64u(randomBytes(16));
    const invite = clean(url.searchParams.get("invite"), 40);
    const st = sign({ state, invite, exp: Date.now() + 10 * 60e3 });
    const q = new URLSearchParams({ response_type: "code", client_id: env("KAKAO_REST_API_KEY"), redirect_uri: redirectUri, state });
    return redirect(`https://kauth.kakao.com/oauth/authorize?${q}`, [cookie(STATE_COOKIE, st, 600, "/api/auth")]);
  }

  // GET /api/auth/kakao/callback?code=..&state=..
  if (parts[1] === "kakao" && parts[2] === "callback" && req.method === "GET") {
    const clearState = cookie(STATE_COOKIE, "", 0, "/api/auth");
    const st = verify(readCookie(req, STATE_COOKIE));
    if (url.searchParams.get("error")) return redirect("/#/login?error=cancel", [clearState]);
    if (!st || st.state !== url.searchParams.get("state")) return redirect("/#/login?error=state", [clearState]);
    let prof;
    try { prof = await kakaoProfile(url.searchParams.get("code"), redirectUri); }
    catch (e) { console.error("kakao login failed", e.message); return redirect("/#/login?error=kakao", [clearState]); }

    const s = store();
    const uid = "k" + prof.kakaoId;
    let u = await s.get(`users/${uid}`, { type: "json" });
    const now = new Date().toISOString();
    if (u) {
      // 카카오 프로필 사진이 바뀌었으면 따라감 (모임에서 쓰는 이름은 그대로)
      u.kakaoName = prof.nickname; u.avatar = prof.avatar; u.lastSeenAt = now;
    } else {
      const { blobs } = await s.list({ prefix: "users/" });
      let role = null, invitedBy = "";
      if (blobs.length === 0) role = "owner"; // 첫 로그인 = 방장
      else {
        const inv = await validInvite(st.invite);
        if (!inv) return redirect("/#/login?error=noinvite", [clearState]);
        role = "member"; invitedBy = inv.createdBy;
        inv.uses = (inv.uses || 0) + 1;
        await s.setJSON(`invites/${inv.code}`, inv);
      }
      u = { uid, kakaoId: prof.kakaoId, name: prof.nickname || "새 멤버", kakaoName: prof.nickname, avatar: prof.avatar, role, invitedBy, joinedAt: now, lastSeenAt: now };
    }
    await s.setJSON(`users/${uid}`, u);
    const sid = sign({ uid, exp: Date.now() + SESSION_DAYS * 864e5 });
    return redirect(u.joinedAt === now ? "/#/me?welcome=1" : "/#/", [clearState, cookie(SESSION_COOKIE, sid, SESSION_DAYS * 86400)]);
  }

  // POST /api/auth/logout
  if (parts[1] === "logout" && req.method === "POST") {
    const h = new Headers({ "content-type": "application/json" });
    h.append("set-cookie", cookie(SESSION_COOKIE, "", 0));
    return new Response('{"ok":true}', { headers: h });
  }
  return fail("없는 경로", 404);
}

// GET /api/config — 로그인 전 화면에서 필요한 공개 설정
export const handleConfig = () =>
  json({ loginReady: !!(env("KAKAO_REST_API_KEY") && env("SESSION_SECRET")), kakaoJsKey: env("KAKAO_JS_KEY") });

// /api/me — 내 정보, 이름 바꾸기
export async function handleMe(req, parts, body, user) {
  if (req.method === "GET") return json({ user: publicUser(user) });
  if (req.method === "PATCH") {
    const name = clean(body.name, 20);
    if (!name) return fail("이름을 입력해 주세요");
    user.name = name;
    await store().setJSON(`users/${user.uid}`, user);
    return json({ user: publicUser(user) });
  }
  return badMethod();
}

// /api/members — 멤버 목록(모두), 역할 변경·내보내기(운영진)
export async function handleMembers(req, parts, body, user) {
  const s = store();
  if (parts.length === 1) {
    if (req.method !== "GET") return badMethod();
    const { blobs } = await s.list({ prefix: "users/" });
    const users = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
    return json({ members: users.map(publicUser) });
  }
  const uid = parts[1];
  if (!/^k\d{1,20}$/.test(uid)) return fail("잘못된 멤버 ID");
  if (!isAdmin(user)) return fail("운영진만 할 수 있어요", 403);
  const target = await s.get(`users/${uid}`, { type: "json" });
  if (!target) return fail("멤버를 찾을 수 없어요", 404);
  if (target.role === "owner") return fail("방장은 바꾸거나 내보낼 수 없어요", 403);

  if (req.method === "PATCH") {
    if (!["admin", "member"].includes(body.role)) return fail("잘못된 역할");
    if (user.role !== "owner") return fail("운영진 지정은 방장만 할 수 있어요", 403);
    target.role = body.role;
    await s.setJSON(`users/${uid}`, target);
    return json({ member: publicUser(target) });
  }
  if (req.method === "DELETE") {
    if (target.role === "admin" && user.role !== "owner") return fail("운영진은 방장만 내보낼 수 있어요", 403);
    await s.delete(`users/${uid}`);
    return json({ ok: true });
  }
  return badMethod();
}

// /api/invites — 초대 링크 (운영진)
//   GET /api/invites/{code}/check 는 로그인 전에도 확인 가능 (handleInviteCheck)
export async function handleInvites(req, parts, body, user) {
  const s = store();
  if (!isAdmin(user)) return fail("초대는 운영진만 할 수 있어요", 403);
  if (parts.length === 1) {
    if (req.method === "GET") {
      const { blobs } = await s.list({ prefix: "invites/" });
      const all = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
      const live = all.filter((i) => Date.parse(i.expiresAt) > Date.now());
      // 만료된 링크는 정리
      await Promise.all(all.filter((i) => !live.includes(i)).map((i) => s.delete(`invites/${i.code}`)));
      return json({ invites: live.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }
    if (req.method === "POST") {
      const inv = {
        code: b64u(randomBytes(16)),
        createdBy: user.name, createdByUid: user.uid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(),
        uses: 0,
      };
      await s.setJSON(`invites/${inv.code}`, inv);
      return json({ invite: inv }, 201);
    }
    return badMethod();
  }
  if (parts.length === 2 && req.method === "DELETE") {
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(parts[1])) return fail("잘못된 초대 코드");
    await s.delete(`invites/${parts[1]}`);
    return json({ ok: true });
  }
  return fail("없는 경로", 404);
}

export async function handleInviteCheck(code) {
  const inv = await validInvite(code);
  return inv ? json({ valid: true, invitedBy: inv.createdBy, expiresAt: inv.expiresAt }) : json({ valid: false });
}

export { ROLES };
