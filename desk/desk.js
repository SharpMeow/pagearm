const source = document.getElementById("source");
const hosts = document.getElementById("hosts");
const saveBtn = document.getElementById("save");
const saveState = document.getElementById("save-state");
const download = document.getElementById("download");
const examplesEl = document.getElementById("examples");
const browsersEl = document.getElementById("browsers");
const stepsEl = document.getElementById("steps");
const noteEl = document.getElementById("browser-note");
const drawerListEl = document.getElementById("drawer-list");
const drawerNameEl = document.getElementById("drawer-name");
const drawerState = document.getElementById("drawer-state");
const drawerSaveBtn = document.getElementById("drawer-save");
const drawerLiveBtn = document.getElementById("drawer-live");
const drawerDeleteBtn = document.getElementById("drawer-delete");

// Two names, and they are not the same thing. `bound` is the drawer script the
// editor is holding. `live` is the one the browser is actually running.
let bound = null;
let live = null;

// Same shell everywhere. The manifest and the install ritual differ, so the
// desk hands over the zip for the browser you say you are using.
const BROWSERS = {
  chromium: {
    label: "Chromium",
    steps: [
      "Chrome, Edge, Brave, Opera, Arc, or Chromium on Mac, Windows, or Linux.",
      "Download the zip. Unzip it. Keep the folder that holds <code>manifest.json</code> (Windows Extract All sometimes nests an extra folder).",
      "<code>chrome://extensions</code> or <code>edge://extensions</code> → Developer mode → Load unpacked.",
      "Extension Details → turn on <strong>Allow User Scripts</strong> if the browser shows it. That lets hot-swap through a strict CSP.",
      "Pin <strong>P</strong>. Hover is P. Green means the agent armed.",
    ],
    note: "Chrome 135 and newer run hot-swap through the userScripts API, which a strict Content Security Policy cannot refuse. Older builds, or the toggle left off, fall back to eval and those sites keep the packed copy.",
  },
  firefox: {
    label: "Firefox",
    steps: [
      "Firefox 128 or newer on Mac, Windows, or Linux.",
      "Download the zip. Unzip it. Keep the folder that holds <code>manifest.json</code>.",
      "<code>about:debugging#/runtime/this-firefox</code> → <strong>Load Temporary Add-on</strong> → pick <code>manifest.json</code>.",
      "Click <strong>P</strong> once. Firefox 153 and newer ask to allow user scripts. Say yes and hot-swap works through a strict CSP.",
      "Pin <strong>P</strong>. Hover is P. Green means the agent armed.",
    ],
    note: "A temporary add-on is gone when you quit Firefox. Load it again, or sign the zip at addons.mozilla.org and install the signed file. Firefox Developer Edition and ESR can also be set to accept unsigned add-ons permanently.",
  },
  safari: {
    label: "Safari",
    steps: [
      "Safari 18.4 or newer, on a Mac, with Xcode installed.",
      "Download the zip and unzip it.",
      "<code>xcrun safari-web-extension-converter --macos-only /path/to/folder</code>, then run the app Xcode builds, once.",
      "Safari → Settings → Advanced → show the developer features, then Develop → <strong>Allow unsigned extensions</strong>. Safari forgets that on every full quit.",
      "Safari → Settings → Extensions → turn P on and allow it on your host list. Pin <strong>P</strong>.",
    ],
    note: "Safari has no userScripts API, so a site with a strict CSP keeps the packed copy. It also has no history-state navigation event, so a route change inside a single-page app re-arms on back, forward, a hash change, a real load, or a click on P.",
  },
};

let browser = "chromium";

function refreshDownload() {
  const q = new URLSearchParams({ hosts: hosts.value, browser });
  download.href = "/extension.zip?" + q.toString();
  download.textContent = "Download for " + BROWSERS[browser].label;
}

function renderBrowser() {
  stepsEl.innerHTML = "";
  BROWSERS[browser].steps.forEach((html) => {
    const li = document.createElement("li");
    li.innerHTML = html;
    stepsEl.appendChild(li);
  });
  noteEl.textContent = BROWSERS[browser].note;
  Array.from(browsersEl.children).forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.browser === browser ? "true" : "false");
  });
  refreshDownload();
}

function renderPicker() {
  browsersEl.innerHTML = "";
  Object.keys(BROWSERS).forEach((id) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.browser = id;
    b.textContent = BROWSERS[id].label;
    b.addEventListener("click", () => {
      browser = id;
      renderBrowser();
    });
    browsersEl.appendChild(b);
  });
}

// A guess, not a decision. Every button stays one click away.
function guessBrowser() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|OPR\//.test(ua)) return "safari";
  return "chromium";
}

hosts.addEventListener("input", refreshDownload);
browser = guessBrowser();
renderPicker();
renderBrowser();

async function load() {
  const r = await fetch("/api/agent");
  const data = await r.json();
  source.value = data.source || "";
  live = data.live || null;
  bound = live;
  if (live) drawerNameEl.value = live;
}

function askedName() {
  return (drawerNameEl.value || bound || "").trim().toLowerCase();
}

