import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { dirname, join, extname, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { Script } from "vm";
import { packExtension, normalizeTarget, zipName } from "./pack.mjs";
import { pngGlyph } from "./zip.mjs";
import { wrapAgent } from "./wrap.mjs";
import { compileLook } from "./look.mjs";

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
const stackPath = join(root, "agents/stack.json");
// What the file was called when it held one name. Read once, then forgotten.
const oldStackPath = join(root, "agents/current.json");
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
    const saved = JSON.parse(readFileSync(existsSync(stackPath) ? stackPath : oldStackPath, "utf8"));
    if (Array.isArray(saved.stack)) raw = saved.stack;
    // A desk that last ran the one-script version wrote { name } into
    // current.json. Read it once and the next save writes stack.json instead.
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
  writeFileSync(stackPath, JSON.stringify({ stack: names || [] }) + "\n", "utf8");
  // Tidy up after the desk that used the old name, so the two cannot disagree.
  try {
    if (existsSync(oldStackPath)) rmSync(oldStackPath);
  } catch (e) {}
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
  try {
    if (existsSync(currentPath)) return readFileSync(currentPath, "utf8");
  } catch (e) {}
  try {
    return readFileSync(join(root, "agents/hello.js"), "utf8");
  } catch (e) {
    // Even with nothing to read, the desk answers. An agent with no scripts
    // arms, pips, and waits for you.
    return "";
  }
}

// A drawer file can go away between the moment the stack is read and the moment
// it is served. You delete them from a shell; that is allowed.
function readScript(name) {
  try {
    return readFileSync(drawerPath(name), "utf8");
  } catch (e) {
    console.warn("[desk] leaving " + name + " out: " + (e && e.message ? e.message : e));
    return null;
  }
}

// What the desk is serving, in order. A stack with names in it reads the drawer
// files themselves, so saving one of them is already the live change and there
// is no second copy to keep in step. An empty stack means the scratch pad in
// the textarea, which is where a desk with no drawer yet lives.
export function liveSources() {
  const out = [];
  for (const name of loadStack()) {
    const source = readScript(name);
    if (source !== null) out.push({ name, source });
  }
  if (!out.length) return [{ name: "agent", source: loadAgent() }];
  return out;
}

// The editor holds one script. Open the top of the stack if there is one, the
// scratch pad if there is not.
function editorSource() {
  const stack = loadStack();
  if (stack.length) {
    const source = readScript(stack[0]);
    if (source !== null) return { source, bound: stack[0] };
  }
  return { source: loadAgent(), bound: null };
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

// The last few throws the agent hit out in the world. In memory on purpose:
// this is a workshop light, not a log file, and it should not outlive the desk.
const MAX_OOPS = 10;
let oopsLog = [];
const MAX_MUST = 20;
let mustLog = [];
const MAX_ASK_ANSWERS = 10;
let askState = { pending: null, answers: {} };
const MAX_LOOK = 200;
let lookState = { recording: false, steps: [] };

function clamp(value, max) {
  return String(value === undefined || value === null ? "" : value).slice(0, max);
}

function rememberAnswer(id, answer) {
  const key = clamp(id, 80);
  if (!key) return;
  askState.answers[key] = String(answer == null ? "" : answer).slice(0, 300);
  const keys = Object.keys(askState.answers);
  while (keys.length > MAX_ASK_ANSWERS) {
    delete askState.answers[keys.shift()];
  }
  if (askState.pending && askState.pending.id === key) askState.pending = null;
}

const SAMPLE_SKETCH = [
  "Sample receiving page used by Prove.",
  "#vessel #catch #stone #grade #berth #hold #notes",
  "#save-claim ignores a naked click; punch it. paints #receipt",
  "#lots tbody tr with data-lot data-vessel data-catch data-stone data-grade",
  "#arrive appends a row",
  "#pay and #amount live in open shadow on wharf-till",
  "#paid is the till receipt",
  "#clerk-log",
].join("\n");

const AGENT_API = [
  "You write PageArm agent scripts. A script assigns agent.arm.",
  "",
  "API:",
  "- agent.q(sel, root?) querySelector, pierces open shadow roots and same-origin iframes",
  "- agent.qa(sel, root?) querySelectorAll as array, same pierce",
  "- agent.click(el) naked click",
  "- agent.punch(el) composed pointer+mouse+click. Use this on stubborn buttons and anything in shadow.",
  "- agent.type(el, text) prototype setter plus InputEvent insertText. Works on React/Vue and shadow inputs.",
  "- agent.wait(ms) Promise",
  "- agent.pip(state, mark?) idle|work|ok|err",
  "- agent.capture() viewport snapshot",
  "- agent.match current host+path",
  "- agent.onCleanup(fn) run before the next arm. Unregister listeners here.",
  "- agent.watch(sel, fn) MutationObserver, auto-cleaned.",
  "- agent.when(sel, fn) fires only for nodes that appear after arm.",
  "- agent.must(sel, note?) assert the selector exists and is not hidden. Call this on the success condition.",
  "- agent.ask(prompt, choices[]) Promise. The desk answers. Do not fake the answer.",
  "",
  "Rules:",
  "- agent.arm may be async. The runtime awaits it.",
  "- Write it idempotent. arm() can run twice on one load.",
  "- American English. No em dashes. Return ONLY the JavaScript source.",
  "- Prefer stable ids (#vessel) over brittle nth-child.",
  "- If a control might ignore .click, punch it.",
].join("\n");

function stripFence(text) {
  const m = String(text || "").match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : String(text || "")).trim();
}

