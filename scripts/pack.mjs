import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { zipFiles, pngGlyph } from "./zip.mjs";
import { wrapPacked } from "./wrap.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_HOSTS = ["https://*/*", "http://127.0.0.1/*", "http://localhost/*"];

// One shell, three houses. The code is the same in all three. The manifest is
// not, because the three browsers disagree about exactly four things: where the
// background lives, whether userScripts is a permission you declare or one you
// ask for, whether an add-on needs an id, and whether userScripts exists at all.
export const TARGETS = ["chromium", "firefox", "safari"];

export const TARGET_LABELS = {
  chromium: "Chrome, Edge, Brave, Opera, Arc, Chromium",
  firefox: "Firefox",
  safari: "Safari",
};

export function normalizeTarget(t) {
  const s = String(t || "").trim().toLowerCase();
  if (TARGETS.includes(s)) return s;
  // Be kind about what people type into a query string.
  if (["chrome", "edge", "brave", "opera", "arc"].includes(s)) return "chromium";
  if (["gecko", "mozilla", "ff"].includes(s)) return "firefox";
  if (["webkit", "apple"].includes(s)) return "safari";
  return "chromium";
}

export function zipName(target) {
  return `pagearm-${normalizeTarget(target)}.zip`;
}

export function buildManifest({ origin, hosts, target }) {
  const t = normalizeTarget(target);
  const o = String(origin || "http://127.0.0.1:8787").replace(/\/$/, "");
  const matches = (hosts && hosts.length ? hosts : DEFAULT_HOSTS).map((h) => String(h).trim()).filter(Boolean);

  // Host permissions are exactly the match list plus the desk. No <all_urls>:
  // the agent runs where you said it may, and nowhere else.
  const hostPermissions = Array.from(new Set([...matches, `${o}/*`]));

  const manifest = {
    manifest_version: 3,
    name: "P",
    version: "0.2.0",
    description: "PageArm runtime. Load unpacked only.",
    action: {
      default_title: "P",
      default_icon: { 16: "icon16.png", 32: "icon32.png" },
    },
    icons: { 16: "icon16.png", 32: "icon32.png" },
    // Firefox has no service worker for extensions. It runs the same file as a
    // non-persistent event page, woken by the same webNavigation listeners.
    background: t === "firefox" ? { scripts: ["background.js"] } : { service_worker: "background.js" },
    permissions: ["scripting", "webNavigation", "activeTab"],
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

  if (t === "chromium") {
    // userScripts lets the worker inject a code string past the page's CSP.
    // Chrome shows an "Allow User Scripts" toggle for it. Off, we fall back to eval.
    manifest.permissions.push("userScripts");
  }

  if (t === "firefox") {
    // Firefox will not let userScripts be a declared permission. It is opt-in
    // only, asked for at a click on P, so it lives here instead.
    manifest.optional_permissions = ["userScripts"];
    // Firefox will not take a one-character extension name. The toolbar still
    // shows the painted P and the hover is still P, so only the add-ons list
    // reads differently.
    manifest.name = "PageArm";
    // MAIN world content scripts landed in 128, the optional userScripts
    // permission in 136, and the data collection key in 140 on desktop and 142
    // on Android. The floor is the last of those. Everything below it has been
    // retired for a year.
    manifest.browser_specific_settings = {
      gecko: {
        id: "pagearm@local",
        strict_min_version: "142.0",
        // PageArm collects nothing and sends nothing anywhere. Firefox wants
        // that said out loud, so it is said out loud.
        data_collection_permissions: { required: ["none"] },
      },
    };
  }

  // Safari has no userScripts API at all, so it gets neither key. Strict-CSP
  // sites there keep the packed copy, which is the same thing that happens in
  // Chrome with the toggle off.

  return manifest;
}

function readme(origin, target) {
  const o = origin;
  const banner = `
 ____                     _
|  _ \\ __ _  __ _  ___   / \\   _ __ _ __ ___
| |_) / _\` |/ _\` |/ _ \\ / _ \\ | '__| '_ \` _ \\
|  __/ (_| | (_| |  __// ___ \\| |  | | | | | |
|_|   \\__,_|\\__, |\\___/_/   \\_\\_|  |_| |_| |_|
            |___/

  personal browser runtime    Mac · Windows · Linux
`;

  const desk = `
Desk: ${o}
  Use 127.0.0.1, not localhost. Windows maps localhost to IPv6
  sometimes and the background cannot fetch the agent.
  Node 18+ is only for the desk. This packed copy still runs
  if the desk is asleep. Close the laptop. You are fine.
`;

  if (target === "firefox") {
    return `${banner}
Hey. You unzipped the Firefox build. That is the shell. The living
agent lives on the desk at ${o}, not in these files.

1. Keep the folder that contains THIS README and manifest.json.
   Windows Extract All sometimes nests an extra folder. Go in one level.
2. Firefox 128 or newer. about:debugging#/runtime/this-firefox
3. "Load Temporary Add-on", then pick manifest.json in THIS folder.
   Temporary means it is gone when you quit Firefox. Load it again,
   or sign it at addons.mozilla.org and install the signed file to
   keep it. Firefox Developer Edition and ESR can also be told to
   accept unsigned add-ons permanently.
4. Click P once. On Firefox 153 and newer it asks to allow user
   scripts. Say yes and hot-swap works on sites with a strict
   Content Security Policy. Say no, or run an older Firefox, and
   those sites keep this packed copy.
5. Pin P. Green means armed. Hover is just P.
${desk}`;
  }

  if (target === "safari") {
    return `${banner}
Hey. You unzipped the Safari build. That is the shell. The living
agent lives on the desk at ${o}, not in these files.

Safari does not load an unpacked folder. It loads an app, and the
app is built on a Mac with Xcode. This folder is the extension that
goes inside it.

1. Safari 18.4 or newer, macOS, Xcode installed.
2. xcrun safari-web-extension-converter --macos-only /path/to/this/folder
3. Xcode opens. Run the app it made, once.
4. Safari > Settings > Advanced > "Show features for web developers".
   Then Develop > "Allow unsigned extensions". Safari forgets that
   every time you fully quit, so flip it again after a restart.
5. Safari > Settings > Extensions. Turn P on and allow it on the
   sites in your host list.
6. Pin P. Green means armed. Hover is just P.

Two things are smaller here. Safari has no userScripts API, so a site
with a strict Content Security Policy keeps this packed copy instead
of the live agent. And Safari has no history-state navigation event,
so a route change inside a single-page app re-arms on back, forward,
a hash change, a real page load, or a click on P.
${desk}`;
  }

  return `${banner}
Hey. You unzipped the Chromium build. That is the shell. The living
agent lives on the desk at ${o}, not in these files.

1. Keep the folder that contains THIS README and manifest.json.
   Windows Extract All sometimes nests an extra folder. Go in one level.
2. chrome://extensions  (Edge: edge://extensions, Brave: brave://extensions)
3. Developer mode on. Load unpacked on THIS folder.
4. Open the extension's Details and turn on "Allow User Scripts" if
   the browser shows it. That lets the desk swap code on sites with a
   strict Content Security Policy. Without it those sites keep this
   packed copy.
5. Pin P. Green means armed. Hover is just P.
${desk}`;
}

export function packExtension({ origin, hosts, agentSource, target }) {
  const t = normalizeTarget(target);
  const o = String(origin || "http://127.0.0.1:8787").replace(/\/$/, "");
  const manifest = buildManifest({ origin: o, hosts, target: t });

  const background = readFileSync(join(root, "extension/background.js"), "utf8").replaceAll(
    "__PA_ORIGIN__",
    o,
  );
  const boot = `window.__PA_ORIGIN = ${JSON.stringify(o)};\n`;
  const inject = wrapPacked(agentSource || readFileSync(join(root, "agents/hello.js"), "utf8"));
  const bridge = readFileSync(join(root, "extension/bridge.js"), "utf8");

  const enc = new TextEncoder();
  return zipFiles([
    { name: "manifest.json", data: enc.encode(JSON.stringify(manifest, null, 2)) },
    { name: "background.js", data: enc.encode(background) },
    { name: "boot.js", data: enc.encode(boot) },
    { name: "bridge.js", data: enc.encode(bridge) },
    { name: "inject.js", data: enc.encode(inject) },
    { name: "icon16.png", data: pngGlyph(16, [184, 255, 60], "P") },
    { name: "icon32.png", data: pngGlyph(32, [184, 255, 60], "P") },
    { name: "README.txt", data: enc.encode(readme(o, t)) },
  ]);
}

// Compare paths, not URL strings. On Windows import.meta.url is file:///C:/...
// while argv[1] is C:\..., and the old string compare silently never matched.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const origin = process.env.AS_ORIGIN || "http://127.0.0.1:8787";
  // One command, three zips. Hand a person the one their browser wants.
  const only = process.env.AS_TARGET ? [normalizeTarget(process.env.AS_TARGET)] : TARGETS;
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const target of only) {
    const buf = packExtension({ origin, target });
    const out = join(root, "dist", zipName(target));
    writeFileSync(out, buf);
    console.log("wrote", out, buf.length);
  }
}
