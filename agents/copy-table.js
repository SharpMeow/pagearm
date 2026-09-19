agent.arm = async () => {
  agent.pip("work");
  const table = agent.q("table");
  if (!table) {
    agent.pip("err");
    return;
  }
  const rows = agent.qa("tr", table).map((tr) =>
    agent.qa("th, td", tr).map((c) => c.innerText.trim().replace(/\t/g, " ")).join("\t")
  );
  const tsv = rows.join("\n");
  try { await navigator.clipboard.writeText(tsv); } catch (e) {}
  agent.pip("ok", String(Math.max(0, rows.length - 1)));
};
