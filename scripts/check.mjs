// The real check. Packs the extension in memory, reads the zip back, and makes
// sure every piece parses and the manifest says what we think it says.

import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { inflateRawSync } from "zlib";
import { request as httpRequest } from "http";
import { Script, createContext } from "vm";
import { packExtension, buildManifest, TARGETS, normalizeTarget, zipName, VERSION } from "./pack.mjs";
import { wrapAgent, wrapPacked } from "./wrap.mjs";
import { compileLook } from "./look.mjs";
import { crc32 } from "./zip.mjs";
import { compileError, drawerName, drawerList, server } from "./serve.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function ok(cond, label) {
  if (cond) {
    console.log("  ok   " + label);
  } else {
    failures++;
    console.log("  FAIL " + label);
  }
}

function parses(code, label) {
  try {
    new Script(code, { filename: label });
    ok(true, label + " parses");
  } catch (e) {
    ok(false, label + " parses: " + e.message);
  }
}

// Minimal zip reader: walk the central directory, inflate each entry, check its crc.
function readZip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("bad central header");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nlen = view.getUint16(p + 28, true);
    const elen = view.getUint16(p + 30, true);
    const clen = view.getUint16(p + 32, true);
    const loff = view.getUint32(p + 42, true);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nlen)).toString("utf8");
    p += 46 + nlen + elen + clen;
    if (view.getUint32(loff, true) !== 0x04034b50) throw new Error("bad local header " + name);
    const lnlen = view.getUint16(loff + 26, true);
    const lelen = view.getUint16(loff + 28, true);
    const start = loff + 30 + lnlen + lelen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(Buffer.from(raw))) : new Uint8Array(raw);
    if (data.length !== usize) throw new Error("size mismatch " + name);
    if (crc32(data) !== crc) throw new Error("crc mismatch " + name);
    files[name] = data;
  }
  return files;
}

const origin = "http://127.0.0.1:8787";
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const text = (files, n) => Buffer.from(files[n] || new Uint8Array()).toString("utf8");

