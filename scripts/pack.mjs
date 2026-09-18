import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { zipFiles, pngGlyph } from "./zip.mjs";
import { wrapPacked } from "./wrap.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_HOSTS = ["https://*/*", "http://127.0.0.1/*", "http://localhost/*"];

export function buildManifest({ origin, hosts }) {
  const o = String(origin || "http://127.0.0.1:8787").replace(/\/$/, "");
  const matches = (hosts && hosts.length ? hosts : DEFAULT_HOSTS).map((h) => String(h).trim()).filter(Boolean);

  // Host permissions are exactly the match list plus the desk. No <all_urls>:
  // the agent runs where you said it may, and nowhere else.
  const hostPermissions = Array.from(new Set([...matches, `${o}/*`]));

  return {
    manifest_version: 3,
    name: "P",
    version: "0.2.0",
    description: "PageArm runtime. Load unpacked only.",
    action: {
      default_title: "P",
      default_icon: { 16: "icon16.png", 32: "icon32.png" },
    },
    icons: { 16: "icon16.png", 32: "icon32.png" },
    background: { service_worker: "background.js" },
    // userScripts lets the worker inject a code string past the page's CSP.
    // Chrome shows an "Allow User Scripts" toggle for it. Off, we fall back to eval.
    permissions: ["scripting", "webNavigation", "activeTab", "userScripts"],
    host_permissions: hostPermissions,
    content_scripts: [
      {
        matches,
        js: ["boot.js", "inject.js"],
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true,
        run_at: "document_idle",
        world: "MAIN",
      },
      {
        matches,
        js: ["bridge.js"],
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true,
        run_at: "document_start",
      },
    ],
  };
}

export function packExtension({ origin, hosts, agentSource }) {
  const o = String(origin || "http://127.0.0.1:8787").replace(/\/$/, "");
  const manifest = buildManifest({ origin: o, hosts });

  const background = readFileSync(join(root, "extension/background.js"), "utf8").replaceAll(
    "__PA_ORIGIN__",
    o,
  );
  const boot = `window.__PA_ORIGIN = ${JSON.stringify(o)};\n`;
  const inject = wrapPacked(agentSource || readFileSync(join(root, "agents/hello.js"), "utf8"));
  const bridge = readFileSync(join(root, "extension/bridge.js"), "utf8");
  const readme = `
 ____                     _
|  _ \\ __ _  __ _  ___   / \\   _ __ _ __ ___
| |_) / _\` |/ _\` |/ _ \\ / _ \\ | '__| '_ \` _ \\
|  __/ (_| | (_| |  __// ___ \\| |  | | | | | |
|_|   \\__,_|\\__, |\\___/_/   \\_\\_|  |_| |_| |_|
            |___/

  personal chrome runtime    Mac · Windows · Linux

Hey. You loaded this folder. That is the shell. The living agent
lives on the desk at ${o}, not in these files.

1. Keep the folder that contains THIS README and manifest.json.
   Windows Extract All sometimes nests an extra folder. Go in one level.
2. chrome://extensions  (Edge: edge://extensions)
3. Developer mode on. Load unpacked on THIS folder.
4. Open the extension's Details and turn on "Allow User Scripts" if
   Chrome shows it. That lets the desk swap code on sites with a strict
   Content Security Policy. Without it those sites keep this packed copy.
5. Pin P. Green means armed. Hover is just P.
6. Desk: ${o}
   Use 127.0.0.1, not localhost. Windows maps localhost to IPv6
   sometimes and the worker cannot fetch the agent.
   Node 18+ is only for the desk. This packed copy still runs
   if the desk is asleep. Close the laptop. You are fine.

Chrome, Edge, Brave, or Chromium. Not Safari. Not Firefox.
`;

  const enc = new TextEncoder();
  return zipFiles([
    { name: "manifest.json", data: enc.encode(JSON.stringify(manifest, null, 2)) },
    { name: "background.js", data: enc.encode(background) },
    { name: "boot.js", data: enc.encode(boot) },
    { name: "bridge.js", data: enc.encode(bridge) },
    { name: "inject.js", data: enc.encode(inject) },
    { name: "icon16.png", data: pngGlyph(16, [184, 255, 60], "P") },
    { name: "icon32.png", data: pngGlyph(32, [184, 255, 60], "P") },
    { name: "README.txt", data: enc.encode(readme) },
  ]);
}

// Compare paths, not URL strings. On Windows import.meta.url is file:///C:/...
// while argv[1] is C:\..., and the old string compare silently never matched.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const origin = process.env.AS_ORIGIN || "http://127.0.0.1:8787";
  const buf = packExtension({ origin });
  const out = join(root, "dist/pagearm-extension.zip");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(out, buf);
  console.log("wrote", out, buf.length);
}
