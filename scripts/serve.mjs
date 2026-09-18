import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { dirname, join, extname, resolve, sep } from "path";
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
// The drawer is a shelf, not a warehouse. Many scripts sit here, exactly one is
// live. Promoting one rewrites current.js, which changes the hash the browser
// fetches, which is the whole hot-swap.
const drawerDir = join(root, "agents/drawer");
const livePath = join(root, "agents/current.json");
const MAX_BODY = 1024 * 1024;

// A drawer name becomes a filename, so it gets to be dull on purpose. No dots,
// no slashes, nothing that could climb out of the folder. Lowercased, because a
// Mac and a Windows box would treat Foo and foo as one file anyway.
const DRAWER_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function drawerName(raw) {
  const name = String(raw || "").trim().toLowerCase();
  return DRAWER_NAME.test(name) ? name : null;
}

function drawerPath(name) {
  const abs = join(drawerDir, name + ".js");
  // Belt and suspenders. The regex already refused anything with a separator.
  if (!abs.startsWith(drawerDir + sep)) return null;
  return abs;
}

// The pointer says which drawer script current.js was copied from. It is a
// claim about provenance, so it is dropped the moment it stops being true.
function liveName() {
  try {
    const name = drawerName(JSON.parse(readFileSync(livePath, "utf8")).name);
    if (!name) return null;
    const abs = drawerPath(name);
    return abs && existsSync(abs) ? name : null;
  } catch (e) {
    return null;
  }
}

function setLiveName(name) {
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(livePath, JSON.stringify({ name: name || null }) + "\n", "utf8");
}

export function drawerList() {
  if (!existsSync(drawerDir)) return [];
  return readdirSync(drawerDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.slice(0, -3))
    .filter((n) => drawerName(n) === n)
    .sort()
    .map((name) => {
      let at = 0;
      try { at = statSync(drawerPath(name)).mtimeMs; } catch (e) {}
      return { name, at };
    });
}

// Writing the agent and writing the drawer are one act when the editor is bound
// to a drawer script, so the two never drift apart behind your back.
function writeAgent(source, name) {
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(currentPath, source, "utf8");
  if (name) {
    mkdirSync(drawerDir, { recursive: true });
    writeFileSync(drawerPath(name), source, "utf8");
  }
  setLiveName(name || null);
}

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

// Exported so check.mjs can drive the routes without a shell and a port guess.
export const server = createServer(async (req, res) => {
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
    send(res, 200, JSON.stringify({ source: loadAgent(), live: liveName() }), "application/json; charset=utf-8");
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
    // An editor bound to a drawer script says so, and the save lands in both
    // places. An unbound editor is a scratch pad and clears the pointer.
    const bound = body.name === undefined || body.name === null || body.name === "" ? null : drawerName(body.name);
    if (body.name && !bound) {
      send(res, 400, JSON.stringify({ ok: false, error: "bad drawer name" }), "application/json; charset=utf-8");
      return;
    }
    writeAgent(source, bound);
    send(res, 200, JSON.stringify({ ok: true, live: bound }), "application/json; charset=utf-8");
    return;
  }

  // The drawer. GET the shelf, GET one script, POST to save one, POST .../live
  // to make one the current agent, DELETE to throw one out.
  const drawer = /^\/api\/drawer(?:\/([^/]+))?(\/live)?$/.exec(url.pathname);
  if (drawer) {
    if (req.method !== "GET" && !sameSite(req)) {
      send(res, 403, "only the desk may save");
      return;
    }
    let raw = drawer[1];
    try { raw = raw === undefined ? undefined : decodeURIComponent(raw); } catch (e) { raw = ""; }
    const promote = !!drawer[2];

    if (raw === undefined) {
      if (promote || req.method !== "GET") {
        send(res, 405, "not that way");
        return;
      }
      send(res, 200, JSON.stringify({ live: liveName(), scripts: drawerList() }), "application/json; charset=utf-8");
      return;
    }

    const name = drawerName(raw);
    const abs = name && drawerPath(name);
    if (!abs) {
      send(res, 400, JSON.stringify({ ok: false, error: "a drawer name is letters, digits, dash, underscore" }), "application/json; charset=utf-8");
      return;
    }

    if (req.method === "GET") {
      if (promote || !existsSync(abs)) {
        send(res, 404, JSON.stringify({ ok: false, error: "no such script" }), "application/json; charset=utf-8");
        return;
      }
      send(res, 200, JSON.stringify({ name, source: readFileSync(abs, "utf8") }), "application/json; charset=utf-8");
      return;
    }

    if (req.method === "DELETE") {
      if (promote || !existsSync(abs)) {
        send(res, 404, JSON.stringify({ ok: false, error: "no such script" }), "application/json; charset=utf-8");
        return;
      }
      rmSync(abs);
      // The live agent keeps running. Only the claim that it came from this
      // drawer script goes away, because that script no longer exists.
      if (liveName() === name) setLiveName(null);
      send(res, 200, JSON.stringify({ ok: true, live: liveName(), scripts: drawerList() }), "application/json; charset=utf-8");
      return;
    }

    if (req.method !== "POST") {
      send(res, 405, "not that way");
      return;
    }

    // Promote: the saved script becomes the current agent. One file copy, and
    // the next navigation in any tab sees a new hash and swaps.
    if (promote) {
      if (!existsSync(abs)) {
        send(res, 404, JSON.stringify({ ok: false, error: "no such script" }), "application/json; charset=utf-8");
        return;
      }
      const source = readFileSync(abs, "utf8");
      const err = compileError(source);
      if (err) {
        send(res, 400, JSON.stringify({ ok: false, error: err }), "application/json; charset=utf-8");
        return;
      }
      writeAgent(source, name);
      send(res, 200, JSON.stringify({ ok: true, name, source, live: name }), "application/json; charset=utf-8");
      return;
    }

    let saved = {};
    try {
      saved = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      send(res, e && e.message === "too big" ? 413 : 400, e && e.message === "too big" ? "too big" : "bad json");
      return;
    }
    const source = String(saved.source || "");
    const err = compileError(source);
    if (err) {
      send(res, 400, JSON.stringify({ ok: false, error: err }), "application/json; charset=utf-8");
      return;
    }
    mkdirSync(drawerDir, { recursive: true });
    writeFileSync(abs, source, "utf8");
    // Saving over the script that is live keeps the live agent honest: the
    // pointer means current.js is a copy of this file, so make that true.
    const wasLive = liveName() === name;
    if (wasLive) writeAgent(source, name);
    send(res, 200, JSON.stringify({ ok: true, name, live: liveName(), armed: wasLive, scripts: drawerList() }), "application/json; charset=utf-8");
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