// Every browser gets the same eight files and its own manifest. Pack all three
// in memory and read each one back, because a zip that only Chrome can open is
// not a cross-browser build, it is a Chrome build with extra folders.
for (const target of TARGETS) {
  console.log("pack " + target);
  const zip = packExtension({ origin, target });
  let files = {};
  try {
    files = readZip(Buffer.from(zip));
    ok(true, "zip reads back with matching crcs");
  } catch (e) {
    ok(false, "zip reads back: " + e.message);
  }
  const names = Object.keys(files).sort();
  ok(
    names.join(",") === "README.txt,background.js,boot.js,bridge.js,icon16.png,icon32.png,inject.js,manifest.json",
    "zip holds the eight shell files",
  );

  let manifest = null;
  try {
    manifest = JSON.parse(text(files, "manifest.json"));
    ok(true, "manifest.json is JSON");
  } catch (e) {
    ok(false, "manifest.json is JSON: " + e.message);
  }
  if (manifest) {
    ok(manifest.manifest_version === 3, "manifest v3");
    ok(manifest.version === pkgVersion && manifest.version === VERSION,
      "manifest version is package.json's version, written once");
    ok(!manifest.host_permissions.includes("<all_urls>"), "no <all_urls>: the agent runs only on the host list");
    ok(manifest.host_permissions.includes(origin + "/*"), "desk origin is a host permission");
    ok(!manifest.permissions.includes("tabs"), "no unused tabs permission");
    const cs = manifest.content_scripts || [];
    ok(cs.length === 2 && cs[0].world === "MAIN" && !cs[1].world, "content scripts: MAIN agent plus isolated bridge");
    ok(cs.every((c) => JSON.stringify(c.matches) === JSON.stringify(cs[0].matches)), "content scripts share one match list");

    // The four things the three browsers actually disagree about.
    if (target === "firefox") {
      ok(!manifest.background.service_worker && manifest.background.scripts[0] === "background.js",
        "firefox gets an event page, not a service worker");
      ok(!manifest.permissions.includes("userScripts"), "firefox does not declare userScripts: it is opt-in only");
      ok((manifest.optional_permissions || []).includes("userScripts"), "firefox asks for userScripts at a click");
      ok(manifest.browser_specific_settings.gecko.strict_min_version === "142.0",
        "firefox floor is 142, the oldest build that can declare what we declare");
      ok(manifest.name === "PageArm", "firefox build has a name longer than one letter, because Firefox insists");
      ok(JSON.stringify(manifest.browser_specific_settings.gecko.data_collection_permissions.required) === '["none"]',
        "firefox build says out loud that it collects nothing");
    } else {
      ok(manifest.name === "P", target + " keeps the one-letter name");
      ok(manifest.background.service_worker === "background.js" && !manifest.background.scripts,
        target + " gets a service worker");
      ok(!manifest.browser_specific_settings, target + " carries no gecko settings");
    }
    if (target === "chromium") {
      ok(manifest.permissions.includes("userScripts"), "userScripts permission for CSP-proof hot-swap");
    }
    if (target === "safari") {
      ok(!manifest.permissions.includes("userScripts") && !manifest.optional_permissions,
        "safari asks for no userScripts: it has no such API");
    }
  }

  for (const n of ["background.js", "boot.js", "bridge.js", "inject.js"]) parses(text(files, n), target + "/" + n);
  ok(!text(files, "background.js").includes("__PA_ORIGIN__"), "background.js has the desk origin baked in");
  ok(text(files, "inject.js").startsWith("if (!window.__PA_VER) "), "packed inject.js steps aside for a live agent");
  const isPng = (n) => files[n] && files[n][0] === 0x89 && files[n][1] === 0x50 && files[n][2] === 0x4e && files[n][3] === 0x47;
  ok(isPng("icon16.png"), "icon16.png is a PNG");
  ok(isPng("icon32.png"), "icon32.png is a PNG");
  ok(text(files, "README.txt").includes(origin), "README.txt points at the desk");
  ok(zipName(target) === "pagearm-" + target + ".zip", "zip is named for its browser");
}

console.log("shell");
// One background file serves all three, so it may not reach for a namespace or
// a shape that only one of them has.
const shell = readFileSync(join(root, "extension/background.js"), "utf8");
const bridgeSrc = readFileSync(join(root, "extension/bridge.js"), "utf8");
for (const [label, src] of [["background.js", shell], ["bridge.js", bridgeSrc]]) {
  ok(/browser !== "undefined"/.test(src), label + " picks browser over chrome when it is there");
  ok(!/(^|[^.\w])chrome\.(?!runtime\.lastError)/m.test(src.replace(/globalThis\.chrome/g, "api")),
    label + " goes through the api shim, not chrome directly");
}
ok(/webNavigation\.onHistoryStateUpdated/.test(shell) && /if \(api\.webNavigation\.onHistoryStateUpdated\)/.test(shell),
  "background.js guards the navigation event Safari does not have");
