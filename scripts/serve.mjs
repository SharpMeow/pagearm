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
// The drawer is a shelf, not a warehouse. Many scripts sit here, and the stack
// says which ones are the agent, in order. Usually that is one name. Changing
// the stack changes the body of /agent.js, which changes its hash, which is the
// whole hot-swap. The browser never learns that any of this happened.
const drawerDir = join(root, "agents/drawer");
const livePath = join(root, "agents/current.json");
const MAX_BODY = 1024 * 1024;
const MAX_STACK = 16;

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

// The stack is read back through the same door it was written: a name that is
// no longer a file, or was never a legal name, is simply not in the stack.
export function loadStack() {
  let raw = [];
  try {
    const saved = JSON.parse(readFileSync(livePath, "utf8"));
    if (Array.isArray(saved.stack)) raw = saved.stack;
    // A desk that last ran the one-script version wrote { name }. Read it once
    // and it becomes a stack of one the next time anything saves.
    else if (saved.name) raw = [saved.name];
  } catch (e) {
    raw = [];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw.slice(0, MAX_STACK)) {
    const name = drawerName(item);
    if (!name || seen.has(name)) continue;
    const abs = drawerPath(name);
    if (!abs || !existsSync(abs)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function setStack(names) {
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(livePath, JSON.stringify({ stack: names || [] }) + "\n", "utf8");
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

// What the desk is serving, in order. A stack with names in it reads the drawer
// files themselves, so saving one of them is already the live change and there
// is no second copy to keep in step. An empty stack means the scratch pad in
// the textarea, which is where a desk with no drawer yet lives.
export function liveSources() {
  const stack = loadStack();
  if (!stack.length) return [{ name: "agent", source: loadAgent() }];
  return stack.map((name) => ({ name, source: readFileSync(drawerPath(name), "utf8") }));
}

// The editor holds one script. Open the top of the stack if there is one, the
// scratch pad if there is not.
function editorSource() {
  const stack = loadStack();
  if (!stack.length) return { source: loadAgent(), bound: null };
  return { source: readFileSync(drawerPath(stack[0]), "utf8"), bound: stack[0] };
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
    send(res, 200, wrapAgent(liveSources()), "text/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/agent" && req.method === "GET") {
    const open = editorSource();
    send(res, 200, JSON.stringify({ source: open.source, bound: open.bound, stack: loadStack() }), "application/json; charset=utf-8");
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
    // An editor bound to a drawer script writes that file, and a script already
    // in the stack stays where it is instead of kicking its neighbors out. An
    // unbound editor is a scratch pad, and saving it is the whole agent.
    const bound = body.name === undefined || body.name === null || body.name === "" ? null : drawerName(body.name);
    if (body.name && !bound) {
      send(res, 400, JSON.stringify({ ok: false, error: "bad drawer name" }), "application/json; charset=utf-8");
      return;
    }
    if (!bound) {
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(currentPath, source, "utf8");
      setStack([]);
      send(res, 200, JSON.stringify({ ok: true, bound: null, stack: [] }), "application/json; charset=utf-8");
      return;
    }
    mkdirSync(drawerDir, { recursive: true });
    writeFileSync(drawerPath(bound), source, "utf8");
    if (!loadStack().includes(bound)) setStack([bound]);
    send(res, 200, JSON.stringify({ ok: true, bound, stack: loadStack() }), "application/json; charset=utf-8");
    return;
  }

  // The stack: which drawer scripts are the agent, in the order they run.
  if (url.pathname === "/api/stack" && req.method === "POST") {
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
    const asked = Array.isArray(body.names) ? body.names : [];
    if (asked.length > MAX_STACK) {
      send(res, 400, JSON.stringify({ ok: false, error: "that is more scripts than one agent should carry" }), "application/json; charset=utf-8");
      return;
    }
    const names = [];
    for (const item of asked) {
      const name = drawerName(item);
      const abs = name && drawerPath(name);
      if (!abs || !existsSync(abs)) {
        send(res, 400, JSON.stringify({ ok: false, error: "not in the drawer: " + String(item) }), "application/json; charset=utf-8");
        return;
      }
      if (!names.includes(name)) names.push(name);
    }
    // Compile the whole stack, not each script alone. They end up in one file,
    // so this is the only check that matches what the browser will parse.
    const err = compileError(names.map((name) => ({ name, source: readFileSync(drawerPath(name), "utf8") })));
    if (err) {
      send(res, 400, JSON.stringify({ ok: false, error: err }), "application/json; charset=utf-8");
      return;
    }
    setStack(names);
    send(res, 200, JSON.stringify({ ok: true, stack: loadStack(), scripts: drawerList() }), "application/json; charset=utf-8");
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
      send(res, 200, JSON.stringify({ stack: loadStack(), scripts: drawerList() }), "application/json; charset=utf-8");
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
      // A script that was in the stack drops out of it, because the drawer file
      // is what the desk serves now. Tabs keep the copy they already have until
      // the next navigation, which is the same promise as any other save.
      const left = loadStack().filter((n) => n !== name);
      setStack(left);
      send(res, 200, JSON.stringify({ ok: true, stack: loadStack(), scripts: drawerList() }), "application/json; charset=utf-8");
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
      // "Make it the agent" means this one and nothing else. Adding a script to
      // a stack without evicting the others goes through /api/stack.
      setStack([name]);
      send(res, 200, JSON.stringify({ ok: true, name, source, stack: loadStack() }), "application/json; charset=utf-8");
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
    // A script in the stack is served from this very file, so saving it is
    // already the live change. Nothing to copy, nothing to fall out of step.
    const armed = loadStack().includes(name);
    send(res, 200, JSON.stringify({ ok: true, name, stack: loadStack(), armed, scripts: drawerList() }), "application/json; charset=utf-8");
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
      agentSource: liveSources(),
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
