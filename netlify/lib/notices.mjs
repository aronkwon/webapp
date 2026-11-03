// 공지
//   notices/{id}   공지 1건 (JSON): title, body, pinned, by, createdAt, updatedAt
import { store, json, fail, badMethod, clean, newId, ID_RE, readAll } from "./http.mjs";
import { photoCounts, deletePhotosOf } from "./photos.mjs";

export async function handleNotices(req, parts, body, user) {
  const s = store();
  const method = req.method;

  if (parts.length === 1) {
    if (method === "GET") {
      const [notices, counts] = await Promise.all([readAll(s, "notices/"), photoCounts()]);
      return json({ notices: notices.map((n) => ({ ...n, photoCount: counts[`n-${n.id}`] || 0 })) });
    }
    if (method === "POST") {
      const title = clean(body.title, 100);
      if (!title) return fail("제목을 입력하세요");
      const now = new Date().toISOString();
      const n = {
        id: newId(), title,
        body: clean(body.body, 5000),
        pinned: !!body.pinned,
        by: user.name, byUid: user.uid,
        createdAt: now, updatedAt: now,
      };
      await s.setJSON(`notices/${n.id}`, n);
      return json({ notice: n }, 201);
    }
    return badMethod();
  }

  const id = parts[1];
  if (!ID_RE.test(id)) return fail("잘못된 공지 ID");
  const n = await s.get(`notices/${id}`, { type: "json" });
  if (!n) return fail("공지를 찾을 수 없어요", 404);

  if (method === "GET") return json({ notice: n });
  if (method === "PATCH") {
    if ("title" in body) {
      const t = clean(body.title, 100);
      if (!t) return fail("제목을 입력하세요");
      n.title = t;
    }
    if ("body" in body) n.body = clean(body.body, 5000);
    if ("pinned" in body) n.pinned = !!body.pinned;
    n.updatedAt = new Date().toISOString();
    await s.setJSON(`notices/${id}`, n);
    return json({ notice: n });
  }
  if (method === "DELETE") {
    await deletePhotosOf(`n-${id}`);
    await s.delete(`notices/${id}`);
    return json({ ok: true });
  }
  return badMethod();
}
