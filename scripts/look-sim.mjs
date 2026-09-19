// Browser sim of Look. Not part of `npm run check` (that has to run without
// Playwright). Drive the real sample page with the real bridge, compile, replay.

import { spawn } from "child_process";
import { createServer } from "net";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { compileLook } from "./look.mjs";
import { wrapAgent } from "./wrap.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function ok(cond, label) {
  if (cond) console.log("  ok   " + label);
  else {
    console.log("  FAIL " + label);
    failures.push(label);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function waitFor(child, needle, ms) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("desk did not start")), ms);
    function on(chunk) {
      buf += String(chunk);
      if (buf.indexOf(needle) >= 0) {
        clearTimeout(t);
        child.stdout.off("data", on);
        child.stderr.off("data", on);
        resolve();
      }
    }
    child.stdout.on("data", on);
    child.stderr.on("data", on);
  });
}

async function installBridge(page) {
  await page.evaluate(() => {
    window.__paLook = [];
    window.__paListen = [];
    window.chrome = {
      runtime: {
        sendMessage(msg, cb) {
          window.__paLook.push(JSON.parse(JSON.stringify(msg)));
          if (typeof cb === "function") cb(null);
        },
        onMessage: { addListener(fn) { window.__paListen.push(fn); } },
      },
    };
  });
  await page.addScriptTag({ path: join(root, "extension/bridge.js") });
  await page.evaluate(() => {
    for (let i = 0; i < window.__paListen.length; i++) window.__paListen[i]({ type: "look-on" });
  });
}

async function loadPlaywright() {
  const names = ["playwright", "playwright/index.mjs"];
  for (const spec of names) {
    try { return await import(spec); } catch (e) {}
  }
  const extra = (process.env.NODE_PATH || "").split(":").filter(Boolean);
  for (const dir of extra) {
    try { return await import(join(dir, "playwright/index.mjs")); } catch (e) {}
  }
  return null;
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw || !pw.chromium) {
    console.log("look-sim skipped (no playwright)");
    return;
  }
  const { chromium } = pw;

  const port = await freePort();
  const child = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitFor(child, "PageArm desk", 8000);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const origin = "http://127.0.0.1:" + port;

    console.log("look-sim record");
    await page.goto(origin + "/sample.html", { waitUntil: "load" });
    await page.evaluate(() => {
      var btn = document.getElementById("save-claim");
      btn.innerHTML = "<span>Save claim</span>";
      var extra = document.createElement("div");
      extra.innerHTML = '<input id="secret" type="password" /><input id="agree" type="checkbox" />';
      document.body.appendChild(extra);
    });
    await installBridge(page);

    await page.locator("#vessel").click();
    await page.keyboard.type("Mackerel Queen", { delay: 10 });
    await page.locator("#catch").click();
    await page.keyboard.type("herring", { delay: 10 });
    await page.locator("#stone").click();
    await page.keyboard.type("240", { delay: 10 });
    await page.locator("#grade").selectOption("A");
    await page.locator("#secret").click();
    await page.keyboard.type("hunter2", { delay: 10 });
    await page.locator("#agree").click();
    await page.locator("#save-claim span").click();
    await page.waitForTimeout(250);

    const recorded = await page.evaluate(() => window.__paLook.filter((m) => m.type === "look"));
    if (!recorded.some((s) => s.kind === "type" && s.sel === "#vessel")) {
      console.log("  recorded " + JSON.stringify(recorded));
    }
    const kinds = recorded.map((s) => s.kind + ":" + s.sel + (s.text ? "=" + s.text : ""));
    ok(recorded.some((s) => s.kind === "type" && s.sel === "#vessel" && s.text === "Mackerel Queen"),
      "typing a field records the last value, even if Save is immediate");
    ok(recorded.some((s) => s.kind === "punch" && s.sel === "#save-claim"),
      "a click on the inner span records the button");
    ok(recorded.some((s) => s.kind === "seen" && s.sel === "#receipt"),
      "and the receipt that appeared after Save is a seen");
    ok(!recorded.some((s) => s.sel === "#secret" || (s.text && String(s.text).indexOf("hunter2") >= 0)),
      "a password field is never written down");
    ok(recorded.some((s) => s.kind === "punch" && s.sel === "#agree"),
      "a checkbox is a punch");
    ok(!recorded.some((s) => s.kind === "type" && s.sel === "#agree"),
      "and not a type");
    ok(recorded.some((s) => s.kind === "type" && s.sel === "#grade" && s.text === "A"),
      "a select records as type");

    const source = compileLook(recorded);
    ok(/type\(agent\.q\("#vessel"\), "Mackerel Queen"\)/.test(source), "compile keeps the vessel");
    ok(/punch\(agent\.q\("#save-claim"\)\)/.test(source), "compile punches Save");
    ok(/must\("#receipt"/.test(source), "compile musts the receipt, not the button");
    ok(!/must\("#save-claim"/.test(source), "and does not must Save");
    ok(!/hunter2/.test(source), "compile has no password");

    console.log("look-sim replay");
    await page.goto(origin + "/sample.html", { waitUntil: "load" });
    await page.evaluate((code) => { (0, eval)(code); }, wrapAgent(source));
    await page.waitForTimeout(400);
    const receipt = await page.locator("#receipt").textContent();
    ok(/Mackerel Queen/.test(receipt || "") && /herring/.test(receipt || "") && /240/.test(receipt || ""),
      "replaying the compiled look paints the receipt");
    const warn = await page.locator("#click-warn").textContent();
    ok(!/naked click/.test(warn || ""), "and Save took a punch, not a naked click");

    console.log("look-sim till");
    await page.goto(origin + "/sample.html", { waitUntil: "load" });
    await installBridge(page);
    await page.locator("wharf-till").locator("#amount").fill("18");
    await page.locator("wharf-till").locator("#pay").click();
    const till = await page.evaluate(() => window.__paLook.filter((m) => m.type === "look"));
    ok(till.some((s) => s.kind === "type" && s.sel === "#amount" && s.text === "18"),
      "an open-shadow field records by id");
    ok(till.some((s) => s.kind === "punch" && s.sel === "#pay"),
      "and the till button does too");
    const tillSrc = compileLook(till);
    await page.goto(origin + "/sample.html", { waitUntil: "load" });
    await page.evaluate((code) => { (0, eval)(code); }, wrapAgent(tillSrc));
    await page.waitForTimeout(400);
    const paid = await page.evaluate(() => {
      var host = document.querySelector("wharf-till");
      var node = host && host.shadowRoot && host.shadowRoot.getElementById("paid");
      return node ? node.textContent : "";
    });
    ok(/Paid 18/.test(paid || ""), "replaying the till look pays 18, not the default 12");
  } finally {
    if (browser) await browser.close();
    child.kill("SIGTERM");
  }

  if (failures.length) {
    console.error("\nlook-sim failed: " + failures.join("; "));
    process.exit(1);
  }
  console.log("\nall good");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
