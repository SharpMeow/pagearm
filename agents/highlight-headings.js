agent.arm = async () => {
  agent.pip("work");
  const heads = agent.qa("h1, h2, h3");
  heads.forEach((el) => {
    el.style.outline = "2px solid #b8ff3c";
    el.style.outlineOffset = "4px";
  });
  agent.pip("ok", String(heads.length || ""));
};
