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

The README stills are rendered from `docs/src/*.html` at 1100 CSS pixels wide with a device scale factor of 2. `desk.png` is a shot of the live desk. `npm run docs` re-renders them. Do not hand-edit a PNG.

## How to work

- Agent source lives in `agents/` and on the desk textarea. `scripts/wrap.mjs` is the boring IIFE. Do not clever it up. PREFIX may grow a helper (open shadow, composed punch, InputEvent type, onCleanup, watch, when, must, ask) but the shape stays an IIFE that collects arms. `armAll` walks with a recursive `step` so a sync arm still finishes in this turn, which `check.mjs` relies on. A thenable is awaited. Do not switch the empty-stack `pip("ok")` to `Promise.resolve()`. `BODY_OFFSET` is measured from `wrapAgent` itself, so PREFIX can grow a line without the editor lying.
- The desk drawer is `agents/drawer/*.js`, one file per name. `agents/stack.json` holds the stack, the ordered list of drawer names the agent is built from (a desk that last ran the one-script version wrote `agents/current.json`, which is read once and then replaced). Both are gitignored. The desk serves those files directly, so saving one is already the live change and there is no second copy to keep in step. An empty stack falls back to `agents/current.js`, the scratch pad. Changing the stack moves the hash and the shell swaps on the next navigation, which is why none of this reaches `extension/`.
- Several scripts, still one agent: one `window.__agent`, one `__PA_VER`, one toolbar light, one host list. `wrap.mjs` gives each script its own function body and harvests its `arm` as it finishes, so neighbors do not collide and one that throws does not stop the rest. Composition, not dispatch. Do not grow this into per-script `@match` rules, a second agent object, or anything that runs a script on a host the manifest does not already carry. The pip is shared and last write wins, so say so rather than arbitrating it in `background.js`.
- A drawer name is `^[a-z0-9][a-z0-9_-]{0,47}$`, lowercased, because it becomes a filename. Validate through `drawerName` in `scripts/serve.mjs` and nowhere else. A stack is capped at 16 and is compiled as one file before it is saved, because that is what the browser will parse.
- Host pattern changes need a new zip and an extension reload. Hot-swap cannot invent `host_permissions`.
- Toolbar letter is **P**. Message source is `pa`. Globals: `__pagearm`, `__agent`, `__PA_ORIGIN`, `__PA_VER`.
- A script that throws paints P red, says so in that page's console, and posts `oops` to the bridge, which the background forwards to `POST {desk}/api/oops` as `text/plain`, so no browser asks for a preflight. Same message twice inside five seconds travels once. The desk keeps the last ten in memory and never on disk: it is a workshop light, not a log file, and no analytics live here. Only the desk page and an extension `Origin` may write there, which is `fromShell` in `scripts/serve.mjs`. `ask` is capture-shaped: bridge to background to `POST /api/ask`, desk answers, background polls, bridge posts `ask-result`. `must` is oops-shaped, last twenty, in memory. Prove is a desk iframe of `/sample.html` and never the live tab; it auto-answers `ask` with the first choice. Write is a draft plus a critic (`POST /api/author`). Enhance is three drafts, a Look seed, a critic merge, then prove and one heal on the sample page (`POST /api/enhance`). `/api/forge` still writes three drafts for the desk internals. All three need `XAI_API_KEY`, except Enhance with a Look and no key still returns the compiled trace. If Look has a trace or a control sketch, Write/Enhance use that live page instead of the sample sketch and do not prove on `/sample.html`. After Save, the desk watches live `must` and Heal uses that miss. Look records in the isolated bridge, not wrap, never writes a password, and starts on the next click of P (`look-on` / `look-off`). On start and stop it sketches visible controls. After a punch it records nodes that became visible (`kind: "seen"`), and compile `must`s that instead of the button. Compile lives in `scripts/look.mjs`. Look flushes typing before a punch, walks composedPath to the control, prefers id/name/aria-label/data-testid, and does not wipe a take if you hit Record twice. `node scripts/look-sim.mjs` is a Playwright drive of that path; `npm run check` does not need Playwright. Do not add a ninth zip file. Do not grow wrap with a prove mode or a recorder, and do not parent.postMessage: the bridge contract is `window.postMessage`. Do not hang `data-pa-bridge` on the document. Do not claim the page cannot see you.
- The live agent runs only on the manifest's host list and never on the desk page. No `<all_urls>`. Permissions: `scripting`, `webNavigation`, `activeTab`, `userScripts`.
- Hot-swap goes through `userScripts.execute` (Chrome 135+ with **Allow User Scripts** on, Firefox 153+ once the optional permission is granted at a click on P) and falls back to `eval` otherwise, which is always the case on Safari. `__PA_VER` is written after the code ran, never before.
- `arm()` may run twice on a page load (packed copy, then live). Write it idempotent.
- The desk binds `127.0.0.1`, has no CORS, checks `Host`, `Origin`, and `Sec-Fetch-Site` on every write including the drawer routes, and rejects source that does not parse, with the line number in the editor's own numbering.
- Every request goes through one guard in `scripts/serve.mjs` that answers 500 and keeps serving. A desk you leave running for days does not get to die over one request, and a bare `//`, which any page in the browser can ask for, used to kill it inside `new URL()`. Reads of drawer files are the same: a script that cannot be read is left out of the stack with a warning, never thrown. Do not add a route that reads a file outside `readScript`.
- `npm run check`, also `npm test`, packs all three targets in memory, reads each zip back, and validates every manifest and script. Add a line there when you add a promise.
- The manifest version is `package.json`'s version, read in `scripts/pack.mjs`. Do not type a version number anywhere else.
- License is PolyForm Small Business 1.0.0. Do not relicense as MIT. Do not add analytics. Do not claim the page cannot see you.
- American English. No em dashes. Warm comments.
- One zip per browser, each good on Mac, Windows, and Linux. Do not add a .app, an .exe, or a distro package. Safari's build is converted with `xcrun safari-web-extension-converter` on the user's own Mac, so no Xcode project lives here.

## Quick commands

```
npm start    # desk at http://127.0.0.1:8787
npm run pack # one zip per browser into dist/ (AS_TARGET=firefox for just one)
npm run check
npm run docs # re-render README stills, desk shot, and the Look clip
```
