// 네이버 지도 링크 → { url, name, lat, lng }
// 지원 형태
//   https://naver.me/xxxx                       (앱 공유 단축 링크, 리다이렉트 따라감)
//   https://map.naver.com/p/entry/place/123456  (PC 지도)
//   https://map.naver.com/p/search/강남역/place/123456?c=...
//   https://m.place.naver.com/restaurant/123456/home
//   앱의 공유 텍스트 통째로 ("[네이버지도]\n장소명\n주소\nhttps://naver.me/...")
// 좌표를 못 찾으면 lat/lng 없이 링크만 돌려줌 (지도 미리보기만 빠지고 링크는 동작)

const ALLOWED = /(^|\.)naver\.(me|com)$/i;
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const inKorea = (lat, lng) => lat > 32 && lat < 39.5 && lng > 124 && lng < 132.5;

// 웹 메르카토르(EPSG:3857) → 위경도
function mercToLatLng(x, y) {
  const lng = (x / 20037508.34) * 180;
  const lat = (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90;
  return { lat, lng };
}

export function extractUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0].replace(/[)\].,]+$/, "") : null;
}

// "[네이버지도]\n장소명\n주소\n링크" 형태에서 장소명
export function extractShareName(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => /^\[?네이버\s*지도\]?$/.test(l));
  if (i >= 0 && lines[i + 1] && !/^https?:/.test(lines[i + 1])) return lines[i + 1];
  return "";
}

export function placeIdFrom(url) {
  const m =
    url.match(/\/place\/(\d{4,})/) ||
    url.match(/\/(?:restaurant|cafe|hairshop|nailshop|hospital|pharmacy|accommodation|attraction|place)\/(\d{4,})/) ||
    url.match(/[?&](?:id|placeId)=(\d{4,})/);
  return m ? m[1] : null;
}

export function coordsFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const q = u.searchParams;
  const lat = parseFloat(q.get("lat")), lng = parseFloat(q.get("lng") ?? q.get("lon"));
  if (inKorea(lat, lng)) return { lat, lng };
  const c = q.get("c");
  if (c) {
    const [a, b] = c.split(",").map(parseFloat);
    if (inKorea(b, a)) return { lat: b, lng: a };
    if (a > 1e6 && b > 1e6) { const p = mercToLatLng(a, b); if (inKorea(p.lat, p.lng)) return p; }
  }
  return null;
}

// 장소 페이지 HTML에서 좌표/이름 뽑기
export function parsePlaceHtml(html) {
  const out = {};
  const pats = [
    /"x"\s*:\s*"?(1[23]\d\.\d+)"?\s*,\s*"y"\s*:\s*"?(3\d\.\d+)"?/,
    /"mapx"\s*:\s*"?(1[23]\d\.\d+)"?\s*,\s*"mapy"\s*:\s*"?(3\d\.\d+)"?/,
    /"longitude"\s*:\s*"?(1[23]\d\.\d+)"?\s*,\s*"latitude"\s*:\s*"?(3\d\.\d+)"?/,
    /center=(1[23]\d\.\d+)(?:%2C|,)(3\d\.\d+)/,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m && inKorea(+m[2], +m[1])) { out.lat = +m[2]; out.lng = +m[1]; break; }
  }
  if (out.lat == null) {
    const m = html.match(/"y"\s*:\s*"?(3\d\.\d+)"?\s*,\s*"x"\s*:\s*"?(1[23]\d\.\d+)"?/) ||
      html.match(/"latitude"\s*:\s*"?(3\d\.\d+)"?\s*,\s*"longitude"\s*:\s*"?(1[23]\d\.\d+)"?/);
    if (m && inKorea(+m[1], +m[2])) { out.lat = +m[1]; out.lng = +m[2]; }
  }
  const t = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (t) {
    const name = t[1].replace(/\s*[:\-|]\s*네이버.*$/, "").trim();
    if (name && !/^네이버/.test(name)) out.name = name;
  }
  return out;
}

const allowed = (url) => { try { return ALLOWED.test(new URL(url).hostname); } catch { return false; } };

async function get(url, manual) {
  return fetch(url, {
    redirect: manual ? "manual" : "follow",
    headers: { "user-agent": UA, "accept-language": "ko-KR,ko;q=0.9" },
    signal: AbortSignal.timeout(4000),
  });
}

export async function resolveNaverPlace(input) {
  const url = extractUrl(input);
  if (!url || !allowed(url)) return null;
  const result = { url, name: extractShareName(input) };

  // 1) 리다이렉트를 하나씩 따라가며 중간 주소에서 좌표·장소ID 찾기 (naver 도메인만)
  let cur = url, placeId = placeIdFrom(url), coords = coordsFromUrl(url);
  try {
    for (let hop = 0; hop < 5 && !coords; hop++) {
      if (!/naver\.me$/i.test(new URL(cur).hostname) && placeId) break;
      const r = await get(cur, true);
      const loc = r.headers.get("location");
      if (!loc || r.status < 300 || r.status >= 400) break;
      const next = new URL(loc, cur).toString();
      if (!allowed(next)) break;
      cur = next;
      placeId ||= placeIdFrom(cur);
      coords ||= coordsFromUrl(cur);
    }
  } catch {}

  // 2) 장소 페이지에서 좌표·이름 읽기
  if (placeId) {
    try {
      const r = await get(`https://m.place.naver.com/place/${placeId}/home`);
      if (r.ok) {
        const p = parsePlaceHtml(await r.text());
        coords ||= p.lat != null ? { lat: p.lat, lng: p.lng } : null;
        result.name ||= p.name || "";
      }
    } catch {}
  }
  if (coords) { result.lat = +coords.lat.toFixed(6); result.lng = +coords.lng.toFixed(6); }
  return result;
}
