// Probe: why does a *duplicated* code-server tab come back with the same window state while opening
// the same URL in a new tab gives an empty window — and can the mini-launcher exploit that?
//
// Established by an earlier run of this probe:
//   - `sessionStorage` is empty, so tab duplication is not carrying the state there.
//   - The workbench keeps its state in IndexedDB, per origin: `vscode-web-db`,
//     `vscode-web-state-db-global`, `vscode-web-state-db-global-shared`, and a per-workspace
//     `vscode-web-state-db-<workspaceId>` (observed: `vscode-web-state-db-2e28705c-247a9`).
//   - There is no `state.vscdb` anywhere on the server side, so nothing is stored container-side.
//
// So the question becomes which window gets which `<workspaceId>`, and whether a clean shutdown is
// what wipes the restorable state. This runs three cases in one browser (shared IndexedDB) and prints
// the database list per step, so the id each window uses is visible:
//
//   1. DUPLICATE — second tab opened while the original is still alive (the user's observation)
//   2. CRASH     — original killed without unload handlers, then a fresh tab
//   3. CLEAN     — original unloaded normally (fires beforeunload), then a fresh tab
//
// Usage: PORT=37623 node _probe-window-identity.mjs

import { chromium } from "playwright";

const PORT = process.env.PORT || "8080";
const URL = `http://localhost:${PORT}/?folder=/home/coder/project`;
const FILE = process.env.FILE || "test.txt";
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000);

const stamp = () => new Date().toISOString().slice(11, 19);

async function tabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".tabs-container .tab .label-name")).map((e) =>
      e.textContent.trim(),
    ),
  );
}

async function stateDbs(page) {
  return page.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name).filter((n) => n.includes("state-db")),
  );
}

async function openWindow(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  return page;
}

// Quick-open silently no-ops now and then (roughly one attempt in three), so retry rather than let a
// flaky keystroke masquerade as "state was not restored".
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
      console.log(`[${stamp()}] quick-open attempt ${attempt} failed, retrying`);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
  throw new Error(`could not open ${FILE} — probe inconclusive`);
}

async function report(label, page) {
  console.log(
    `[${stamp()}] ${label}: tabs=${JSON.stringify(await tabs(page))} stateDbs=${JSON.stringify(await stateDbs(page))}`,
  );
}

const browser = await chromium.launch({ headless: true });

// --- Case 1: duplicate while the original is alive ---
const original = await openWindow(browser);
console.log(`[${stamp()}] original up; opening ${FILE}`);
await openFile(original);
await report("original", original);

const duplicate = await openWindow(browser);
await duplicate.waitForTimeout(SETTLE_MS);
await report("DUPLICATE (original still open)", duplicate);
await duplicate.goto("about:blank", { waitUntil: "load", timeout: 30000 });

// --- Case 2: original dies without running unload handlers, like a browser crash ---
console.log(`[${stamp()}] killing the original without unload handlers`);
await original.close(); // Playwright's close skips the workbench's shutdown path
await new Promise((r) => setTimeout(r, 4000));

const afterCrash = await openWindow(browser);
await afterCrash.waitForTimeout(SETTLE_MS);
await report("after CRASH", afterCrash);

// --- Case 3: same window, unloaded cleanly this time ---
console.log(`[${stamp()}] reopening ${FILE} then unloading cleanly`);
await openFile(afterCrash);
await afterCrash.goto("about:blank", { waitUntil: "load", timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));

const afterClean = await openWindow(browser);
await afterClean.waitForTimeout(SETTLE_MS);
await report("after CLEAN unload", afterClean);
await afterClean.screenshot({ path: process.env.OUT || "window-identity.png" });

await browser.close();
