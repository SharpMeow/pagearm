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
const stackListEl = document.getElementById("stack-list");
const drawerCountEl = document.getElementById("drawer-count");

// Two different things. `bound` is the drawer script the editor is holding.
// `stack` is the ordered list the browser is actually running, which is usually
// one name and occasionally a few.
let bound = null;
let stack = [];

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
  stack = data.stack || [];
  bound = data.bound || null;
  if (bound) drawerNameEl.value = bound;
}

function askedName() {
  return (drawerNameEl.value || bound || "").trim().toLowerCase();
}

function pretty(name) {
  return name.replace(/-/g, " ");
}

// A chip is one script: the name opens it in the editor, the ticks act on it.
function chip(parent, name, opts) {
  const pair = document.createElement("span");
  // Three states worth seeing at a glance: in the drawer, running, and the one
  // the editor is holding right now.
  pair.className = "pair" + (opts.live ? " live" : "") + (name === bound ? " editing" : "");
  if (opts.index) {
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(opts.index);
    pair.appendChild(idx);
  }
  const open = document.createElement("button");
  open.type = "button";
  open.className = "open";
  open.dataset.name = name;
  open.textContent = pretty(name);
  open.title = opts.title || "open in the editor";
  open.setAttribute("aria-pressed", name === bound ? "true" : "false");
  open.addEventListener("click", () => openFromDrawer(name));
  pair.appendChild(open);
  (opts.ticks || []).forEach((t) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tick";
    b.textContent = t.glyph;
    b.title = t.title;
    b.setAttribute("aria-label", t.title + ": " + name);
    b.addEventListener("click", t.onClick);
    pair.appendChild(b);
  });
  parent.appendChild(pair);
}

function drop(name) {
  return () => saveStack(stack.filter((n) => n !== name), pretty(name) + " is out of the agent.");
}

function renderStack() {
  stackListEl.innerHTML = "";
  if (!stack.length) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "nothing yet, so the agent is whatever is in the editor above";
    stackListEl.appendChild(empty);
    return;
  }
  stack.forEach((name, i) => {
    const ticks = [];
    // Order matters, so the only move you need is "earlier". Repeat it and the
    // script walks to the front.
    if (i > 0) {
      ticks.push({
        glyph: "\u2191",
        title: "run earlier",
        onClick: () => {
          const next = stack.slice();
          next[i - 1] = stack[i];
          next[i] = stack[i - 1];
          saveStack(next, pretty(name) + " runs earlier now.");
        },
      });
    }
    ticks.push({ glyph: "\u00d7", title: "take out of the agent", onClick: drop(name) });
    chip(stackListEl, name, { live: true, index: i + 1, ticks, title: "open in the editor" });
  });
}

function renderDrawer(scripts) {
  drawerListEl.innerHTML = "";
  drawerCountEl.textContent = scripts.length
    ? scripts.length + (scripts.length === 1 ? " script" : " scripts") + ", " + stack.length + " running"
    : "";
  if (!scripts.length) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "empty. Name what is in the editor and save it here.";
    drawerListEl.appendChild(empty);
    return;
  }
  scripts.forEach((s) => {
    const running = stack.includes(s.name);
    chip(drawerListEl, s.name, {
      live: running,
      title: running ? "running. Click to open it in the editor" : "open in the editor",
      ticks: [
        running
          ? { glyph: "\u2212", title: "take out of the agent", onClick: drop(s.name) }
          : {
              glyph: "+",
              title: "add to the agent",
              onClick: () => saveStack(stack.concat([s.name]), pretty(s.name) + " runs too now. Open or reload a tab."),
            },
      ],
    });
  });
}

// The last shelf the desk was told about. Held so a render that only knows the
// stack changed still redraws the drawer's dots and its count.
let shelf = [];

function renderAll(scripts) {
  if (scripts) shelf = scripts;
  renderStack();
  renderDrawer(shelf);
}

async function loadDrawer() {
  const r = await fetch("/api/drawer");
  const data = await r.json();
  stack = data.stack || [];
  renderAll(data.scripts || []);
}