async function chatXai(messages, maxTokens) {
  const key = process.env.XAI_API_KEY;
  if (!key) return { ok: false, status: 503, error: "set XAI_API_KEY to let the desk write" };
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
    },
    body: JSON.stringify({
      model: "grok-4.5",
      messages,
      max_tokens: maxTokens || 900,
      temperature: 0.2,
    }),
  });
  if (!r.ok) return { ok: false, status: 502, error: "xAI API error " + r.status };
  let body = {};
  try { body = await r.json(); } catch (e) { return { ok: false, status: 502, error: "xAI API sent junk" }; }
  const text = body && body.choices && body.choices[0] && body.choices[0].message
    ? body.choices[0].message.content
    : "";
  return { ok: true, text: String(text || "") };
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

// The shell writes here too, and it is not same-origin with the desk. Its
// Origin is an extension scheme, which a web page cannot forge, so a site you
// visit still cannot fill this with noise.
function fromShell(req) {
  if (/^(chrome|moz|safari-web)-extension:\/\//.test(String(req.headers.origin || ""))) return true;
  return sameSite(req);
}

// Where the human's first line lands inside the wrapper. Measured from the
// wrapper itself, so it stays right when wrap.mjs grows a line.
const BODY_OFFSET = (function () {
  const mark = "__pa_where_does_this_land__";
  const at = wrapAgent(mark).split("\n").findIndex((l) => l.indexOf(mark) >= 0);
  return at < 0 ? 0 : at;
})();

// wrapAgent trims, so blank lines above the code would otherwise shift the count.
function leadingLines(source) {
  const text = String(source);
  const head = text.slice(0, text.length - text.trimStart().length);
  return (head.match(/\n/g) || []).length;
}

function brokenLine(err, source) {
  const m = /agent\.js:(\d+)/.exec(String((err && err.stack) || ""));
  if (!m) return 0;
  const line = Number(m[1]) - BODY_OFFSET + leadingLines(source);
  if (line < 1) return 0;
  // An unterminated bracket is reported at end of input, which is the wrapper's
  // line, not yours. Point at your last line instead: it is the one to look at,
  // and it is one the editor can actually put a cursor on.
  const last = String(source).split("\n").length;
  return line > last ? last : line;
}

// Compile the wrapped agent before saving it. A syntax error caught here is a
// 400 with a line number, not a silent fallback to the packed copy in every tab.
export function compileError(source) {
  try {
    new Script(wrapAgent(source), { filename: "agent.js" });
    return null;
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    // Only one script can be pointed at a line in the editor. A stack is many
    // files in one, and a guess there would be worse than no number at all.
    const line = typeof source === "string" ? brokenLine(e, source) : 0;
    return line ? msg + " (line " + line + ")" : msg;
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

async function handle(req, res) {
  if (!loopbackHost(req)) {
    send(res, 403, "desk answers to 127.0.0.1 only");
    return;
  }
  const url = new URL(req.url || "/", originFrom(req));

  if (url.pathname === "/favicon.png" || url.pathname === "/favicon.ico") {
    // Same glyph the toolbar wears, painted by the same three lines of PNG.
    send(res, 200, Buffer.from(pngGlyph(32, [184, 255, 60], "P")), "image/png");
    return;
  }

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

  if (url.pathname === "/api/oops") {
    if (req.method === "GET") {
      send(res, 200, JSON.stringify({ errors: oopsLog }), "application/json; charset=utf-8");
      return;
    }
    if (req.method === "DELETE") {
      if (!sameSite(req)) {
        send(res, 403, "only the desk may clear that");
        return;
      }
      oopsLog = [];
      send(res, 200, JSON.stringify({ ok: true, errors: oopsLog }), "application/json; charset=utf-8");
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, "not that way");
      return;
    }
    if (!fromShell(req)) {
      send(res, 403, "only the shell may report that");
      return;
    }
    let told = {};
    try {
      told = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      send(res, e && e.message === "too big" ? 413 : 400, e && e.message === "too big" ? "too big" : "bad json");
      return;
    }
    oopsLog.unshift({
      script: clamp(told.script, 80),
      message: clamp(told.message, 300),
      where: clamp(told.where, 200),
      at: Date.now(),
    });
    oopsLog = oopsLog.slice(0, MAX_OOPS);
    send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/must") {
    if (req.method === "GET") {
      send(res, 200, JSON.stringify({ musts: mustLog }), "application/json; charset=utf-8");
      return;
    }
    if (req.method === "DELETE") {
      if (!sameSite(req)) {
        send(res, 403, "only the desk may clear that");
        return;
      }
      mustLog = [];
      send(res, 200, JSON.stringify({ ok: true, musts: mustLog }), "application/json; charset=utf-8");
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, "not that way");
      return;
    }
    if (!fromShell(req)) {
      send(res, 403, "only the shell may report that");
      return;
    }
    let told = {};
    try {
      told = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      send(res, e && e.message === "too big" ? 413 : 400, e && e.message === "too big" ? "too big" : "bad json");
      return;
    }
    mustLog.unshift({
      sel: clamp(told.sel, 120),
      ok: !!told.ok,
      note: clamp(told.note, 120),
      where: clamp(told.where, 200),
      at: Date.now(),
    });
    mustLog = mustLog.slice(0, MAX_MUST);
    send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/ask") {
    if (req.method === "GET") {
      send(res, 200, JSON.stringify(askState), "application/json; charset=utf-8");
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, "not that way");
      return;
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      send(res, e && e.message === "too big" ? 413 : 400, e && e.message === "too big" ? "too big" : "bad json");
      return;
    }
    if (Object.prototype.hasOwnProperty.call(body, "answer")) {
      if (!sameSite(req)) {
        send(res, 403, "only the desk may answer");
        return;
      }
      rememberAnswer(body.id, body.answer);
      send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
      return;
    }
    if (!fromShell(req)) {
      send(res, 403, "only the shell may ask");
      return;
    }
    const id = clamp(body.id, 80);
    if (!id) {
      send(res, 400, "need an id");
      return;
    }
    const choices = Array.isArray(body.choices)
      ? body.choices.map((c) => clamp(c, 80)).filter(Boolean).slice(0, 8)
      : [];
    askState.pending = {
      id,
      prompt: clamp(body.prompt, 300),
      choices,
      where: clamp(body.where, 200),
      at: Date.now(),
    };
    send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/wrap" && req.method === "POST") {
    if (!sameSite(req)) {
      send(res, 403, "only the desk may wrap");
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
    send(res, 200, JSON.stringify({ ok: true, code: wrapAgent(source) }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/author" && req.method === "POST") {
    if (!sameSite(req)) {
      send(res, 403, "only the desk may author");
      return;
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      send(res, e && e.message === "too big" ? 413 : 400, e && e.message === "too big" ? "too big" : "bad json");
      return;
    }
    const job = String(body.job || "").trim();
    if (!job) {
      send(res, 400, JSON.stringify({ ok: false, error: "say what the agent should do" }), "application/json; charset=utf-8");
      return;
    }
    const page = String(body.page || SAMPLE_SKETCH).slice(0, 4000);
    const result = await chatXai(
      [
        { role: "system", content: AGENT_API },
        { role: "user", content: "Write agent.arm for this job.\n\nJob:\n" + job + "\n\nPage sketch:\n" + page },
      ],
      900,
    );
    if (!result.ok) {
      send(res, result.status || 502, JSON.stringify({ ok: false, error: result.error }), "application/json; charset=utf-8");
      return;
    }
    send(res, 200, JSON.stringify({ ok: true, source: stripFence(result.text) }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/heal" && req.method === "POST") {
    if (!sameSite(req)) {
      send(res, 403, "only the desk may heal");
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
    const error = String(body.error || "").trim();
    if (!source.trim() || !error) {
      send(res, 400, JSON.stringify({ ok: false, error: "need the script and what went wrong" }), "application/json; charset=utf-8");
      return;
    }
    const page = String(body.page || SAMPLE_SKETCH).slice(0, 4000);
    const result = await chatXai(
      [
        { role: "system", content: AGENT_API + "\nPatch the script so the error stops. Keep the same job." },
        { role: "user", content: "Error:\n" + error + "\n\nScript:\n" + source + "\n\nPage sketch:\n" + page },
      ],
      900,
    );
    if (!result.ok) {
      send(res, result.status || 502, JSON.stringify({ ok: false, error: result.error }), "application/json; charset=utf-8");
      return;
    }
    send(res, 200, JSON.stringify({ ok: true, source: stripFence(result.text) }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/look") {
    if (req.method === "GET") {
      send(res, 200, JSON.stringify(lookState), "application/json; charset=utf-8");
      return;
    }
    if (req.method === "DELETE") {
      if (!sameSite(req)) {
        send(res, 403, "only the desk may clear that");
        return;
      }
      lookState = { recording: false, steps: [] };
      send(res, 200, JSON.stringify(lookState), "application/json; charset=utf-8");
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, "not that way");
      return;
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      send(res, e && e.message === "too big" ? 413 : 400, e && e.message === "too big" ? "too big" : "bad json");
      return;
    }
    if (Object.prototype.hasOwnProperty.call(body, "recording")) {
      if (!sameSite(req)) {
        send(res, 403, "only the desk may arm look");
        return;
      }
      const rec = !!body.recording;
      lookState.recording = rec;
      if (rec) lookState.steps = [];
      send(res, 200, JSON.stringify(lookState), "application/json; charset=utf-8");
      return;
    }
    if (!fromShell(req)) {
      send(res, 403, "only the shell may record");
      return;
    }
    if (!lookState.recording) {
      send(res, 200, JSON.stringify({ ok: true, ignored: true }), "application/json; charset=utf-8");
      return;
    }
    const kind = body.kind === "type" ? "type" : "punch";
    const sel = clamp(body.sel, 200);
    if (!sel) {
      send(res, 400, "need a selector");
      return;
    }
    if (kind === "type") {
      const last = lookState.steps[lookState.steps.length - 1];
      if (last && last.kind === "type" && last.sel === sel) {
        last.text = clamp(body.text, 500);
        send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
        return;
      }
    }
    lookState.steps.push({ kind, sel, text: kind === "type" ? clamp(body.text, 500) : "" });
    lookState.steps = lookState.steps.slice(-MAX_LOOK);
    send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/look/compile" && req.method === "POST") {
    if (!sameSite(req)) {
      send(res, 403, "only the desk may compile");
      return;
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      send(res, e && e.message === "too big" ? 413 : 400, e && e.message === "too big" ? "too big" : "bad json");
      return;
    }
    const steps = Array.isArray(body.steps) ? body.steps : lookState.steps;
    const source = compileLook(steps);
    const err = compileError(source);
    if (err) {
      send(res, 400, JSON.stringify({ ok: false, error: err }), "application/json; charset=utf-8");
      return;
    }
    send(res, 200, JSON.stringify({ ok: true, source }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/examples") {
    const names = [
      "hello.js",
      "fill-sample.js",
      "highlight-headings.js",
      "outline-forms.js",
      "reading-ruler.js",
      "copy-table.js",
      "dump-form.js",
      "mark-required.js",
    ];
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
}

// The desk is a thing you leave running for days while you work in another
// window. It does not get to die over one request. A bare "//" alone used to
// take the whole process down inside new URL(), which any page in the browser
// could ask for, and a drawer file deleted at the wrong moment did the same.
// Answer 500, say what happened in the terminal, keep serving.
function fumble(res, e) {
  const why = e && e.message ? e.message : String(e);
  console.warn("[desk] that request went wrong: " + why);
  try {
    if (!res.headersSent) send(res, 500, "the desk tripped over that one: " + why);
    else res.end();
  } catch (e2) {}
}

// Exported so check.mjs can drive the routes without a shell and a port guess.
export const server = createServer(function (req, res) {
  // handle is async, so a throw anywhere inside it lands here as a rejection.
  try {
    handle(req, res).catch(function (e) { fumble(res, e); });
  } catch (e) {
    fumble(res, e);
  }
});

// Only listen when run directly. check.mjs imports this file for compileError.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Last resort. The per-request guard above catches the ones we can answer;
  // these two keep a stray timer or a socket error from ending the session.
  // Only when run as the desk: a check that imports this file should still see
  // its own mistakes.
  process.on("unhandledRejection", (e) => {
    console.warn("[desk] stray rejection: " + (e && e.message ? e.message : e));
  });
  process.on("uncaughtException", (e) => {
    console.warn("[desk] caught: " + (e && e.stack ? e.stack : e));
  });
  server.listen(port, host, () => {
    console.log(`PageArm desk http://${host}:${port}`);
  });
}
