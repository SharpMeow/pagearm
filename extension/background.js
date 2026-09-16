// Thin shell. This file should get boring and stay boring.
// The living agent is GET {desk}/agent.js, hashed, then eval'd into MAIN.

const ORIGIN = "__PA_ORIGIN__";
const COLORS = { idle: "#8b9098", work: "#c8a24a", ok: "#b8ff3c", err: "#e24b4b" };

function onHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
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
  if (i16 && i32) {
    var images = { 16: i16, 32: i32 };
    try { chrome.action.setIcon({ imageData: images }); } catch (e1) {}
    void chrome.runtime.lastError;
    if (tabId) {
      try { chrome.action.setIcon({ tabId: tabId, imageData: images }); } catch (e2) {}
      void chrome.runtime.lastError;
    }
  }
  var badge = { text: show && mark ? String(mark).slice(0, 4) : "" };
  if (tabId) badge.tabId = tabId;
  try {
    chrome.action.setBadgeText(badge);
    var bg = { color: "#1a1a18" };
    if (tabId) bg.tabId = tabId;
    chrome.action.setBadgeBackgroundColor(bg);
    try {
      var fg = { color: "#f4f4f4" };
      if (tabId) fg.tabId = tabId;
      chrome.action.setBadgeTextColor(fg);
    } catch (eFg) {}
    chrome.action.setTitle({ title: "P" });
  } catch (eBadge) {}
  void chrome.runtime.lastError;
}

chrome.runtime.onConnect.addListener(function (port) {
  if (!port || port.name !== "pa-pip") return;
  port.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === "ping") return;
    if (msg.type !== "pip") return;
    var tabId = port.sender && port.sender.tab && port.sender.tab.id;
    paintIcon(msg.state || "idle", msg.show !== false, tabId, msg.mark);
  });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.type === "pip") {
    paintIcon(msg.state || "idle", msg.show !== false, sender.tab && sender.tab.id, msg.mark);
    return;
  }
  if (msg.type === "capture") {
    try {
      chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 90 }, function (url) {
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

async function liveCode() {
  const c = new AbortController();
  const t = setTimeout(function () { c.abort(); }, 1500);
  try {
    const r = await fetch(ORIGIN + "/agent.js?v=" + Date.now(), { cache: "no-store", signal: c.signal });
    if (!r.ok) throw new Error("agent");
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function arm(tabId, frameIds) {
  const target = frameIds && frameIds.length ? { tabId: tabId, frameIds: frameIds } : { tabId: tabId, allFrames: true };
  try {
    const src = await liveCode();
    const ver = djb(src);
    var same = false;
    try {
      const ping = await chrome.scripting.executeScript({
        target: target,
        world: "MAIN",
        func: function () {
          return window.__PA_VER || "";
        },
      });
      same = !!(ping && ping.length && ping.every(function (p) { return p && p.result === ver; }));
    } catch (ePing) {}
    if (same) {
      await chrome.scripting.executeScript({
        target: target,
        world: "MAIN",
        func: function () {
          try { window.__agent.arm(); } catch (e) {}
        },
      });
      return;
    }
    await chrome.scripting.executeScript({ target: target, world: "MAIN", files: ["boot.js"] });
    await chrome.scripting.executeScript({
      target: target,
      world: "MAIN",
      func: function (origin, code, ver) {
        window.__PA_ORIGIN = origin;
        window.__PA_VER = ver;
        (0, eval)(code);
      },
      args: [ORIGIN, src, ver],
    });
    return;
  } catch (e) {}
  await chrome.scripting.executeScript({
    target: target,
    world: "MAIN",
    files: ["boot.js", "inject.js"],
  });
}

chrome.webNavigation.onCommitted.addListener(function (details) {
  if (!onHost(details.url)) return;
  arm(details.tabId, [details.frameId]).catch(function () {});
});

chrome.webNavigation.onCompleted.addListener(function (details) {
  if (!onHost(details.url)) return;
  arm(details.tabId, [details.frameId]).catch(function () {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
  if (!onHost(details.url)) return;
  arm(details.tabId, details.frameId ? [details.frameId] : undefined).catch(function () {});
});

chrome.action.onClicked.addListener(function (tab) {
  if (!tab.id) return;
  arm(tab.id).catch(function () {});
});

chrome.runtime.onInstalled.addListener(function () {
  paintIcon("idle", false);
});

paintIcon("idle", false);
