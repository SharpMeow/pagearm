// Thin shell. This file should get boring and stay boring.
// The living agent is GET {desk}/agent.js, hashed, then injected into MAIN.

const ORIGIN = "__PA_ORIGIN__";
const COLORS = { idle: "#8b9098", work: "#c8a24a", ok: "#b8ff3c", err: "#e24b4b" };
const FETCH_TIMEOUT_MS = 1500;
const CACHE_MS = 1500;

// The agent only runs where the manifest says it may. The content scripts and
// the live path read the same list, so the two never disagree about a site.
function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegExp(p) {
  if (p === "<all_urls>") return /^(https?|file|ftp):\/\//;
  var m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(p);
  if (!m) return null;
  var scheme = m[1] === "*" ? "https?" : m[1];
  var host = m[2];
  var hostRe;
  if (host === "*") hostRe = "[^/]*";
  else if (host.indexOf("*.") === 0) hostRe = "([^/]*\\.)?" + escapeRe(host.slice(2)) + "(:\\d+)?";
  else if (host.indexOf(":") >= 0) hostRe = escapeRe(host);
  else hostRe = escapeRe(host) + "(:\\d+)?";
  var pathRe = escapeRe(m[3]).replace(/\*/g, ".*");
  return new RegExp("^" + scheme + "://" + hostRe + pathRe + "$");
}

const MATCHES = (function () {
  var out = [];
  try {
    (chrome.runtime.getManifest().content_scripts || []).forEach(function (cs) {
      (cs.matches || []).forEach(function (p) {
        var re = patternToRegExp(p);
        if (re) out.push(re);
      });
    });
  } catch (e) {}
  return out;
})();

function onHost(url) {
  try {
    var u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // The desk is the workshop, not a work site. Leave it alone.
    if (u.origin === ORIGIN) return false;
    return MATCHES.some(function (re) { return re.test(url); });
  } catch (e) {
    return false;
  }
}

function paintIcon(state, show, tabId, mark) {
  var color = COLORS[state] || COLORS.idle;
  var alpha = show ? 0.95 : 0.35;
  function stamp(size) {
    var c = new OffscreenCanvas(size, size);
    var g = c.getContext("2d");
    if (!g) return null;
    g.clearRect(0, 0, size, size);
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.font = "700 " + Math.round(size * 0.78) + "px ui-sans-serif, system-ui, Arial, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("P", size / 2, size / 2 + size * 0.05);
    return g.getImageData(0, 0, size, size);
  }
  var i16 = stamp(16);
  var i32 = stamp(32);
  // With a tabId we paint only that tab. Without one (startup) we paint the default.
  var scope = tabId ? { tabId: tabId } : {};
  if (i16 && i32) {
    try { chrome.action.setIcon(Object.assign({ imageData: { 16: i16, 32: i32 } }, scope)); } catch (e1) {}
    void chrome.runtime.lastError;
  }
  try {
    chrome.action.setBadgeText(Object.assign({ text: show && mark ? String(mark).slice(0, 4) : "" }, scope));
    chrome.action.setBadgeBackgroundColor(Object.assign({ color: "#1a1a18" }, scope));
    try { chrome.action.setBadgeTextColor(Object.assign({ color: "#f4f4f4" }, scope)); } catch (eFg) {}
  } catch (eBadge) {}
  void chrome.runtime.lastError;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  var tab = sender && sender.tab;
  if (msg.type === "pip") {
    paintIcon(msg.state || "idle", msg.show !== false, tab && tab.id, msg.mark);
    return;
  }
  if (msg.type === "capture") {
    // Capture the window the asking tab lives in, not whichever window has focus.
    var windowId = tab && typeof tab.windowId === "number" ? tab.windowId : null;
    try {
      chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 90 }, function (url) {
        void chrome.runtime.lastError;
        try { sendResponse({ dataUrl: url || "" }); } catch (eR) {}
      });
    } catch (eCap) {
      try { sendResponse({ dataUrl: "" }); } catch (eR2) {}
    }
    return true;
  }
});

