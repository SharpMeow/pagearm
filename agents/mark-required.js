agent.arm = async () => {
  const marked = [];
  agent.qa("[required]").forEach((el) => {
    const empty = !String(el.value || "").trim();
    if (!empty) return;
    el.style.outline = "2px solid #9a2e2e";
    marked.push(el);
  });
  agent.onCleanup(() => {
    marked.forEach((el) => { el.style.outline = ""; });
  });
  agent.pip(marked.length ? "err" : "ok", String(marked.length || ""));
};
