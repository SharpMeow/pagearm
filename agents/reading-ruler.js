agent.arm = async () => {
  if (window.__paRuler) {
    agent.pip("ok");
    return;
  }
  window.__paRuler = true;
  const bar = document.createElement("div");
  bar.setAttribute("aria-hidden", "true");
  bar.style.cssText =
    "position:fixed;left:0;right:0;height:2px;background:#b8ff3c;z-index:2147483646;pointer-events:none;opacity:.85;top:0";
  document.documentElement.appendChild(bar);
  document.addEventListener(
    "mousemove",
    (ev) => {
      bar.style.top = ev.clientY + 18 + "px";
    },
    { passive: true },
  );
  agent.pip("ok");
};
