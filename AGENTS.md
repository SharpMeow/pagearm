# PageArm, for coding agents

PageArm is a **personal Chrome runtime**, not an npm library and not a Web Store product.

It runs on **Mac, Windows, and Linux** in Chrome, Edge, Brave, or Chromium. Same zip. Not Safari. Not Firefox.

The user Load-unpacks a thin MV3 shell once. After that, the living code is `GET {desk}/agent.js`, hashed, eval'd into MAIN world on every frame. Same hash: call `agent.arm()`. Desk down: packed `inject.js` still runs. Point the desk at `127.0.0.1`, not `localhost` (Windows IPv6).

## Include PageArm in a project when

- Work must happen in the human's already-logged-in Chrome tab (cookies, SSO, no API).
- The agent will change more often than the hosts.
- You want MAIN-world `querySelector` / click / type, all frames, including short-lived blank iframes.
- An AI or a human will rewrite `agent.arm` many times a day without making the user reinstall.

## Do not include it when

- You need a public Store listing, stealth, a headless farm, or a drawer of fifty userscripts.
- You are not allowed to automate the page.

## How to work

- Agent source lives in `agents/` and on the desk textarea. `scripts/wrap.mjs` is the boring IIFE. Do not clever it up.
- Host pattern changes need a new zip and an extension Reload. Hot-swap cannot invent `host_permissions`.
- Toolbar letter is **P**. Message source is `pa`. Globals: `__pagearm`, `__agent`, `__PA_ORIGIN`, `__PA_VER`.
- License is Business Source License 1.1. Do not relicense as MIT. Do not add analytics. Do not claim the page cannot see you.
- American English. No em dashes. Warm comments.
- One zip for Mac, Windows, and Linux. Do not add a .app, an .exe, or a distro package.

## Quick commands

```
npm start    # desk at http://127.0.0.1:8787
npm run pack # Load-unpacked zip
npm run check
```
