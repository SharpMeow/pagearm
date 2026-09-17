// Isolated-world courier. Carries pip and capture between the page and the worker.
// No keepalive: webNavigation wakes the worker when it is needed, and a tab that
// pokes it every twelve seconds forever only burns battery.

try {
  document.documentElement.setAttribute("data-pa-bridge", "1");
} catch (e0) {}

function send(msg, cb) {
  try {
    chrome.runtime.sendMessage(msg, function (res) {
      void chrome.runtime.lastError;
      if (cb) cb(res);
    });
  } catch (e) {
    if (cb) cb(null);
  }
}

window.addEventListener("message", function (ev) {
  if (ev.source !== window) return;
  var d = ev.data;
  if (!d || d.source !== "pa") return;
  if (d.type === "pip") {
    send({ type: "pip", state: d.state || "idle", show: d.show !== false, mark: d.mark || "" });
  }
  if (d.type === "capture") {
    send({ type: "capture" }, function (res) {
      try {
        window.postMessage({ source: "pa", type: "capture-result", dataUrl: (res && res.dataUrl) || "" }, "*");
      } catch (ePost) {}
    });
  }
});