ok(/type === "nav"/.test(shell) && /type: "nav"/.test(bridgeSrc), "the bridge covers that gap with a nav message");
ok(/type === "oops"/.test(shell) && /type: "oops"/.test(bridgeSrc), "a throw in the page travels to the background");
ok(/quiet\(fetch\(ORIGIN \+ "\/api\/oops"/.test(shell), "and on to the desk, as a promise nobody leaves unhandled");
ok(/type === "ask"/.test(bridgeSrc) && /ask-result/.test(bridgeSrc), "the bridge carries ask the way it carries capture");
ok(/ORIGIN \+ "\/api\/ask"/.test(shell), "ask polls the desk");
ok(/type === "must"/.test(bridgeSrc) && /ORIGIN \+ "\/api\/must"/.test(shell), "must travels to the desk, quietly");
ok(/look-on/.test(bridgeSrc) && /look-off/.test(bridgeSrc), "the bridge starts and stops look from a worker message");
ok(/ORIGIN \+ "\/api\/look"/.test(shell) && /tabs\.sendMessage/.test(shell), "look records through the desk, and P turns it on");
ok(/function pickTarget/.test(bridgeSrc), "look walks composedPath to the control, not a span inside it");
ok(/type === "checkbox"/.test(bridgeSrc) && /type === "radio"/.test(bridgeSrc), "look does not type into a checkbox");
ok(/flushType\(\);/.test(bridgeSrc), "look flushes typing before a punch, so Save does not drop the last letters");
ok(/kind: "seen"/.test(bridgeSrc) && /noteAppeared/.test(bridgeSrc), "look watches what appeared after a punch");
ok(/aria-label/.test(bridgeSrc) && /data-testid/.test(bridgeSrc), "look prefers aria-label and data-testid over nth-of-type");
ok(/function sketch/.test(bridgeSrc), "look also sketches the controls so Write can see the live tab");
ok(!/data-pa-bridge/.test(bridgeSrc), "the bridge does not hang a name tag on the document");
ok(/text\/plain/.test(shell), "posted as text/plain, so no browser stops for a preflight the desk cannot answer");
ok(normalizeTarget("chrome") === "chromium" && normalizeTarget("ff") === "firefox" && normalizeTarget("nonsense") === "chromium",
  "browser names normalize to a known target");
ok(buildManifest({ origin, target: "firefox" }).background.scripts.length === 1, "buildManifest is callable on its own");

console.log("agents");
for (const n of readdirSync(join(root, "agents")).filter((f) => f.endsWith(".js") && f !== "current.js")) {
  const src = readFileSync(join(root, "agents", n), "utf8");
  parses(wrapAgent(src), "wrapped " + n);
  parses(wrapPacked(src), "packed " + n);
}
ok(compileError("agent.arm = () => { ok }") === null, "compileError accepts good source");
ok(typeof compileError("agent.arm = (") === "string", "compileError rejects a syntax error");
// The number has to be the one the editor is showing, not the wrapper's.
ok(/\(line 2\)$/.test(compileError("var a = 1;\nvar b = ;\nvar c = 3;")), "a syntax error carries the line it broke on");
ok(/\(line 4\)$/.test(compileError("\n\n\nvar a = ;")), "blank lines above the code do not shift that number");
ok(/\(line 3\)$/.test(compileError("agent.arm = function () {\n  var x = 1;\n")), "an unterminated block points at the last line you can see");
ok(!/\(line/.test(String(compileError([{ name: "a", source: "var x = ;" }]))), "a stack gets no line number, because one file's numbers would be a guess");

console.log("stack");
// One desk can serve several scripts. They land in one file, so the only honest
// test is to run that file and watch what happens, in order, with a thrower in
// the middle.
function runStack(parts) {
  const log = [];
  const win = { __PA_ORIGIN: "http://127.0.0.1:8787", __log: log, postMessage(msg) { log.push("pip:" + msg.state + (msg.mark ? ":" + msg.mark : "")); } };
  const ctx = createContext({
    window: win,
    console: { warn: (...a) => log.push("warn:" + String(a[1] && a[1].message ? a[1].message : a[1])) },
    location: { hostname: "example.com", pathname: "/" },
    setTimeout: () => 0,
  });
  new Script(wrapAgent(parts), { filename: "agent.js" }).runInContext(ctx);
  return { log, agent: win.__agent };
}

const stacked = runStack([
  { name: "one", source: "let helper = 1; window.__log.push('body:one'); agent.arm = function () { window.__log.push('arm:one'); };" },
  { name: "two", source: "let helper = 2; window.__log.push('body:two'); agent.arm = function () { throw new Error('two is broken'); };" },
  { name: "three", source: "let helper = 3; window.__log.push('body:three'); agent.arm = function () { window.__log.push('arm:three'); };" },
]);
ok(
  stacked.log.filter((l) => l.startsWith("body:")).join(",") === "body:one,body:two,body:three",
  "every script in the stack runs, in the order the stack says",
);
ok(
  stacked.log.filter((l) => l.startsWith("arm:")).join(",") === "arm:one,arm:three",
  "one script throwing in arm does not take its neighbors down",
);
ok(stacked.log.some((l) => l.indexOf("two is broken") >= 0), "the warning carries the name of the script that threw");
ok(
  JSON.stringify(stacked.agent.scripts) === '["one","two","three"]',
  "the agent says which scripts it is carrying",
);
// let twice in one scope is a syntax error, so the three above only parse at
// all because each script got its own function body.
parses(wrapAgent([{ name: "a", source: "let x = 1;" }, { name: "b", source: "let x = 2;" }]), "two scripts with the same names inside");

const alone = runStack([{ name: "solo", source: "window.__log.push('body'); agent.arm = function () { window.__log.push('arm'); };" }]);
ok(alone.log.join(",") === "body,arm", "one script alone behaves exactly as it did before there was a stack");
ok(runStack("agent.arm = function () { window.__log.push('legacy'); };").log.join(",") === "legacy",
  "a bare source string still wraps, which is what pack.mjs hands over");
const quiet = runStack([{ name: "quiet", source: "var unused = 1;" }]);
ok(quiet.log.join(",") === "pip:ok", "a script that arms nothing still pips ok, the way the default always did");
ok(compileError([{ name: "a", source: "agent.arm = (" }]) !== null, "compileError reads a stack too");

console.log("wrap");
// PREFIX grew. The contract did not: sync arms still finish in this turn, an
// empty stack still pips without Promise, and a syntax error still points at
// the line the editor is showing (BODY_OFFSET is measured from wrapAgent).
const wrapped = wrapAgent("agent.arm = function () {};");
ok(/function step\(/.test(wrapped), "armAll walks with step so a sync arm still finishes in this turn");
ok(!/Promise\.resolve\(\)/.test(wrapped), "the wrapper never calls Promise.resolve, so a vm without Promise still pips");
ok(/shadowRoot/.test(wrapped), "q walks open shadow roots");
ok(/contentDocument/.test(wrapped), "and same-origin iframes");
ok(/composed: true/.test(wrapped), "punch is composed, so it can cross a shadow root");
ok(/isPrimary: true/.test(wrapped), "punch says it is the primary pointer");
ok(/inputType: "insertText"/.test(wrapped), "type fires InputEvent insertText");
ok(/function onCleanup/.test(wrapped) && /__PA_CLEANUP/.test(wrapped), "onCleanup is there so a swap can drop listeners");
ok(/function watch/.test(wrapped) && /function when/.test(wrapped), "watch and when sit next to it");
ok(/function must/.test(wrapped) && /function ask/.test(wrapped), "must and ask are part of the agent");
ok(/typeof MutationObserver === "undefined"/.test(wrapped), "watch no-ops the observer when the vm has none");

function runStackRich(parts, extras = {}) {
  const log = [];
  const win = {
    __PA_ORIGIN: "http://127.0.0.1:8787",
    __log: log,
    postMessage(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === "pip") log.push("pip:" + (msg.state || "") + (msg.mark ? ":" + msg.mark : ""));
      else if (msg.type === "must") log.push("must:" + (msg.ok ? "ok" : "miss") + ":" + (msg.note || ""));
      else if (msg.type === "ask") log.push("ask:" + (msg.prompt || ""));
      else log.push(msg.type);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const ctx = createContext({
    Array, Object, String, Number, Boolean, Math, JSON, Error, Promise,
    window: win,
    document: extras.document || { querySelector() { return null; }, querySelectorAll() { return []; } },
    console: { warn: (...a) => log.push("warn:" + String(a[1] && a[1].message ? a[1].message : a[1])) },
    location: { hostname: "example.com", pathname: "/", href: "https://example.com/" },
    setTimeout: extras.setTimeout || (() => 0),
    MutationObserver: extras.MutationObserver,
  });
  new Script(wrapAgent(parts), { filename: "agent.js" }).runInContext(ctx);
  return { log, agent: win.__agent, window: win };
}

const cleaned = runStackRich([{
  name: "tidy",
  source: "agent.arm = function () { window.__log.push('arm'); agent.onCleanup(function () { window.__log.push('clean'); }); };",
}]);
ok(cleaned.log.filter((l) => l === "arm").join(",") === "arm", "first arm ran once");
cleaned.agent.arm();
ok(cleaned.log.filter((l) => l === "arm" || l === "clean").join(",") === "arm,clean,arm",
  "the next arm drops the last run's cleanup before it starts");

const pay = { id: "pay", hidden: false };
const shadow = {
  querySelector(sel) { return sel === "#pay" ? pay : null; },
  querySelectorAll() { return []; },
};
const host = { shadowRoot: shadow, tagName: "DIV" };
const pierced = runStackRich([{
  name: "pierce",
  source: "agent.arm = function () { window.__hit = agent.q('#pay'); agent.must('#pay', 'till'); };",
}], {
  document: {
    querySelector(sel) { return sel === "#host" ? host : null; },
    querySelectorAll(sel) { return sel === "*" ? [host] : []; },
  },
});
ok(pierced.window.__hit === pay, "q finds a node inside an open shadow root");
ok(pierced.log.indexOf("must:ok:till") >= 0, "must posts that it found it");

const missed = runStackRich([{
  name: "miss",
  source: "agent.arm = function () { agent.must('#nope', 'missing'); };",
}]);
ok(missed.log.indexOf("must:miss:missing") >= 0 && missed.log.indexOf("pip:err:must") >= 0,
  "must pips err when the node is not there");

const asked = runStackRich([{
  name: "ask",
  source: "agent.arm = function () { agent.ask('which boat', ['heron', 'mackerel']); };",
}]);
ok(asked.log.indexOf("ask:which boat") >= 0, "ask posts to the page");

const watched = runStackRich([{
  name: "w",
  source: "agent.arm = function () { agent.watch('h1', function () { window.__log.push('watch'); }); };",
}]);
ok(watched.log.indexOf("watch") >= 0, "watch still runs once when MutationObserver is missing");

const later = runStackRich([{
  name: "later",
  source: "agent.arm = function () { window.__log.push('start'); return Promise.resolve().then(function () { window.__log.push('later'); }); };",
}]);
ok(later.log.indexOf("start") >= 0, "an async arm starts in this turn");
await new Promise((resolve) => setImmediate(resolve));
ok(later.log.indexOf("later") >= 0, "and the thenable is not dropped");

console.log("look");
const looked = compileLook([
  { kind: "punch", sel: "#vessel" },
  { kind: "type", sel: "#vessel", text: "M" },
  { kind: "type", sel: "#vessel", text: "Mackerel Queen" },
  { kind: "type", sel: "#catch", text: "herring" },
  { kind: "punch", sel: "#save-claim" },
  { kind: "punch", sel: "#save-claim" },
]);
ok(looked.indexOf('agent.type(agent.q("#vessel"), "Mackerel Queen")') >= 0, "look keeps the last value typed into a field");
ok(looked.indexOf('agent.punch(agent.q("#vessel"))') < 0, "and drops the punch that was just focusing that field");
ok(/await agent\.wait\(80\)/.test(looked), "a punch after typing waits a tick, the way React wants");
ok(looked.indexOf('agent.must("#save-claim"') >= 0, "without a seen node, the last punch is a must");
ok((looked.match(/punch\(agent\.q\("#save-claim"\)\)/g) || []).length === 1, "a double punch on Save is one punch");
const sawReceipt = compileLook([
  { kind: "type", sel: "#vessel", text: "Mackerel Queen" },
  { kind: "punch", sel: "#save-claim" },
  { kind: "seen", sel: "#receipt" },
]);
ok(sawReceipt.indexOf('agent.must("#receipt"') >= 0, "a node that appeared after the punch is the must");
ok(sawReceipt.indexOf('agent.must("#save-claim"') < 0, "and the button you punched is not");
ok(/punch\(agent\.q\("#save-claim"\)\)/.test(sawReceipt), "the punch itself is still there");
ok(!/kind === "seen"/.test(sawReceipt) && !/agent\.seen/.test(sawReceipt), "seen is not an agent call");
parses(wrapAgent(looked), "wrapped a compiled look");
ok(/agent\.pip\("ok"\)/.test(compileLook([])), "an empty look still pips, the way a quiet agent always did");
const typedOnly = compileLook([{ kind: "type", sel: "#vessel", text: "Mackerel Queen" }]);
ok(typedOnly.indexOf('agent.must("#vessel"') >= 0, "a type-only look still musts the last field");
ok(typedOnly.indexOf("wait(") < 0, "and does not wait when there is nothing to punch");
ok(!compileLook([{ kind: "punch", sel: "  " }]).includes("punch("), "a blank selector is not a step");

console.log("drawer");
// A drawer name turns into a filename, so the only interesting question is
// whether anything can climb out of the folder. Nothing may.
ok(drawerName("Reading-Ruler_2") === "reading-ruler_2", "a drawer name is lowercased and kept");
for (const bad of ["../evil", "a/b", "a.b", "", " ", "-lead", "x".repeat(49), "a\\b", "a b"]) {
  ok(drawerName(bad) === null, "drawer name refused: " + JSON.stringify(bad));
}
ok(Array.isArray(drawerList()), "the drawer lists even when it does not exist yet");

// Drive the real routes. Only the ones that cannot write, because a check is
// not allowed to reach into the drawer you are actually using.
const base = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port));
});
const desk = (path, init) => fetch(base + path, init);
try {
  const shelf = await desk("/api/drawer");
  const body = await shelf.json();
  ok(shelf.status === 200 && Array.isArray(body.scripts) && Array.isArray(body.stack), "GET /api/drawer answers with a shelf and a stack");
  ok((await desk("/api/drawer/nope-not-here")).status === 404, "a script that is not in the drawer is a 404");
  ok((await desk("/api/drawer/..%2Fevil")).status === 400, "a name that tries to climb out is refused");
  const crossSite = await desk("/api/drawer/anything", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ source: "" }),
  });
  ok(crossSite.status === 403, "a cross-site page cannot write to the drawer");
  // The desk is left running for days. One bad request may not end that. A bare
  // "//" is the cheap proof: new URL() refuses it, and any page in the browser
  // could ask for it.
  const nonsense = await desk("//");
  ok(nonsense.status === 500, "a request the desk cannot parse is a 500");
  ok((await desk("/api/drawer")).status === 200, "and the desk is still serving afterward");
  // The shell reports a throw to the desk. A site you visit must not be able to.
  const told = await desk("/api/oops", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "chrome-extension://pretendthisisreal" },
    body: JSON.stringify({ script: "ruler", message: "x is not defined", where: "https://example.com/a" }),
  });
  ok(told.status === 200, "the shell may tell the desk what threw");
  const heard = await (await desk("/api/oops")).json();
  ok(heard.errors[0].script === "ruler" && heard.errors[0].message === "x is not defined" && heard.errors[0].at > 0,
    "and the desk keeps it, with a time on it");
  const forged = await desk("/api/oops", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ script: "nonsense", message: "from a website" }),
  });
  ok(forged.status === 403, "a site you visit may not");
  for (let i = 0; i < 14; i++) {
    await desk("/api/oops", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "moz-extension://pretendthisisreal" },
      body: JSON.stringify({ script: "ruler", message: "number " + i, where: "https://example.com/a" }),
    });
  }
  const many = await (await desk("/api/oops")).json();
  ok(many.errors.length === 10 && many.errors[0].message === "number 13",
    "it keeps the last ten, newest first, and does not grow forever");
  const cleared = await desk("/api/oops", { method: "DELETE" });
  ok(cleared.status === 200 && (await (await desk("/api/oops")).json()).errors.length === 0, "and the desk can clear them");

  const asked = await desk("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "chrome-extension://pretendthisisreal" },
    body: JSON.stringify({ id: "ask-1", prompt: "which boat", choices: ["heron", "mackerel"] }),
  });
  ok(asked.status === 200, "the shell may post an ask");
  const pending = await (await desk("/api/ask")).json();
  ok(pending.pending && pending.pending.prompt === "which boat" && pending.pending.choices[0] === "heron",
    "and the desk holds the question");
  const forgedAsk = await desk("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ id: "ask-1", answer: "stolen" }),
  });
  ok(forgedAsk.status === 403, "a site you visit may not answer it");
  const answered = await desk("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "ask-1", answer: "heron" }),
  });
  ok(answered.status === 200, "the desk may answer");
  const heardAsk = await (await desk("/api/ask")).json();
  ok(heardAsk.answers["ask-1"] === "heron" && !heardAsk.pending, "and the shell can poll that answer");

  const musted = await desk("/api/must", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "moz-extension://pretendthisisreal" },
    body: JSON.stringify({ sel: "#receipt", ok: true, note: "receipt painted", where: "https://example.com/" }),
  });
  ok(musted.status === 200, "the shell may post a must");
  const mustHeard = await (await desk("/api/must")).json();
  ok(mustHeard.musts[0].sel === "#receipt" && mustHeard.musts[0].ok === true, "and the desk keeps it");
  ok((await desk("/api/must", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ sel: "#x", ok: true }),
  })).status === 403, "a site you visit may not post a must");

  const wrapPost = await desk("/api/wrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "agent.arm = function () {};" }),
  });
  const wrappedBody = await wrapPost.json();
  ok(wrapPost.status === 200 && /function step\(/.test(wrappedBody.code), "the desk will wrap editor source for prove");
  ok((await desk("/api/wrap", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ source: "agent.arm = function () {};" }),
  })).status === 403, "a cross-site page cannot wrap");

  const authorEmpty = await desk("/api/author", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job: "" }),
  });
  ok(authorEmpty.status === 400, "author refuses a blank job");
  ok((await desk("/api/author", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ job: "fill it" }),
  })).status === 403, "a cross-site page cannot author");
  if (!process.env.XAI_API_KEY) {
    const noKey = await desk("/api/author", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job: "fill the claim" }),
    });
    ok(noKey.status === 503, "author says so when there is no key");
    const noForge = await desk("/api/forge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job: "fill the claim" }),
    });
    ok(noForge.status === 503, "forge says so when there is no key");
    const noEnhance = await desk("/api/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job: "fill the claim" }),
    });
    ok(noEnhance.status === 503, "enhance says so when there is no key");
  }
  ok((await desk("/api/enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job: "" }),
  })).status === 400, "enhance without a job or a look is a 400");
  ok((await desk("/api/enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ job: "fill it" }),
  })).status === 403, "a cross-site page cannot enhance");
  ok((await desk("/api/forge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job: "" }),
  })).status === 400, "forge refuses a blank job");
  ok((await desk("/api/forge", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ job: "fill it" }),
  })).status === 403, "a cross-site page cannot forge");

  const sample = await desk("/sample.html");
  ok(sample.status === 200 && /save-claim/.test(await sample.text()), "the sample page is on the desk for prove");

  ok((await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ recording: true }),
  })).status === 403, "a cross-site page cannot start look");
  const lookOn = await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recording: true }),
  });
  ok(lookOn.status === 200 && (await lookOn.json()).recording === true, "the desk may start look");
  ok((await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ kind: "punch", sel: "#x" }),
  })).status === 403, "a site you visit may not record");
  const stepped = await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "chrome-extension://pretendthisisreal" },
    body: JSON.stringify({ kind: "type", sel: "#vessel", text: "Mackerel Queen" }),
  });
  ok(stepped.status === 200, "the shell may record a step");
  await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "chrome-extension://pretendthisisreal" },
    body: JSON.stringify({ kind: "punch", sel: "#save-claim" }),
  });
  const lookHeld = await (await desk("/api/look")).json();
  ok(lookHeld.steps.length === 2 && lookHeld.steps[0].sel === "#vessel", "and the desk holds the trace");
  ok(lookHeld.live === true, "a trace is live, so Write will not prove it on the sample page");
  await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "chrome-extension://pretendthisisreal" },
    body: JSON.stringify({ kind: "seen", sel: "#receipt" }),
  });
  const withSeen = await (await desk("/api/look")).json();
  ok(withSeen.steps.some((s) => s.kind === "seen" && s.sel === "#receipt"), "the shell may record a node that appeared after a punch");
  await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "chrome-extension://pretendthisisreal" },
    body: JSON.stringify({
      kind: "sketch",
      nodes: [{ sel: "#vessel", tag: "input", name: "vessel", text: "" }, { sel: "#save-claim", tag: "button", name: "", text: "Save claim" }],
    }),
  });
  const sketched = await (await desk("/api/look")).json();
  ok(sketched.sketch && sketched.sketch[0] && sketched.sketch[0].sel === "#vessel", "the shell may sketch the live controls");
  if (!process.env.XAI_API_KEY) {
    const polished = await desk("/api/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job: "" }),
    });
    const polishedBody = await polished.json();
    ok(polished.status === 200 && /agent\.arm/.test(polishedBody.source || ""),
      "enhance without a key still returns the compiled look");
  }
  await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recording: true }),
  });
  ok((await (await desk("/api/look")).json()).steps.length >= 3, "Record twice does not wipe a take that is already rolling");
  const compiled = await desk("/api/look/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const compiledBody = await compiled.json();
  ok(compiled.status === 200 && /type\(agent\.q\("#vessel"\)/.test(compiledBody.source), "compile turns the trace into an arm");
  await desk("/api/look", { method: "DELETE" });
  const lookCleared = await (await desk("/api/look")).json();
  ok(lookCleared.recording === false && lookCleared.live === false && !(lookCleared.sketch && lookCleared.sketch.length), "and the desk can stop and clear it");
  await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recording: true }),
  });
  await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "chrome-extension://pretendthisisreal" },
    body: JSON.stringify({ kind: "type", sel: "#vessel", text: "M" }),
  });
  await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recording: false }),
  });
  await desk("/api/look", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "chrome-extension://pretendthisisreal" },
    body: JSON.stringify({ kind: "type", sel: "#vessel", text: "Mackerel Queen" }),
  });
  const late = await (await desk("/api/look")).json();
  ok(late.recording === false && late.steps[0] && late.steps[0].text === "Mackerel Queen",
    "a late type still updates the last field after Stop");
  await desk("/api/look", { method: "DELETE" });

  const icon = await desk("/favicon.png");
  ok(icon.status === 200 && icon.headers.get("content-type") === "image/png",
    "the desk has a favicon instead of 404ing at itself");

  // fetch refuses to forge a Host header, and a DNS rebind is exactly a forged
  // Host header, so this one goes out over a plain socket.
  const rebound = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server.address().port, path: "/api/drawer", headers: { Host: "evil.example" } },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on("error", reject);
    req.end();
  });
  ok(rebound === 403, "the drawer answers to 127.0.0.1 only");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

// serve.mjs, pack.mjs, wrap.mjs and zip.mjs were all imported above, so they
// already loaded. If one of them breaks, this script never gets this far.

if (failures) {
  console.log("\n" + failures + " check(s) failed");
  process.exit(1);
}
console.log("\nall good");
