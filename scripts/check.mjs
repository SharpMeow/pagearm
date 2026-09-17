// The real check. Packs the extension in memory, reads the zip back, and makes
// sure every piece parses and the manifest says what we think it says.

import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { inflateRawSync } from "zlib";
import { Script } from "vm";
import { packExtension } from "./pack.mjs";
import { wrapAgent, wrapPacked } from "./wrap.mjs";
import { crc32 } from "./zip.mjs";
import { compileError } from "./serve.mjs";

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

console.log("pack");
const origin = "http://127.0.0.1:8787";
const zip = packExtension({ origin });
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
const text = (n) => Buffer.from(files[n] || new Uint8Array()).toString("utf8");

console.log("manifest");
let manifest = null;
try {
  manifest = JSON.parse(text("manifest.json"));
  ok(true, "manifest.json is JSON");
} catch (e) {
  ok(false, "manifest.json is JSON: " + e.message);
}
if (manifest) {
  ok(manifest.manifest_version === 3, "manifest v3");
  ok(!manifest.host_permissions.includes("<all_urls>"), "no <all_urls>: the agent runs only on the host list");
  ok(manifest.host_permissions.includes(origin + "/*"), "desk origin is a host permission");
  ok(manifest.permissions.includes("userScripts"), "userScripts permission for CSP-proof hot-swap");
  ok(!manifest.permissions.includes("tabs"), "no unused tabs permission");
  const cs = manifest.content_scripts || [];
  ok(cs.length === 2 && cs[0].world === "MAIN" && !cs[1].world, "content scripts: MAIN agent plus isolated bridge");
  ok(cs.every((c) => JSON.stringify(c.matches) === JSON.stringify(cs[0].matches)), "content scripts share one match list");
}

console.log("shell");
for (const n of ["background.js", "boot.js", "bridge.js", "inject.js"]) parses(text(n), n);
ok(!text("background.js").includes("__PA_ORIGIN__"), "background.js has the desk origin baked in");
ok(text("inject.js").startsWith("if (!window.__PA_VER) "), "packed inject.js steps aside for a live agent");
const isPng = (n) => files[n] && files[n][0] === 0x89 && files[n][1] === 0x50 && files[n][2] === 0x4e && files[n][3] === 0x47;
ok(isPng("icon16.png"), "icon16.png is a PNG");
ok(isPng("icon32.png"), "icon32.png is a PNG");

console.log("agents");
for (const n of readdirSync(join(root, "agents")).filter((f) => f.endsWith(".js") && f !== "current.js")) {
  const src = readFileSync(join(root, "agents", n), "utf8");
  parses(wrapAgent(src), "wrapped " + n);
  parses(wrapPacked(src), "packed " + n);
}
ok(compileError("agent.arm = () => { ok }") === null, "compileError accepts good source");
ok(typeof compileError("agent.arm = (") === "string", "compileError rejects a syntax error");

// serve.mjs, pack.mjs, wrap.mjs and zip.mjs were all imported above, so they
// already loaded. If one of them breaks, this script never gets this far.

if (failures) {
  console.log("\n" + failures + " check(s) failed");
  process.exit(1);
}
console.log("\nall good");
