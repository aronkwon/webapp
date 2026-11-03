// 로컬 개발 서버: node dev-server.mjs .blobs  →  http://localhost:8888
// (Netlify 로그인 없이 API + 정적 파일을 함께 띄움, 데이터는 .blobs 폴더에 저장)
import { BlobsServer } from "@netlify/blobs/server";
import http from "node:http";
const dir = process.argv[2];
const server = new BlobsServer({ directory: dir, token: "tok", port: 0 });
const { port } = await server.start();
const url = `http://localhost:${port}`;
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: url, uncachedEdgeURL: url, siteID: "local", token: "tok" })).toString("base64");
const { default: handler } = await import("./netlify/functions/api.mjs");
// tiny dev server: /api/* -> handler, else static from public/
import fs from "node:fs"; import path from "node:path";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" };
http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handler(new Request("http://x" + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let p = path.join("public", decodeURIComponent(req.url.split("?")[0])); if (p.endsWith("/")) p += "index.html";
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { "content-type": types[path.extname(p)] || "text/plain" }); res.end(d); } });
}).listen(8888, () => console.log("ready"));
