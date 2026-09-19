agent.arm = async () => {
  const form = agent.q("form");
  if (!form) {
    agent.pip("err");
    return;
  }
  const data = {};
  agent.qa("input, select, textarea", form).forEach((el) => {
    if (el.name) data[el.name] = el.value;
  });
  try { await navigator.clipboard.writeText(JSON.stringify(data, null, 2)); } catch (e) {}
  agent.pip("ok", String(Object.keys(data).length || ""));
};
