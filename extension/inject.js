(function () {
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
      var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
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
  var agent = {
    __pa: true,
    origin: window.__PA_ORIGIN || "",
    match: location.hostname + location.pathname,
    q: q, qa: qa, click: click, punch: punch, type: type, wait: wait, pip: pip, capture: capture,
    arm: function () { pip("ok"); }
  };
  window.__agent = agent;
  window.__pagearm = agent;
  try {

agent.arm = async () => {
  agent.pip("ok");
  const title = document.title || agent.match;
  console.log("[pagearm] armed on", title);
};

  } catch (err) {
    pip("err");
    console.warn("[pagearm]", err);
  }
  try {
    if (typeof agent.arm === "function") agent.arm();
  } catch (err2) {
    pip("err");
    console.warn("[pagearm]", err2);
  }
})();
