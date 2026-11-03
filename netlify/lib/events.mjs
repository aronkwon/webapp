// 일정 (투표 → 확정 → 기록)
//   events/{id}            일정 1건 (JSON)
//   votes/{id}/{이름}      한 사람의 투표 (JSON) — 사람마다 키를 나눠서 동시 투표해도 덮어쓰지 않음
import { store, json, fail, badMethod, clean, rid, newId, ID_RE } from "./http.mjs";
import { resolveNaverPlace } from "./naver-place.mjs";
import { photoCounts, deletePhotosOf } from "./photos.mjs";

// 장소 링크 반영: 링크가 바뀌었을 때만 좌표를 다시 찾음
async function applyPlaceLink(ev, raw) {
  const input = String(raw ?? "").trim().slice(0, 1000);
  if (!input) { ev.placeUrl = ""; ev.placeLat = null; ev.placeLng = null; return null; }
  const r = await resolveNaverPlace(input);
  if (!r) return "네이버 지도 링크(naver.me 또는 map.naver.com)만 넣을 수 있어요";
  if (r.url === ev.placeUrl && ev.placeLat != null) return null;
  ev.placeUrl = r.url;
  ev.placeLat = r.lat ?? null;
  ev.placeLng = r.lng ?? null;
  if (!ev.place && r.name) ev.place = r.name.slice(0, 120);
  return null;
}




function parseCandidates(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (const c of list.slice(0, 20)) {
    const date = clean(c?.date, 10);
    const time = clean(c?.time, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    if (time && !/^\d{2}:\d{2}$/.test(time)) return null;
    out.push({ id: ID_RE.test(c?.id ?? "") ? c.id : rid(), date, time });
  }
  return out;
}

async function readVotes(s, id) {
  const { blobs } = await s.list({ prefix: `votes/${id}/` });
  const votes = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return votes.filter(Boolean);
}

export async function handleEvents(req, parts, body) {
  const s = store();
  const method = req.method;

  if (parts.length === 1) {
    if (method === "GET") {
      const [{ blobs: evKeys }, { blobs: voteKeys }] = await Promise.all([
        s.list({ prefix: "events/" }),
        s.list({ prefix: "votes/" }),
      ]);
      const voters = {};
      for (const { key } of voteKeys) {
        const eid = key.split("/")[1];
        voters[eid] = (voters[eid] || 0) + 1;
      }
      const counts = await photoCounts();
      const events = (await Promise.all(evKeys.map((b) => s.get(b.key, { type: "json" }))))
        .filter(Boolean)
        .map((e) => ({ ...e, voterCount: voters[e.id] || 0, photoCount: counts[`e-${e.id}`] || 0 }));
      return json({ events });
    }
    if (method === "POST") {
      const title = clean(body.title, 80);
      const candidates = parseCandidates(body.candidates);
      if (!title) return fail("제목을 입력하세요");
      if (!candidates) return fail("후보 날짜를 하나 이상 넣어주세요");
      const now = new Date().toISOString();
      const ev = {
        id: newId(),
        title,
        place: clean(body.place, 120),
        placeUrl: "",
        placeLat: null,
        placeLng: null,
        candidates,
        decidedId: null,
        record: "",
        createdBy: clean(body.by, 20),
        createdAt: now,
        updatedAt: now,
      };
      if ("placeUrl" in body) {
        const err = await applyPlaceLink(ev, body.placeUrl);
        if (err) return fail(err);
      }
      await s.setJSON(`events/${ev.id}`, ev);
      return json({ event: ev }, 201);
    }
    return badMethod();
  }

  const id = parts[1];
  if (!ID_RE.test(id)) return fail("잘못된 일정 ID");
  const ev = await s.get(`events/${id}`, { type: "json" });
  if (!ev) return fail("일정을 찾을 수 없어요", 404);

  // /api/events/:id/votes
  if (parts[2] === "votes") {
    if (method !== "PUT") return badMethod();
    const name = clean(body.name, 20);
    if (!name) return fail("이름이 필요해요");
    const valid = new Set(ev.candidates.map((c) => c.id));
    const choices = [...new Set(Array.isArray(body.choices) ? body.choices : [])].filter((c) => valid.has(c));
    const key = `votes/${id}/${encodeURIComponent(name)}`;
    if (choices.length === 0) await s.delete(key);
    else await s.setJSON(key, { name, choices, at: new Date().toISOString() });
    return json({ votes: await readVotes(s, id) });
  }

  // /api/events/:id
  if (method === "GET") return json({ event: ev, votes: await readVotes(s, id) });

  if (method === "PATCH") {
    if ("title" in body) {
      const t = clean(body.title, 80);
      if (!t) return fail("제목을 입력하세요");
      ev.title = t;
    }
    if ("place" in body) ev.place = clean(body.place, 120);
    if ("placeUrl" in body) {
      const err = await applyPlaceLink(ev, body.placeUrl);
      if (err) return fail(err);
    }
    if ("record" in body) ev.record = clean(body.record, 5000);
    if ("candidates" in body) {
      const c = parseCandidates(body.candidates);
      if (!c) return fail("후보 날짜를 하나 이상 넣어주세요");
      ev.candidates = c;
      if (ev.decidedId && !c.some((x) => x.id === ev.decidedId)) ev.decidedId = null;
    }
    if ("decidedId" in body) {
      if (body.decidedId !== null && !ev.candidates.some((c) => c.id === body.decidedId))
        return fail("없는 후보예요");
      ev.decidedId = body.decidedId;
    }
    ev.updatedAt = new Date().toISOString();
    await s.setJSON(`events/${id}`, ev);
    return json({ event: ev, votes: await readVotes(s, id) });
  }

  if (method === "DELETE") {
    const { blobs } = await s.list({ prefix: `votes/${id}/` });
    await Promise.all(blobs.map((b) => s.delete(b.key)));
    await deletePhotosOf(`e-${id}`);
    await s.delete(`events/${id}`);
    return json({ ok: true });
  }

  return badMethod();
}
