# PageArm, for coding agents

PageArm is a **personal browser runtime**, not an npm library and not a store product.

It runs on **Mac, Windows, and Linux** in any Chromium browser, in Firefox 142+, and in Safari 18.4+ on a Mac. One codebase, one desk, one agent, three manifests. `npm run pack` writes one zip per browser.

The user installs a thin MV3 shell once. After that, the living code is `GET {desk}/agent.js`, hashed, eval'd into MAIN world on every frame. Same hash: call `agent.arm()`. Desk down: packed `inject.js` still runs. Point the desk at `127.0.0.1`, not `localhost` (Windows IPv6).

## Include PageArm in a project when

- Work must happen in the human's already-logged-in tab (cookies, SSO, no API), in whichever browser that is.
- The agent will change more often than the hosts.
- You want MAIN-world `querySelector` / click / type, all frames, including short-lived blank iframes.
- An AI or a human will rewrite `agent.arm` many times a day without making the user reinstall.

## Do not include it when

- You need a public store listing, stealth, a headless farm, or fifty userscripts live on fifty sites at once.
- You are not allowed to automate the page.

## The three browsers

The shell is one codebase. Only the manifest forks, over four things, and `scripts/pack.mjs` is the only place that knows:

- **Background.** Chromium and Safari take `service_worker`. Firefox has none and takes `scripts` as a non-persistent event page. Same file either way.
- **userScripts.** Chromium declares it in `permissions`. Firefox refuses that and only allows `optional_permissions`, asked for at a click on P, which is the one user gesture it accepts. Safari has no such API, so neither key is emitted.
- **Identity.** Firefox needs `browser_specific_settings.gecko` with an id, a `strict_min_version` of 142.0, and `data_collection_permissions: { required: ["none"] }`. It also refuses a one-character name, so that build is named PageArm while the others stay P.
- **Navigation.** Safari has no `webNavigation.onHistoryStateUpdated`. The bridge relays `popstate` and `hashchange` as a `nav` message, and the background drops it where the real event exists.

Write shell code against the `api` shim at the top of `background.js` and `bridge.js`, never `chrome.` directly. `npm run check` fails the build if you reach for `chrome.` again. Firefox and Safari answer with promises and Chromium with callbacks, so anything new that takes a callback needs the same two-shape treatment `captureVisible` already has.

Verify the Firefox build with `npx web-ext lint --source-dir dist/pagearm-firefox`. One warning, `DANGEROUS_EVAL`, is expected and is the CSP fallback.

The two README images are rendered from `docs/src/*.html` at 1100 CSS pixels wide with a device scale factor of 2. Edit the HTML and re-render. Do not hand-edit a PNG.

## How to work

- Agent source lives in `agents/` and on the desk textarea. `scripts/wrap.mjs` is the boring IIFE. Do not clever it up.
- The desk drawer is `agents/drawer/*.js`, one file per name, with `agents/current.json` pointing at whichever one `agents/current.js` was copied from. Both are gitignored. Many scripts on the shelf, exactly one live: promoting one rewrites `current.js`, the hash moves, and the shell swaps on the next navigation. Do not grow this into a dispatcher that runs several agents on several hosts at once. A drawer name is `^[a-z0-9][a-z0-9_-]{0,47}$`, lowercased, because it becomes a filename. Validate through `drawerName` in `scripts/serve.mjs` and nowhere else.
- Host pattern changes need a new zip and an extension reload. Hot-swap cannot invent `host_permissions`.
- Toolbar letter is **P**. Message source is `pa`. Globals: `__pagearm`, `__agent`, `__PA_ORIGIN`, `__PA_VER`.
- The live agent runs only on the manifest's host list and never on the desk page. No `<all_urls>`. Permissions: `scripting`, `webNavigation`, `activeTab`, `userScripts`.
- Hot-swap goes through `userScripts.execute` (Chrome 135+ with **Allow User Scripts** on, Firefox 153+ once the optional permission is granted at a click on P) and falls back to `eval` otherwise, which is always the case on Safari. `__PA_VER` is written after the code ran, never before.
- `arm()` may run twice on a page load (packed copy, then live). Write it idempotent.
- The desk binds `127.0.0.1`, has no CORS, checks `Host`, `Origin`, and `Sec-Fetch-Site` on every write including the drawer routes, and rejects source that does not parse.
- `npm run check` packs all three targets in memory, reads each zip back, and validates every manifest and script. Add a line there when you add a promise.
- License is Business Source License 1.1. Do not relicense as MIT. Do not add analytics. Do not claim the page cannot see you.
- American English. No em dashes. Warm comments.
- One zip per browser, each good on Mac, Windows, and Linux. Do not add a .app, an .exe, or a distro package. Safari's build is converted with `xcrun safari-web-extension-converter` on the user's own Mac, so no Xcode project lives here.

## Quick commands

```
npm start    # desk at http://127.0.0.1:8787
npm run pack # one zip per browser into dist/ (AS_TARGET=firefox for just one)
npm run check
```