function djb(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

async function digest(s) {
  try {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.prototype.map
      .call(new Uint8Array(buf).slice(0, 16), function (b) { return ("0" + b.toString(16)).slice(-2); })
      .join("");
  } catch (e) {
    return djb(s);
  }
}

// One fetch serves every frame of a navigation. Twenty iframes, one trip to the desk.
var cache = { src: "", at: 0 };
async function liveCode() {
  var now = Date.now();
  if (cache.src && now - cache.at < CACHE_MS) return cache.src;
  const c = new AbortController();
  const t = setTimeout(function () { c.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(ORIGIN + "/agent.js?v=" + now, { cache: "no-store", signal: c.signal });
    if (!r.ok) throw new Error("agent");
    const src = await r.text();
    cache = { src: src, at: Date.now() };
    return src;
  } finally {
    clearTimeout(t);
  }
}

function exec(opts) {
  return chrome.scripting.executeScript(opts);
}

function frameTarget(tabId, frameIds) {
  return { tabId: tabId, frameIds: frameIds };
}

// What does each frame already have? { ver, packed } per frame.
async function pingFrames(target) {
  try {
    var res = await exec({
      target: target,
      world: "MAIN",
      func: function () {
        return {
          ver: window.__PA_VER || "",
          packed: !!(window.__agent && window.__agent.__pa),
        };
      },
    });
    return (res || []).filter(function (p) { return p && typeof p.frameId === "number"; });
  } catch (e) {
    return [];
  }
}

async function callArm(tabId, frameIds) {
  if (!frameIds.length) return;
  try {
    await exec({
      target: frameTarget(tabId, frameIds),
      world: "MAIN",
      func: function () {
        try {
          if (window.__agent && typeof window.__agent.arm === "function") window.__agent.arm();
        } catch (e) {
          try { window.postMessage({ source: "pa", type: "pip", state: "err", show: true, mark: "" }, "*"); } catch (e2) {}
          console.warn("[pagearm]", e);
        }
      },
    });
  } catch (e) {}
}

function liveSource(src, ver) {
  // __PA_VER is written last, so a script that fails to parse or throws at the
  // top level never claims a version it does not have.
  return (
    "window.__PA_ORIGIN = " + JSON.stringify(ORIGIN) + ";\n" +
    src + "\n" +
    "window.__PA_VER = " + JSON.stringify(ver) + ";\n"
  );
}

function userScripts() {
  // Reading chrome.userScripts throws when the user has not flipped the toggle.
  try {
    return chrome.userScripts && typeof chrome.userScripts.execute === "function" ? chrome.userScripts : null;
  } catch (e) {
    return null;
  }
}

// Put live code into the given frames. chrome.userScripts.execute (Chrome 135+,
// with "Allow User Scripts" on) is not subject to the page's CSP. Without it we
// eval, which strict-CSP sites refuse. Either way the caller re-pings afterward
// to learn which frames actually took the new version.
async function injectCode(tabId, frameIds, src, ver) {
  var code = liveSource(src, ver);
  var us = userScripts();
  if (us) {
    try {
      await us.execute({
        target: frameTarget(tabId, frameIds),
        world: "MAIN",
        injectImmediately: true,
        js: [{ code: code }],
      });
      return;
    } catch (e) {}
  }
  try {
    await exec({
      target: frameTarget(tabId, frameIds),
      world: "MAIN",
      func: function (code) {
        try {
          (0, eval)(code);
        } catch (e) {
          console.warn("[pagearm] this page refused the live agent (CSP, or a syntax error). Using the packed copy.", e);
        }
      },
      args: [code],
    });
  } catch (e) {}
}

async function injectPacked(tabId, frameIds) {
  if (!frameIds.length) return;
  try {
    await exec({ target: frameTarget(tabId, frameIds), world: "MAIN", files: ["boot.js", "inject.js"] });
  } catch (e) {}
}

function ids(list) {
  return list.map(function (p) { return p.frameId; });
}

async function arm(tabId, frameIds, force) {
  var target = frameIds && frameIds.length ? frameTarget(tabId, frameIds) : { tabId: tabId, allFrames: true };
  var src = null;
  var ver = "";
  try {
    src = await liveCode();
    ver = await digest(src);
  } catch (e) {
    src = null;
  }

  var ping = await pingFrames(target);
  if (!ping.length) return;

  if (src === null) {
    // Desk asleep. Frames with nothing yet get the packed copy, which arms itself.
    var empty = ping.filter(function (p) { return !(p.result && (p.result.ver || p.result.packed)); });
    var have = ping.filter(function (p) { return p.result && (p.result.ver || p.result.packed); });
    await injectPacked(tabId, ids(empty));
    if (force) await callArm(tabId, ids(have));
    return;
  }

  // Frames already on this version just get arm(). Only the others are touched.
  var current = ping.filter(function (p) { return p.result && p.result.ver === ver; });
  var stale = ping.filter(function (p) { return !(p.result && p.result.ver === ver); });
  await callArm(tabId, ids(current));
  if (!stale.length) return;

  await injectCode(tabId, ids(stale), src, ver);

  // Whoever did not take the live code (CSP, syntax error) and has nothing else
  // running gets the packed copy so the tab is not left bare.
  var after = await pingFrames(frameTarget(tabId, ids(stale)));
  var bare = after.filter(function (p) { return !(p.result && (p.result.ver === ver || p.result.packed)); });
  await injectPacked(tabId, ids(bare));
}

chrome.webNavigation.onCompleted.addListener(function (details) {
  if (!onHost(details.url)) return;
  arm(details.tabId, [details.frameId], false).catch(function () {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
  if (!onHost(details.url)) return;
  arm(details.tabId, [details.frameId], false).catch(function () {});
});

chrome.action.onClicked.addListener(function (tab) {
  if (!tab.id) return;
  arm(tab.id, undefined, true).catch(function () {});
});

chrome.runtime.onInstalled.addListener(function () {
  paintIcon("idle", false);
});

paintIcon("idle", false);
