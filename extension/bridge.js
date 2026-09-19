// Isolated-world courier. Carries pip, capture, ask, must, look, and nav
// between the page and the worker. No keepalive: webNavigation wakes the
// worker when it is needed, and a tab that pokes it every twelve seconds
// forever only burns battery.

// Firefox and Safari hand content scripts a promise-shaped `browser`. Chromium
// has `chrome` and a callback. The courier does not care which house it is in.
var api = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
var PROMISED = typeof browser !== "undefined" && !!browser.runtime;

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

// Look records in this world, not MAIN, so wrap stays boring. Open shadow is
// visible here. Closed shadow is not. Passwords are never written down.
var looking = false;
var typeTimer = 0;
var typePending = null;
var appearTimer = 0;
var knownVisible = {};

function esc(s) {
  try {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  } catch (e) {}
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function parentOf(el) {
  if (!el) return null;
  if (el.parentElement) return el.parentElement;
  var root = el.getRootNode && el.getRootNode();
  if (root && root.host) return root.host;
  return null;
}

function cssPath(el) {
  if (!el || !el.tagName) return "";
  if (el.id) return "#" + esc(el.id);
  var tag = el.tagName.toLowerCase();
  function attr(name) {
    var v = "";
    try { v = (el.getAttribute && el.getAttribute(name)) || ""; } catch (eA) {}
    return v;
  }
  var name = attr("name");
  if (name) return tag + '[name="' + esc(name) + '"]';
  var aria = attr("aria-label");
  if (aria) return tag + '[aria-label="' + esc(aria) + '"]';
  var testid = attr("data-testid");
  if (testid) return tag + '[data-testid="' + esc(testid) + '"]';
  var dataTest = attr("data-test");
  if (dataTest) return tag + '[data-test="' + esc(dataTest) + '"]';
  var dataId = attr("data-id");
  if (dataId) return tag + '[data-id="' + esc(dataId) + '"]';
  var placeholder = attr("placeholder");
  if (placeholder) return tag + '[placeholder="' + esc(placeholder) + '"]';
  var parts = [];
  var node = el;
  for (var depth = 0; node && node.tagName && depth < 6; depth++) {
    if (node.id) {
      parts.unshift("#" + esc(node.id));
      break;
    }
    var partTag = node.tagName.toLowerCase();
    var parent = parentOf(node);
    var part = partTag;
    if (parent && parent.children) {
      var kids = parent.children;
      var count = 0;
      var index = 0;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i] && kids[i].tagName === node.tagName) {
          count++;
          if (kids[i] === node) index = count;
        }
      }
      if (count > 1) part += ":nth-of-type(" + index + ")";
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

function skipType(el) {
  if (!el || !el.tagName) return true;
  var tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && tag !== "select" && !el.isContentEditable) return true;
  var type = String(el.type || "").toLowerCase();
  return type === "password" || type === "hidden" || type === "file" || type === "checkbox" || type === "radio";
}

function interestingPointer(el) {
  if (!el || !el.tagName) return false;
  var tag = el.tagName.toLowerCase();
  if (tag === "html" || tag === "body" || tag === "script" || tag === "style" || tag === "svg") return false;
  if (tag === "button" || tag === "a" || tag === "summary") return true;
  if (tag === "label" || tag === "option") return true;
  if (tag === "tr" || tag === "td" || tag === "th") return true;
  if (tag === "input" || tag === "select" || tag === "textarea") return true;
  try {
    var role = el.getAttribute && el.getAttribute("role");
    if (role === "button" || role === "link" || role === "tab") return true;
  } catch (e) {}
  if (el.id) return true;
  return false;
}

function pickTarget(ev) {
  var path = [];
  try { if (ev.composedPath) path = ev.composedPath(); } catch (e) {}
  var first = null;
  for (var i = 0; i < path.length; i++) {
    if (!path[i] || path[i].nodeType !== 1) continue;
    if (!first) first = path[i];
    if (interestingPointer(path[i])) return path[i];
  }
  return first || ev.target;
}

function onPointer(ev) {
  if (!looking || ev.button) return;
  flushType();
  var el = pickTarget(ev);
  if (!interestingPointer(el)) return;
  var tag = el.tagName && el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    var type = String(el.type || "").toLowerCase();
    if (type !== "button" && type !== "submit" && type !== "checkbox" && type !== "radio") return;
  }
  if (el.isContentEditable) return;
  var sel = cssPath(el);
  if (!sel) return;
  send({ type: "look", kind: "punch", sel: sel });
  if (appearTimer) clearTimeout(appearTimer);
  appearTimer = setTimeout(function () {
    appearTimer = 0;
    if (looking) noteAppeared(sel);
  }, 160);
}

