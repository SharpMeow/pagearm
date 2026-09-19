// Isolated-world courier. Carries pip, capture, ask, must, and nav between the
// page and the worker. No keepalive: webNavigation wakes the worker when it is
// needed, and a tab that pokes it every twelve seconds forever only burns battery.

// Firefox and Safari hand content scripts a promise-shaped `browser`. Chromium
// has `chrome` and a callback. The courier does not care which house it is in.
var api = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
var PROMISED = typeof browser !== "undefined" && !!browser.runtime;

try {
  document.documentElement.setAttribute("data-pa-bridge", "1");
} catch (e0) {}

function send(msg, cb) {
  try {
    if (PROMISED) {
      var p = api.runtime.sendMessage(msg);
      if (p && typeof p.then === "function") {
        p.then(function (res) { if (cb) cb(res); }, function () { if (cb) cb(null); });
        return;
      }
      if (cb) cb(null);
      return;
    }
    api.runtime.sendMessage(msg, function (res) {
      void api.runtime.lastError;
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
  if (d.type === "oops") {
    send({ type: "oops", script: d.script || "", message: d.message || "", where: d.where || "" });
  }
  if (d.type === "must") {
    send({ type: "must", sel: d.sel || "", ok: !!d.ok, note: d.note || "" });
  }
  if (d.type === "capture") {
    send({ type: "capture" }, function (res) {
      try {
        window.postMessage({ source: "pa", type: "capture-result", dataUrl: (res && res.dataUrl) || "" }, "*");
      } catch (ePost) {}
    });
  }
  if (d.type === "ask") {
    send({ type: "ask", id: d.id || "", prompt: d.prompt || "", choices: d.choices || [] }, function (res) {
      try {
        window.postMessage({
          source: "pa",
          type: "ask-result",
          id: d.id || "",
          answer: (res && res.answer) || "",
        }, "*");
      } catch (ePost) {}
    });
  }
});

// Safari has no webNavigation.onHistoryStateUpdated, so a route change inside a
// single-page app would otherwise go unnoticed until the next real load. Two
// listeners and an href compare, no observers, no polling. The worker drops
// these where it has the real event, so only Safari pays for them.
var lastHref = location.href;
function nav() {
  if (location.href === lastHref) return;
  lastHref = location.href;
  send({ type: "nav", url: location.href });
}
window.addEventListener("popstate", nav);
window.addEventListener("hashchange", nav);