// One place writes the stack, so the desk and the desk's story about itself
// cannot disagree.
async function saveStack(names, note) {
  drawerState.textContent = "arming…";
  try {
    const r = await fetch("/api/stack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names }),
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      drawerState.textContent = "not changed: " + (data.error || r.status);
      await loadDrawer().catch(() => {});
      return;
    }
    stack = data.stack || [];
    renderAll(data.scripts);
    drawerState.textContent = note || "the agent changed. Open or reload a tab.";
    saveState.textContent = "";
  } catch (e) {
    drawerState.textContent = "desk unreachable";
  }
}

function stackNote(name) {
  const at = stack.indexOf(name);
  if (at < 0) return pretty(name) + " is open. It is not part of the agent yet.";
  if (stack.length === 1) return pretty(name) + " is open, and it is the agent.";
  return pretty(name) + " is open. It runs " + (at + 1) + " of " + stack.length + ".";
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
  drawerState.textContent = stackNote(name);
  saveState.textContent = "";
  await loadDrawer().catch(() => {});
}

// Save the editor under a drawer name, then optionally make that one the whole
// agent. Doing both in that order means the thing that goes live is what you
// are looking at, not whatever the file held before you started typing.
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
      showBroken(data.error);
      return;
    }
    bound = name;
    drawerNameEl.value = name;
    stack = data.stack || [];
    if (!makeLive) {
      drawerState.textContent = data.armed
        ? "saved to " + name + ", which the agent is running. Open or reload a tab."
        : "saved to " + name + ". Not part of the agent yet.";
      renderAll(data.scripts);
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
    stack = out.stack || [name];
    drawerState.textContent = name + " is the agent now, on its own. Open or reload a tab.";
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
    const wasRunning = stack.includes(name);
    if (bound === name) bound = null;
    stack = data.stack || [];
    drawerNameEl.value = "";
    renderAll(data.scripts);
    drawerState.textContent = wasRunning
      ? name + " is gone, and out of the agent. Tabs keep the old copy until the next navigation."
      : name + " is gone.";
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
      showBroken(data.error);
      return;
    }
    stack = data.stack || [];
    saveState.textContent = bound
      ? "saved to " + bound + " and armed. open or reload a tab."
      : "saved. open or reload a tab.";
    loadDrawer().catch(() => {});
  } catch (e) {
    saveState.textContent = "not saved: desk unreachable";
  }
}

// A syntax error comes back with the line it broke on. Put the cursor there,
// because hunting for line 34 by eye is the least pleasant part of a typo.
function showBroken(message) {
  const m = /\(line (\d+)\)/.exec(String(message || ""));
  if (!m) return;
  const line = Number(m[1]);
  const lines = source.value.split("\n");
  if (line < 1 || line > lines.length) return;
  let at = 0;
  for (let i = 0; i < line - 1; i++) at += lines[i].length + 1;
  source.focus();
  source.setSelectionRange(at, at + lines[line - 1].length);
  try {
    // Selecting does not always scroll, so put the line near the middle.
    const step = parseFloat(getComputedStyle(source).lineHeight) || 20;
    source.scrollTop = Math.max(0, (line - 1) * step - source.clientHeight / 2);
  } catch (e) {}
}

// Tab belongs to the code, not to the focus ring. Escape first, then Tab, to
// leave the editor with the keyboard.
let tabLeaves = false;
source.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    tabLeaves = true;
    return;
  }
  if (ev.key !== "Tab") {
    tabLeaves = false;
    return;
  }
  if (tabLeaves || ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey) {
    tabLeaves = false;
    return;
  }
  ev.preventDefault();
  const pad = "  ";
  let typed = false;
  // execCommand is the deprecated one that keeps undo working, so try it first.
  try { typed = document.execCommand("insertText", false, pad); } catch (e) {}
  if (!typed) {
    const at = source.selectionStart;
    const end = source.selectionEnd;
    source.value = source.value.slice(0, at) + pad + source.value.slice(end);
    source.selectionStart = source.selectionEnd = at + pad.length;
  }
});

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