function renderDrawer(scripts) {
  drawerListEl.innerHTML = "";
  if (!scripts.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "empty";
    drawerListEl.appendChild(empty);
    return;
  }
  scripts.forEach((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.name = s.name;
    b.textContent = s.name.replace(/-/g, " ");
    b.setAttribute("aria-pressed", s.name === bound ? "true" : "false");
    if (s.name === live) {
      b.classList.add("live");
      b.title = "this one is the agent";
    }
    b.addEventListener("click", () => openFromDrawer(s.name));
    drawerListEl.appendChild(b);
  });
}

async function loadDrawer() {
  const r = await fetch("/api/drawer");
  const data = await r.json();
  live = data.live || null;
  renderDrawer(data.scripts || []);
}

async function openFromDrawer(name) {
  const r = await fetch("/api/drawer/" + encodeURIComponent(name));
  const data = await r.json();
  if (!r.ok) {
    drawerState.textContent = "could not open " + name + ": " + (data.error || r.status);
    return;
  }
  source.value = data.source || "";
  bound = name;
  drawerNameEl.value = name;
  drawerState.textContent = name === live
    ? name + " is open, and it is the agent."
    : name + " is open. Make it the agent to hot-swap it in.";
  saveState.textContent = "";
  await loadDrawer().catch(() => {});
}

// Save the editor under a drawer name, then optionally make that one the agent.
// Doing both in that order means the thing that goes live is what you are
// looking at, not whatever the file held before you started typing.
async function putInDrawer(makeLive) {
  const name = askedName();
  if (!name) {
    drawerState.textContent = "give it a name first: letters, digits, dash, underscore.";
    drawerNameEl.focus();
    return;
  }
  drawerState.textContent = makeLive ? "arming…" : "saving…";
  try {
    const r = await fetch("/api/drawer/" + encodeURIComponent(name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: source.value }),
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      drawerState.textContent = "not saved: " + (data.error || r.status);
      return;
    }
    bound = name;
    drawerNameEl.value = name;
    live = data.live || null;
    if (!makeLive) {
      drawerState.textContent = data.armed
        ? "saved to " + name + ", which is the agent. Open or reload a tab."
        : "saved to " + name + ". Not the agent yet.";
      renderDrawer(data.scripts || []);
      return;
    }
    const p = await fetch("/api/drawer/" + encodeURIComponent(name) + "/live", { method: "POST" });
    let out = {};
    try { out = await p.json(); } catch (e) {}
    if (!p.ok) {
      drawerState.textContent = "saved, but not armed: " + (out.error || p.status);
      await loadDrawer().catch(() => {});
      return;
    }
    live = out.live || name;
    drawerState.textContent = name + " is the agent now. Open or reload a tab.";
    saveState.textContent = "";
    await loadDrawer().catch(() => {});
  } catch (e) {
    drawerState.textContent = "desk unreachable";
  }
}

async function removeFromDrawer() {
  const name = askedName();
  if (!name) {
    drawerState.textContent = "name the one to throw out.";
    return;
  }
  if (!confirm("Delete " + name + " from the drawer?")) return;
  try {
    const r = await fetch("/api/drawer/" + encodeURIComponent(name), { method: "DELETE" });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      drawerState.textContent = "not deleted: " + (data.error || r.status);
      return;
    }
    if (bound === name) bound = null;
    live = data.live || null;
    drawerNameEl.value = "";
    renderDrawer(data.scripts || []);
    drawerState.textContent = name === live
      ? name + " is gone."
      : name + " is gone. Whatever was armed keeps running until you save another one.";
  } catch (e) {
    drawerState.textContent = "desk unreachable";
  }
}

async function loadExamples() {
  const r = await fetch("/api/examples");
  const data = await r.json();
  examplesEl.innerHTML = "";
  (data.examples || []).forEach((ex) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = ex.id.replace(/-/g, " ");
    b.addEventListener("click", () => {
      source.value = ex.source;
      // An example is a fresh sheet of paper, not the drawer script you had open.
      bound = null;
      drawerNameEl.value = ex.id;
      drawerState.textContent = "example loaded. Save it to the drawer to keep it.";
      renderDrawer([]);
      loadDrawer().catch(() => {});
      saveState.textContent = "unsaved example";
    });
    examplesEl.appendChild(b);
  });
}

async function save() {
  saveState.textContent = "saving…";
  try {
    const r = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: source.value, name: bound }),
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      saveState.textContent = "not saved: " + (data.error || r.status);
      return;
    }
    live = data.live || null;
    saveState.textContent = bound
      ? "saved to " + bound + " and armed. open or reload a tab."
      : "saved. open or reload a tab.";
    loadDrawer().catch(() => {});
  } catch (e) {
    saveState.textContent = "not saved: desk unreachable";
  }
}

saveBtn.addEventListener("click", save);
drawerSaveBtn.addEventListener("click", () => putInDrawer(false));
drawerLiveBtn.addEventListener("click", () => putInDrawer(true));
drawerDeleteBtn.addEventListener("click", removeFromDrawer);
drawerNameEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    putInDrawer(false);
  }
});

// Cmd+S / Ctrl+S saves the agent instead of the page.
document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    save();
  }
});

load()
  .catch(() => {
    saveState.textContent = "could not load agent";
  })
  .then(() => loadDrawer())
  .catch(() => {
    drawerState.textContent = "could not read the drawer";
  });
loadExamples().catch(() => {});