function isHidden(el) {
  if (!el) return true;
  try { if (el.hidden) return true; } catch (eH) {}
  try {
    if (el.style && el.style.display === "none") return true;
  } catch (eS) {}
  return false;
}

function collectVisible(into) {
  function walk(root) {
    if (!root || !root.querySelectorAll) return;
    var list = [];
    try { list = root.querySelectorAll("[id], [role=status], [role=alert]"); } catch (e) {}
    for (var i = 0; i < list.length; i++) {
      if (isHidden(list[i])) continue;
      var sel = cssPath(list[i]);
      if (sel) into[sel] = 1;
    }
    var all = [];
    try { all = root.querySelectorAll("*"); } catch (e2) {}
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) walk(all[j].shadowRoot);
    }
  }
  walk(document);
}

function noteAppeared(except) {
  var now = {};
  collectVisible(now);
  var found = [];
  for (var sel in now) {
    if (!Object.prototype.hasOwnProperty.call(now, sel)) continue;
    if (knownVisible[sel]) continue;
    if (except && sel === except) continue;
    found.push(sel);
  }
  knownVisible = now;
  for (var k = 0; k < found.length && k < 8; k++) {
    send({ type: "look", kind: "seen", sel: found[k] });
  }
}

function flushType() {
  if (typeTimer) {
    clearTimeout(typeTimer);
    typeTimer = 0;
  }
  if (!typePending) return;
  send({ type: "look", kind: "type", sel: typePending.sel, text: typePending.text });
  typePending = null;
}

function onInput(ev) {
  if (!looking) return;
  var el = pickTarget(ev);
  if (skipType(el)) return;
  var sel = cssPath(el);
  if (!sel) return;
  var text = el.isContentEditable ? String(el.textContent || "") : String(el.value || "");
  typePending = { sel: sel, text: text.slice(0, 500) };
  if (typeTimer) clearTimeout(typeTimer);
  typeTimer = setTimeout(flushType, 180);
}

function sketch() {
  var nodes = [];
  var seen = {};
  function add(el) {
    if (!el || !el.tagName) return;
    var tag = el.tagName.toLowerCase();
    var type = String(el.type || "").toLowerCase();
    if (type === "password" || type === "hidden" || type === "file") return;
    var sel = cssPath(el);
    if (!sel || seen[sel]) return;
    seen[sel] = 1;
    var text = String(el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
    var name = "";
    try { name = (el.getAttribute && el.getAttribute("name")) || ""; } catch (eN) {}
    nodes.push({ sel: sel, tag: tag, name: name, text: text });
  }
  function walk(root) {
    if (!root || !root.querySelectorAll) return;
    var list = [];
    try { list = root.querySelectorAll("button, a, input, select, textarea, [role=button], [id]"); } catch (e) {}
    for (var i = 0; i < list.length && nodes.length < 80; i++) add(list[i]);
    var all = [];
    try { all = root.querySelectorAll("*"); } catch (e2) {}
    for (var j = 0; j < all.length && nodes.length < 80; j++) {
      if (all[j].shadowRoot) walk(all[j].shadowRoot);
    }
  }
  walk(document);
  return nodes;
}

function sendSketch() {
  var nodes = sketch();
  if (nodes.length) send({ type: "look", kind: "sketch", nodes: nodes });
}

function startLook() {
  if (looking) return;
  looking = true;
  knownVisible = {};
  collectVisible(knownVisible);
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  sendSketch();
}

function stopLook() {
  if (!looking) return;
  looking = false;
  document.removeEventListener("pointerdown", onPointer, true);
  document.removeEventListener("input", onInput, true);
  document.removeEventListener("change", onInput, true);
  if (typeTimer) clearTimeout(typeTimer);
  if (appearTimer) {
    clearTimeout(appearTimer);
    appearTimer = 0;
    noteAppeared("");
  }
  flushType();
  sendSketch();
}

try {
  api.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === "look-on") startLook();
    if (msg.type === "look-off") stopLook();
  });
} catch (eMsg) {}

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
