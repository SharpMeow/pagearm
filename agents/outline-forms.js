agent.arm = async () => {
  agent.pip("work");
  const fields = agent.qa("input, textarea, select");
  fields.forEach((el) => {
    el.style.outline = "1px dashed #b8ff3c";
  });
  agent.onCleanup(() => {
    fields.forEach((el) => { el.style.outline = ""; });
  });
  agent.pip("ok", String(Math.min(fields.length, 99) || ""));
};
