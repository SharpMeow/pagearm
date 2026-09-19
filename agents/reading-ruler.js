agent.arm = async () => {
  const bar = document.createElement("div");
  bar.setAttribute("aria-hidden", "true");
  bar.style.cssText =
    "position:fixed;left:0;right:0;height:2px;background:#b8ff3c;z-index:2147483646;pointer-events:none;opacity:.85;top:0";
  document.documentElement.appendChild(bar);
  function move(ev) {
    bar.style.top = ev.clientY + 18 + "px";
  }
  document.addEventListener("mousemove", move, { passive: true });
  agent.onCleanup(() => {
    try { bar.remove(); } catch (e) {}
    document.removeEventListener("mousemove", move);
  });
  agent.pip("ok");
};
