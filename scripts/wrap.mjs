// Wraps the human's scripts in a tiny IIFE so `agent` is always there.
// Keep this boring. The interesting part lives in agents/*.js.
//
// PREFIX may grow a helper. It may not grow a framework. armAll walks with
// step() so a sync arm still finishes in this turn (check.mjs asserts that).
// A thenable is awaited. An empty stack must not touch Promise.
//
// One desk can serve more than one script. They share one `agent`, one hash,
// and one toolbar light, and each one gets its own function scope and its own
// `arm`. Write `agent.arm = fn` the same way whether you are alone up there or
// third in line. The wrapper collects each arm as its script finishes and calls
// them in order, so a neighbor that throws does not take the rest down.

const PREFIX = `(function () {
  function pip(state, mark) {
    try {
      window.postMessage({ source: "pa", type: "pip", state: state || "idle", show: true, mark: mark || "" }, "*");
    } catch (e) {}
  }
  function rootsOf(node) {
    var out = [];
    if (!node || !node.querySelectorAll) return out;
    var list = [];
    try { list = Array.prototype.slice.call(node.querySelectorAll("*")); } catch (e) {}
    for (var i = 0; i < list.length; i++) {
      if (list[i].shadowRoot) out.push(list[i].shadowRoot);
      if (list[i].tagName === "IFRAME") {
        try {
          var d = list[i].contentDocument;
          if (d) out.push(d);
        } catch (eF) {}
      }
    }
    return out;
  }
  function q(sel, root) {
    var start = root || document;
    try {
      var hit = start.querySelector(sel);
      if (hit) return hit;
    } catch (e) { return null; }
    var more = rootsOf(start);
    for (var r = 0; r < more.length; r++) {
      var inner = q(sel, more[r]);
      if (inner) return inner;
    }
    return null;
  }
  function qa(sel, root) {
    var start = root || document;
    var found = [];
    try { found = Array.prototype.slice.call(start.querySelectorAll(sel)); } catch (e) {}
    var more = rootsOf(start);
    for (var r = 0; r < more.length; r++) found = found.concat(qa(sel, more[r]));
    return found;
  }
  function click(el) { if (el) try { el.click(); } catch (e) {} }
  function punch(el) {
    if (!el) return;
    var x = 0, y = 0;
    try {
      var box = el.getBoundingClientRect();
      x = box.left + box.width / 2;
      y = box.top + box.height / 2;
    } catch (eBox) {}
    var opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    try { el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y })); } catch (e0) {}
    try { el.dispatchEvent(new MouseEvent("mouseover", opts)); } catch (e0b) {}
    try { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y })); } catch (e1) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", opts)); } catch (e2) {}
    try { el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y })); } catch (e3) {}
    try { el.dispatchEvent(new MouseEvent("mouseup", opts)); } catch (e4) {}
    try { el.dispatchEvent(new MouseEvent("click", opts)); } catch (e5) {}
    try { el.click(); } catch (e6) {}
  }
  function fireInput(el, text) {
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: String(text) }));
    } catch (eIn) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function type(el, text) {
    if (!el) return;
    try {
      var tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        // Go through the prototype setter so React and friends notice the change.
        var proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype
          : tag === "SELECT" ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, text); else el.value = text;
        fireInput(el, text);
      } else if (el.isContentEditable) {
        el.focus();
        try {
          document.execCommand("selectAll", false, null);
          document.execCommand("insertText", false, text);
        } catch (eEd) {
          el.textContent = text;
          fireInput(el, text);
        }
      } else {
        el.value = text;
        fireInput(el, text);
      }
    } catch (e) {}
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function capture() {
    return new Promise(function (resolve) {
      var done = false;
      function finish(url) {
        if (done) return;
        done = true;
        window.removeEventListener("message", onCap);
        resolve(url || "");
      }
      function onCap(ev) {
        var d = ev.data;
        if (!d || d.source !== "pa" || d.type !== "capture-result") return;
        finish(d.dataUrl || "");
      }
      window.addEventListener("message", onCap);
      try { window.postMessage({ source: "pa", type: "capture" }, "*"); } catch (e) { finish(""); }
      setTimeout(function () { finish(""); }, 2000);
    });
  }
  function idle() { pip("ok"); }
  var cleanups = [];
  function onCleanup(fn) {
    if (typeof fn === "function") cleanups.push(fn);
  }
  function runCleanups() {
    var list = cleanups.slice();
    cleanups = [];
    for (var c = 0; c < list.length; c++) {
      try { list[c](); } catch (eC) {}
    }
  }
  function watch(sel, fn) {
    function run() {
      try { fn(q(sel)); } catch (eW) {}
    }
    if (typeof MutationObserver === "undefined") {
      run();
      return;
    }
    var obs = new MutationObserver(run);
    try { obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true }); } catch (eO) {}
    onCleanup(function () { try { obs.disconnect(); } catch (eD) {} });
    run();
    return obs;
  }
  function when(sel, fn) {
    var seen = [];
    var primed = false;
    function scan() {
      var nodes = qa(sel);
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var already = false;
        for (var j = 0; j < seen.length; j++) if (seen[j] === el) { already = true; break; }
        if (!already) seen.push(el);
        if (primed && !already) {
          try { fn(el); } catch (eWhen) {}
        }
      }
      primed = true;
    }
    watch(sel, scan);
  }
  function must(sel, note) {
    var el = q(sel);
    var ok = !!el;
    try { if (el && el.hidden) ok = false; } catch (eH) {}
    try {
      window.postMessage({ source: "pa", type: "must", sel: String(sel || ""), ok: ok, note: String(note || sel || "") }, "*");
    } catch (eM) {}
    if (!ok) pip("err", "must");
    return el;
  }
  function ask(prompt, choices) {
    return new Promise(function (resolve) {
      var id = "ask-" + Date.now() + "-" + Math.random().toString(16).slice(2);
      var done = false;
      function finish(answer) {
        if (done) return;
        done = true;
        window.removeEventListener("message", onAns);
        resolve(answer);
      }
      function onAns(ev) {
        var d = ev.data;
        if (!d || d.source !== "pa" || d.type !== "ask-result" || d.id !== id) return;
        finish(d.answer == null ? "" : d.answer);
      }
      window.addEventListener("message", onAns);
      try {
        window.postMessage({
          source: "pa",
          type: "ask",
          id: id,
          prompt: String(prompt || ""),
          choices: Array.isArray(choices) ? choices : []
        }, "*");
      } catch (eA) { finish(""); }
      setTimeout(function () { finish(""); }, 60000);
    });
  }
  // A throw out in the world used to live and die in that page's console, which
  // is not where you are looking. Paint P red, say it there, and send it to the
  // desk with the name of the script that did it.
  function oops(name, err) {
    pip("err");
    console.warn("[pagearm] " + name, err);
    try {
      window.postMessage({
        source: "pa",
        type: "oops",
        script: String(name || ""),
        message: String((err && err.message) || err || "").slice(0, 300),
        where: String(location.href).slice(0, 200)
      }, "*");
    } catch (e) {}
  }
  var agent = {
    __pa: true,
    origin: window.__PA_ORIGIN || "",
    // A getter, so it follows pushState instead of remembering the first route.
    get match() { return location.hostname + location.pathname; },
    q: q, qa: qa, click: click, punch: punch, type: type, wait: wait, pip: pip, capture: capture,
    onCleanup: onCleanup, watch: watch, when: when, must: must, ask: ask,
    arm: idle
  };
  window.__agent = agent;
  window.__pagearm = agent;
  window.__PA_CLEANUP = runCleanups;
  var arms = [];
  agent.scripts = [];
  // Run one script's body, then take whatever it left on agent.arm. The reset
  // before each body means a script always sees the plain default, never the
  // last script's arm, so nobody composes with a neighbor by accident.
  function slot(name, body) {
    agent.scripts.push(name);
    agent.arm = idle;
    try {
      body();
    } catch (err) {
      oops(name, err);
    }
    if (agent.arm !== idle && typeof agent.arm === "function") arms.push([name, agent.arm]);
    agent.arm = idle;
  }
  // Called on inject and again on every same-hash navigation. Sync arms still
  // run in this turn. A thenable is awaited so an async arm is not dropped.
  // One script that throws is one warning with its name on it, not a dead stack.
  function armAll() {
    runCleanups();
    if (!arms.length) {
      pip("ok");
      return;
    }
    var i = 0;
    function step() {
      if (i >= arms.length) return;
      var entry = arms[i++];
      try {
        var r = entry[1]();
        if (r && typeof r.then === "function") {
          return r.catch(function (err) { oops(entry[0], err); }).then(step);
        }
      } catch (err) {
        oops(entry[0], err);
      }
      return step();
    }
    return step();
  }
`;

const SUFFIX = `  agent.arm = armAll;
  armAll();
})();
`;

// One source, a list of sources, or a list of { name, source }. The desk hands
// over the second shape; pack.mjs and anything older hand over the first.
function slots(source) {
  const list = Array.isArray(source) ? source : [source];
  return list
    .map((item, i) => {
      if (item && typeof item === "object") {
        return { name: String(item.name || "script " + (i + 1)), source: String(item.source || "") };
      }
      return { name: list.length > 1 ? "script " + (i + 1) : "agent", source: String(item || "") };
    })
    .filter((s) => s.source.trim());
}

export function wrapAgent(source) {
  const parts = slots(source);
  // Nothing to run is still a valid agent. It arms, it pips, it waits for you.
  const body = parts
    .map((s) => "  slot(" + JSON.stringify(s.name) + ", function () {\n" + s.source.trim() + "\n  });\n")
    .join("");
  return PREFIX + body + SUFFIX;
}

// The packed copy steps aside when a live version is already in the frame, so a
// late content script never overwrites the agent the worker just hot-swapped in.
export function wrapPacked(source) {
  return "if (!window.__PA_VER) " + wrapAgent(source);
}
