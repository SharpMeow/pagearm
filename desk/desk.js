const source = document.getElementById("source");
const hosts = document.getElementById("hosts");
const saveBtn = document.getElementById("save");
const saveState = document.getElementById("save-state");
const download = document.getElementById("download");
const examplesEl = document.getElementById("examples");
const browsersEl = document.getElementById("browsers");
const stepsEl = document.getElementById("steps");
const noteEl = document.getElementById("browser-note");

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
      body: JSON.stringify({ source: source.value }),
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      saveState.textContent = "not saved: " + (data.error || r.status);
      return;
    }
    saveState.textContent = "saved. open or reload a tab.";
  } catch (e) {
    saveState.textContent = "not saved: desk unreachable";
  }
}

saveBtn.addEventListener("click", save);

// Cmd+S / Ctrl+S saves the agent instead of the page.
document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    save();
  }
});

load().catch(() => {
  saveState.textContent = "could not load agent";
});
loadExamples().catch(() => {});
