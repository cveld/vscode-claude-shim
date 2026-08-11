// Probe: two questions behind the "stable per-project subdomain" idea
// (e.g. http://abc.mini-launcher.localhost instead of http://localhost:<random port>).
//
// 1. RELOAD — does the workbench restore its editors on a plain F5 of the *same* page? This bounds
//    what a stable origin could ever buy. If not even a reload restores, then keeping the origin
//    stable across container restarts cannot bring window state back either, and the subdomain is
//    purely about stable links.
// 2. HOST — does code-server serve correctly when reached under a `*.localhost` name rather than
//    plain `localhost`? Chromium resolves any `*.localhost` label to 127.0.0.1 without hosts-file
//    entries, so this tests both that resolution and whether code-server minds the Host header. A
//    host-based reverse proxy on one fixed port is only viable if this loads.
//
// Usage: PORT=37623 node _probe-origin.mjs

import { chromium } from "playwright";

const PORT = process.env.PORT || "8080";
const FILE = process.env.FILE || "test.txt";
const HOST_UNDER_TEST = process.env.TEST_HOST || "abc.mini-launcher.localhost";

const stamp = () => new Date().toISOString().slice(11, 19);
// Port 80 is left out of the URL so the origin is exactly what a bookmark would carry.
const urlFor = (host) =>
  `http://${host}${PORT === "80" ? "" : `:${PORT}`}/?folder=/home/coder/project`;

async function tabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".tabs-container .tab .label-name")).map((e) =>
      e.textContent.trim(),
    ),
  );
}

async function openFile(page) {
  await page.waitForTimeout(5000);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.click(".monaco-workbench");
      await page.keyboard.press("Control+P");
      await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10000 });
      await page.keyboard.type(FILE, { delay: 30 });
      await page.waitForTimeout(1500);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (name) =>
          Array.from(document.querySelectorAll(".tabs-container .tab .label-name")).some(
            (e) => e.textContent.trim() === name,
          ),
        FILE,
        { timeout: 10000 },
      );
      return;
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
  throw new Error(`could not open ${FILE} — probe inconclusive`);
}

const browser = await chromium.launch({ headless: true });

// --- 1. Does a reload restore the editors? ---
// Skipped when only the host test is wanted: this half hits plain `localhost:PORT`, which is the
// container's published port, not a proxy vhost.
if (process.env.SKIP_RELOAD !== "1") {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(urlFor("localhost"), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await openFile(page);
  console.log(`[${stamp()}] tabs before reload: ${JSON.stringify(await tabs(page))}`);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await page.waitForTimeout(8000);
  console.log(`[${stamp()}] tabs after RELOAD: ${JSON.stringify(await tabs(page))}`);
  await page.close();
}

// --- 2. Does code-server serve under a *.localhost host name? ---
const hostPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const failures = [];
hostPage.on("requestfailed", (r) => failures.push(`${r.failure()?.errorText} ${r.url().slice(0, 80)}`));
try {
  const response = await hostPage.goto(urlFor(HOST_UNDER_TEST), {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  console.log(`[${stamp()}] ${HOST_UNDER_TEST} -> HTTP ${response && response.status()}`);
  await hostPage.waitForSelector(".monaco-workbench", { timeout: 60000 });
  // The workbench shell can render before the remote connection is up; the Explorer only lists files
  // once the management connection works over this host name, so assert on that instead.
  await hostPage.waitForFunction(
    (name) => document.body.innerText.includes(name),
    FILE,
    { timeout: 45000 },
  );
  console.log(`[${stamp()}] workbench loaded and connected under ${HOST_UNDER_TEST}`);
} catch (err) {
  console.log(`[${stamp()}] FAILED under ${HOST_UNDER_TEST}: ${err.message.split("\n")[0]}`);
} finally {
  if (failures.length) console.log(`[${stamp()}] failed requests: ${JSON.stringify(failures.slice(0, 5))}`);
  await hostPage.screenshot({ path: process.env.OUT || "origin-probe.png" });
}

await browser.close();
