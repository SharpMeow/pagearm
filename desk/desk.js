const source = document.getElementById("source");
const hosts = document.getElementById("hosts");
const saveBtn = document.getElementById("save");
const saveState = document.getElementById("save-state");
const download = document.getElementById("download");
const examplesEl = document.getElementById("examples");

function refreshDownload() {
  const q = new URLSearchParams({ hosts: hosts.value });
  download.href = "/extension.zip?" + q.toString();
}

hosts.addEventListener("input", refreshDownload);
refreshDownload();

async function load() {
  const r = await fetch("/api/agent");
  const data = await r.json();
  source.value = data.source || "";
}

async function loadExamples() {
  const r = await fetch("/api/examples");
  const data = await r.json();
  examplesEl.innerHTML = "";
  (data.examples || []).forEach((ex) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = ex.id.replace(/-/g, " ");
    b.addEventListener("click", () => {
      source.value = ex.source;
      saveState.textContent = "unsaved example";
    });
    examplesEl.appendChild(b);
  });
}

async function save() {
  saveState.textContent = "saving…";
  try {
    const r = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: source.value }),
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      saveState.textContent = "not saved: " + (data.error || r.status);
      return;
    }
    saveState.textContent = "saved. open or reload a tab.";
  } catch (e) {
    saveState.textContent = "not saved: desk unreachable";
  }
}

saveBtn.addEventListener("click", save);

// Cmd+S / Ctrl+S saves the agent instead of the page.
document.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    save();
  }
});

load().catch(() => {
  saveState.textContent = "could not load agent";
});
loadExamples().catch(() => {});
