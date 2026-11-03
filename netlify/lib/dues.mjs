// 회비 내역 (입출금 장부)
//   dues/{id}   한 건 (JSON): type(in|out), date(YYYY-MM-DD), amount(원, 양수), memo, name, by, createdAt, updatedAt
// 건마다 키를 나눠서 여러 명이 동시에 적어도 서로 덮어쓰지 않음.
// 월별 합계·이월 잔액은 화면에서 전체 내역으로 계산 (친구 모임 규모면 충분히 가벼움)
import { store, json, fail, badMethod, clean, newId, ID_RE, readAll } from "./http.mjs";

const MAX_AMOUNT = 100_000_000;

function parseEntry(body, base = {}) {
  const e = { ...base };
  if ("type" in body || !base.type) {
    if (!["in", "out"].includes(body.type)) return "입금/출금을 골라주세요";
    e.type = body.type;
  }
  if ("date" in body || !base.date) {
    const d = clean(body.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) return "날짜를 확인해 주세요";
    e.date = d;
  }
  if ("amount" in body || !base.amount) {
    const a = Math.round(Number(body.amount));
    if (!Number.isFinite(a) || a <= 0) return "금액을 입력해 주세요";
    if (a > MAX_AMOUNT) return "금액이 너무 커요";
    e.amount = a;
  }
  if ("memo" in body) e.memo = clean(body.memo, 100);
  if ("name" in body) e.name = clean(body.name, 20);
  if (!e.memo) return "내용을 입력해 주세요";
  return e;
}

export async function handleDues(req, parts, body) {
  const s = store();
  const method = req.method;

  if (parts.length === 1) {
    if (method === "GET") return json({ entries: await readAll(s, "dues/") });
    if (method === "POST") {
      const e = parseEntry(body);
      if (typeof e === "string") return fail(e);
      const now = new Date().toISOString();
      Object.assign(e, { id: newId(), name: e.name || "", by: clean(body.by, 20), createdAt: now, updatedAt: now });
      await s.setJSON(`dues/${e.id}`, e);
      return json({ entry: e }, 201);
    }
    return badMethod();
  }

  const id = parts[1];
  if (!ID_RE.test(id)) return fail("잘못된 내역 ID");
  const cur = await s.get(`dues/${id}`, { type: "json" });
  if (!cur) return fail("내역을 찾을 수 없어요", 404);

  if (method === "GET") return json({ entry: cur });
  if (method === "PATCH") {
    const e = parseEntry(body, cur);
    if (typeof e === "string") return fail(e);
    e.updatedAt = new Date().toISOString();
    await s.setJSON(`dues/${id}`, e);
    return json({ entry: e });
  }
  if (method === "DELETE") {
    await s.delete(`dues/${id}`);
    return json({ ok: true });
  }
  return badMethod();
}
