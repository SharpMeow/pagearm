// Turn a recorded trace into an agent. Keep this dull: type, punch, must.
// The interesting part is the page you used, not this file.

export function compileLook(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const compact = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    const sel = String(raw.sel || raw.selector || "").trim();
    if (!sel) continue;
    const kind = raw.kind === "type" || raw.action === "type" || raw.type === "input"
      ? "type"
      : raw.kind === "seen"
        ? "seen"
        : "punch";
    const text = String(raw.text || raw.value || "");
    const prev = compact[compact.length - 1];
    if (kind === "seen") {
      if (prev && prev.kind === "seen" && prev.sel === sel) continue;
      compact.push({ kind: "seen", sel: sel });
      continue;
    }
    if (kind === "type") {
      if (prev && prev.kind === "punch" && prev.sel === sel) compact.pop();
      const last = compact[compact.length - 1];
      if (last && last.kind === "type" && last.sel === sel) {
        last.text = text;
        continue;
      }
      compact.push({ kind: "type", sel: sel, text: text });
      continue;
    }
    if (prev && prev.kind === "punch" && prev.sel === sel) continue;
    compact.push({ kind: "punch", sel: sel });
  }

  if (!compact.length) {
    return "agent.arm = async () => {\n  agent.pip(\"ok\");\n};\n";
  }

  const lines = ["agent.arm = async () => {", "  agent.pip(\"work\");"];
  let lastPunch = "";
  let lastSeen = "";
  for (let i = 0; i < compact.length; i++) {
    const step = compact[i];
    if (step.kind === "seen") {
      lastSeen = step.sel;
      continue;
    }
    if (step.kind === "type") {
      lines.push("  agent.type(agent.q(" + JSON.stringify(step.sel) + "), " + JSON.stringify(step.text) + ");");
      continue;
    }
    var j = i - 1;
    while (j >= 0 && compact[j].kind === "seen") j--;
    if (j >= 0 && compact[j].kind === "type") lines.push("  await agent.wait(80);");
    lines.push("  agent.punch(agent.q(" + JSON.stringify(step.sel) + "));");
    lastPunch = step.sel;
  }
  const mustSel = (lastSeen && lastSeen !== lastPunch) ? lastSeen : lastPunch;
  if (mustSel) {
    const note = mustSel.charAt(0) === "#" ? mustSel.slice(1) : mustSel;
    lines.push("  agent.must(" + JSON.stringify(mustSel) + ", " + JSON.stringify(note) + ");");
  } else {
    for (let i = compact.length - 1; i >= 0; i--) {
      if (compact[i].kind !== "type") continue;
      const sel = compact[i].sel;
      const note = sel.charAt(0) === "#" ? sel.slice(1) : sel;
      lines.push("  agent.must(" + JSON.stringify(sel) + ", " + JSON.stringify(note) + ");");
      break;
    }
  }
  lines.push("  agent.pip(\"ok\");", "};");
  return lines.join("\n") + "\n";
}
