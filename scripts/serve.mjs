import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join, extname, resolve } from "path";
import { fileURLToPath } from "url";
import { Script } from "vm";
import { packExtension, normalizeTarget, zipName } from "./pack.mjs";
import { wrapAgent } from "./wrap.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8787);
// Loopback only. The desk holds an unauthenticated "replace the code that runs
// in my logged-in tabs" endpoint. That is not something to hand the coffee shop.
const host = process.env.HOST || "127.0.0.1";
const currentPath = join(root, "agents/current.js");
const MAX_BODY = 1024 * 1024;

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
  const h = req.headers.host || `127.0.0.1:${port}`;
  return `${proto}://${h}`;
}

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseHosts(raw) {
  return String(raw || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Only a loopback Host header is honored. A DNS-rebound name pointing at
// 127.0.0.1 shows up here as evil.example, and we do not serve it.
function loopbackHost(req) {
  const h = String(req.headers.host || "");
  const name = h.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

// The desk page is the only thing that writes. A cross-site page cannot, even
// though it can reach 127.0.0.1 from the same browser.
function sameSite(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin && origin !== originFrom(req)) return false;
  return true;
}

// Compile the wrapped agent before saving it. A syntax error caught here is a
// 400 with a line number, not a silent fallback to the packed copy in every tab.
export function compileError(source) {
  try {
    new Script(wrapAgent(source), { filename: "agent.js" });
    return null;
  } catch (e) {
    return String(e && e.message ? e.message : e);
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error("too big");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  if (!loopbackHost(req)) {
    send(res, 403, "desk answers to 127.0.0.1 only");
    return;
  }
  const url = new URL(req.url || "/", originFrom(req));

  if (url.pathname === "/agent.js") {
    send(res, 200, wrapAgent(loadAgent()), "text/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/agent" && req.method === "GET") {
    send(res, 200, JSON.stringify({ source: loadAgent() }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/agent" && req.method === "POST") {
    if (!sameSite(req)) {
      send(res, 403, "only the desk may save");
      return;
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      send(res, e && e.message === "too big" ? 413 : 400, e && e.message === "too big" ? "too big" : "bad json");
      return;
    }
    const source = String(body.source || "");
    const err = compileError(source);
    if (err) {
      send(res, 400, JSON.stringify({ ok: false, error: err }), "application/json; charset=utf-8");
      return;
    }
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(currentPath, source, "utf8");
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
    // Same shell, one manifest per house. Default to Chromium because that is
    // what most people have open, but the desk asks before it hands one over.
    const target = normalizeTarget(url.searchParams.get("browser") || "chromium");
    const zip = packExtension({
      origin: originFrom(req),
      hosts,
      agentSource: loadAgent(),
      target,
    });
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName(target)}"`,
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

// Only listen when run directly. check.mjs imports this file for compileError.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(port, host, () => {
    console.log(`PageArm desk http://${host}:${port}`);
  });
}
