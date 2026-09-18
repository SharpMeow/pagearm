// Wraps the human's scripts in a tiny IIFE so `agent` is always there.
// Keep this boring. The interesting part lives in agents/*.js.
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
  function q(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }
  function qa(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; }
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
    var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    try { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", clientX: x, clientY: y })); } catch (e1) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", opts)); } catch (e2) {}
    try { el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse", clientX: x, clientY: y })); } catch (e3) {}
    try { el.dispatchEvent(new MouseEvent("mouseup", opts)); } catch (e4) {}
    try { el.dispatchEvent(new MouseEvent("click", opts)); } catch (e5) {}
    try { el.click(); } catch (e6) {}
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
      } else if (el.isContentEditable) {
        el.focus();
        el.textContent = text;
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
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
  var agent = {
    __pa: true,
    origin: window.__PA_ORIGIN || "",
    // A getter, so it follows pushState instead of remembering the first route.
    get match() { return location.hostname + location.pathname; },
    q: q, qa: qa, click: click, punch: punch, type: type, wait: wait, pip: pip, capture: capture,
    arm: idle
  };
  window.__agent = agent;
  window.__pagearm = agent;
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
      pip("err");
      console.warn("[pagearm] " + name, err);
    }
    if (agent.arm !== idle && typeof agent.arm === "function") arms.push([name, agent.arm]);
    agent.arm = idle;
  }
  // Called on inject and again on every same-hash navigation. One script that
  // throws is one warning with its name on it, not a dead stack.
  function armAll() {
    if (!arms.length) {
      pip("ok");
      return;
    }
    for (var i = 0; i < arms.length; i++) {
      try {
        arms[i][1]();
      } catch (err) {
        pip("err");
        console.warn("[pagearm] " + arms[i][0], err);
      }
    }
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
