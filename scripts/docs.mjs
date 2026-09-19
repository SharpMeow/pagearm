// Render README stills from docs/src/*.html, a live desk shot, and a short
// Look clip of the sample page. Playwright plus ffmpeg. Not part of check.

import { spawn, execFileSync } from "child_process";
import { createServer } from "net";
import { mkdirSync, rmSync, existsSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const src = join(docs, "src");
const WIDTH = 1100;
const SCALE = 2;

async function loadPlaywright() {
  const names = ["playwright", "playwright/index.mjs"];
  for (const spec of names) {
    try { return await import(spec); } catch (e) {}
  }
  const dirs = [];
  for (const start of [process.cwd(), root, "/workspace"]) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      dirs.push(join(dir, "node_modules", "playwright"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const spec of (process.env.NODE_PATH || "").split(":").filter(Boolean)) {
    dirs.push(join(spec, "playwright"));
  }
  for (const dir of dirs) {
    const file = join(dir, "index.mjs");
    if (!existsSync(file)) continue;
    try { return await import(pathToFileURL(file).href); } catch (e) {}
  }
  return null;
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

function kb(path) {
  try { return Math.round(statSync(path).size / 1024); } catch (e) { return 0; }
}

function ffmpeg(args) {
  execFileSync("ffmpeg", args, { stdio: "pipe" });
}

async function renderStills(chromium) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: 800 },
      deviceScaleFactor: SCALE,
    });
    for (const name of ["guide", "hotswap", "look"]) {
      const url = pathToFileURL(join(src, name + ".html")).href;
      await page.goto(url, { waitUntil: "load" });
      await page.waitForTimeout(250);
      const out = join(docs, name + ".png");
      await page.screenshot({ path: out, fullPage: true, type: "png" });
      console.log("  " + name + ".png  " + kb(out) + "k");
    }
  } finally {
    await browser.close();
  }
}

async function withDesk(fn) {
  const port = await freePort();
  const child = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitFor(child, "PageArm desk", 8000);
    return await fn("http://127.0.0.1:" + port);
  } finally {
    child.kill("SIGTERM");
  }
}

async function shotDesk(chromium, origin) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: 820 },
      deviceScaleFactor: SCALE,
    });
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const chip = page.locator(".examples button", { hasText: "fill-sample" });
    if (await chip.count()) await chip.first().click();
    await page.waitForTimeout(200);
    const out = join(docs, "desk.png");
    await page.screenshot({ path: out, type: "png" });
    console.log("  desk.png  " + kb(out) + "k");
  } finally {
    await browser.close();
  }
}

async function caption(page, text) {
  await page.evaluate((t) => {
    var bar = document.getElementById("pa-caption");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "pa-caption";
      bar.style.cssText = [
        "position:fixed", "left:0", "right:0", "top:0", "z-index:9999",
        "padding:11px 20px", "background:#0b0c09", "color:#b8ff3c",
        "font:600 13px/1.3 ui-sans-serif,system-ui,sans-serif",
        "letter-spacing:.14em", "text-transform:uppercase",
        "border-bottom:1px solid #23261e",
      ].join(";");
      document.body.style.paddingTop = "44px";
      document.body.insertBefore(bar, document.body.firstChild);
    }
    bar.textContent = t;
  }, text);
}

async function recordLook(chromium, origin) {
  const tmp = join(docs, ".clip");
  mkdirSync(tmp, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let videoPath = "";
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: 640 },
      deviceScaleFactor: 1,
      recordVideo: { dir: tmp, size: { width: WIDTH, height: 640 } },
    });
    const page = await context.newPage();
    await page.goto(origin + "/sample.html", { waitUntil: "load" });
    await caption(page, "Look  ·  the sample page, not a dump");
    await page.waitForTimeout(700);
    await caption(page, "Type the claim  ·  this is a real pointer");
    await page.locator("#vessel").click();
    await page.keyboard.type("Mackerel Queen", { delay: 28 });
    await page.locator("#catch").click();
    await page.keyboard.type("herring", { delay: 28 });
    await page.locator("#stone").click();
    await page.keyboard.type("240", { delay: 28 });
    await page.locator("#grade").selectOption("A");
    await page.waitForTimeout(280);
    await caption(page, "Punch Save  ·  a naked click is ignored");
    await page.locator("#save-claim").click();
    await page.waitForTimeout(900);
    await caption(page, "Receipt painted  ·  compile musts #receipt");
    await page.waitForTimeout(1400);
    const vid = page.video();
    await context.close();
    if (vid) videoPath = await vid.path();
  } finally {
    await browser.close();
  }
  if (!videoPath || !existsSync(videoPath)) throw new Error("no look clip");
  const gif = join(docs, "look.gif");
  const mp4 = join(docs, "look.mp4");
  ffmpeg([
    "-y", "-i", videoPath,
    "-vf", "fps=12,scale=1100:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=80:reserve_transparent=0[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4",
    "-loop", "0", gif,
  ]);
  ffmpeg([
    "-y", "-i", videoPath,
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "28", "-movflags", "+faststart",
    mp4,
  ]);
  rmSync(tmp, { recursive: true, force: true });
  console.log("  look.gif  " + kb(gif) + "k");
  console.log("  look.mp4  " + kb(mp4) + "k");
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw || !pw.chromium) {
    console.error("docs skipped (no playwright)");
    process.exit(1);
  }
  console.log("docs");
  await renderStills(pw.chromium);
  await withDesk(async (origin) => {
    await shotDesk(pw.chromium, origin);
    await recordLook(pw.chromium, origin);
  });
  console.log("all good");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
