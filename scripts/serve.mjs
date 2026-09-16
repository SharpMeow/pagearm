import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join, extname } from "path";
import { fileURLToPath } from "url";
import { packExtension } from "./pack.mjs";
import { wrapAgent } from "./wrap.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8787);
const currentPath = join(root, "agents/current.js");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function loadAgent() {
  if (existsSync(currentPath)) return readFileSync(currentPath, "utf8");
  return readFileSync(join(root, "agents/hello.js"), "utf8");
}

function originFrom(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `127.0.0.1:${port}`;
  return `${proto}://${host}`;
}

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function parseHosts(raw) {
  return String(raw || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", originFrom(req));

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/agent.js") {
    send(res, 200, wrapAgent(loadAgent()), "text/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/agent" && req.method === "GET") {
    send(res, 200, JSON.stringify({ source: loadAgent() }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/agent" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      send(res, 400, "bad json");
      return;
    }
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(currentPath, String(body.source || ""), "utf8");
    send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/examples") {
    const names = ["hello.js", "highlight-headings.js", "outline-forms.js", "reading-ruler.js"];
    const examples = names.map((name) => ({
      id: name.replace(/\.js$/, ""),
      name,
      source: readFileSync(join(root, "agents", name), "utf8"),
    }));
    send(res, 200, JSON.stringify({ examples }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/extension.zip") {
    const hosts = parseHosts(url.searchParams.get("hosts") || "");
    const zip = packExtension({
      origin: originFrom(req),
      hosts,
      agentSource: loadAgent(),
    });
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="pagearm-extension.zip"',
      "Cache-Control": "no-store",
    });
    res.end(Buffer.from(zip));
    return;
  }

  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  if (file.includes("..")) {
    send(res, 400, "bad path");
    return;
  }
  const abs = join(root, "desk", file);
  if (!abs.startsWith(join(root, "desk")) || !existsSync(abs)) {
    send(res, 404, "not found");
    return;
  }
  send(res, 200, readFileSync(abs), TYPES[extname(abs)] || "application/octet-stream");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`PageArm desk http://127.0.0.1:${port}`);
});
