try {
  document.documentElement.setAttribute("data-pa-bridge", "1");
} catch (e0) {}

var port = null;
function ensurePort() {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: "pa-pip" });
    port.onDisconnect.addListener(function () {
      port = null;
    });
  } catch (e) {
    port = null;
  }
  return port;
}

function send(msg) {
  try {
    var p = ensurePort();
    if (p) {
      p.postMessage(msg);
      return;
    }
  } catch (e1) {}
  try {
    chrome.runtime.sendMessage(msg);
  } catch (e2) {}
}

ensurePort();
setInterval(function () {
  try {
    var p = ensurePort();
    if (p) p.postMessage({ type: "ping" });
  } catch (e3) {}
}, 12000);

window.addEventListener("message", function (ev) {
  var d = ev.data;
  if (!d || d.source !== "pa") return;
  if (d.type === "pip") {
    send({ type: "pip", state: d.state || "idle", show: d.show !== false, mark: d.mark || "" });
  }
  if (d.type === "capture") {
    try {
      chrome.runtime.sendMessage({ type: "capture" }, function (res) {
        void chrome.runtime.lastError;
        try {
          window.postMessage({ source: "pa", type: "capture-result", dataUrl: (res && res.dataUrl) || "" }, "*");
        } catch (ePost) {}
      });
    } catch (eCap) {
      try { window.postMessage({ source: "pa", type: "capture-result", dataUrl: "" }, "*"); } catch (e2) {}
    }
  }
});
