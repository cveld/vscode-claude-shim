// Probe: does reopening the code-server URL give the same window back?
//
// The keep-alive patch (container-assets/patch-workbench-keepalive.mjs) keeps the extension host
// running when the tab closes, but a reopened tab always gets a *new* extension host — it cannot
// re-attach. The open question this probe answers is what the plain "Open" link in the mini-launcher
// does restore: is the editor layout still there, or do you land in an empty window?
//
// It opens a file via quick-open, records the editor tabs, unloads the page the way a real tab close
// does (navigating, not `page.close()` — see _probe-exthost-keepalive.mjs), then reopens the same URL
// and reports the tabs again.
//
// Usage: PORT=37623 node _probe-window-restore.mjs

import { chromium } from "playwright";

const PORT = process.env.PORT || "8080";
const URL = `http://localhost:${PORT}/?folder=/home/coder/project`;
const FILE = process.env.FILE || "test.txt";

const stamp = () => new Date().toISOString().slice(11, 19);

// Editor tab labels only — the Explorer lists the same filenames, so page text is not decisive.
async function tabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".tabs-container .tab .label-name")).map((e) =>
      e.textContent.trim(),
    ),
  );
}

// Terminal buffers, to see whether integrated terminals reattach. The ptyHost is a separate process
// that outlives the window, but that does not by itself mean a fresh window picks the session up.
async function terminalText(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".xterm-rows")).map((e) =>
      e.textContent.replace(/\s+/g, " ").trim().slice(0, 120),
    ),
  );
}

async function openWindow(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // NO_KEEPALIVE=1 flips the patch's own escape hatch, so the same probe measures stock behaviour:
  // the old window dies immediately on unload and releases its workspaceStorage slot.
  if (process.env.NO_KEEPALIVE === "1") {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("shim.keepExtHostAlive", "false");
      } catch {}
    });
  }
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  return page;
}

const browser = await chromium.launch({ headless: true });

const page = await openWindow(browser);
console.log(`[${stamp()}] workbench up; opening ${FILE} via quick-open`);
await page.waitForTimeout(5000); // quick-open silently no-ops while the workbench is still wiring up
await page.click(".monaco-workbench");
await page.keyboard.press("Control+P");
await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 15000 });
await page.keyboard.type(FILE, { delay: 30 });
await page.waitForTimeout(1500);
await page.keyboard.press("Enter");

// Fail loudly rather than reporting "nothing was restored" when nothing was ever opened.
await page
  .waitForFunction(
    (name) =>
      Array.from(document.querySelectorAll(".tabs-container .tab .label-name")).some(
        (e) => e.textContent.trim() === name,
      ),
    FILE,
    { timeout: 15000 },
  )
  .catch(() => {
    throw new Error(`quick-open did not open ${FILE} — probe inconclusive, nothing to restore`);
  });
console.log(`[${stamp()}] tabs before unload: ${JSON.stringify(await tabs(page))}`);

// Best-effort: leave a terminal behind with a distinctive marker in its buffer. Driving the terminal
// from Playwright is unreliable (neither the palette entry nor Ctrl+` opened one consistently), so a
// failure here must not invalidate the editor measurement above.
const marker = `SHIM_MARKER_${process.env.MARKER || "A"}`;
try {
  await page.keyboard.press("Control+`");
  await page.waitForSelector(".xterm-rows", { timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.keyboard.type(`echo ${marker}`, { delay: 20 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  console.log(`[${stamp()}] terminals before unload: ${JSON.stringify(await terminalText(page))}`);
} catch {
  console.log(`[${stamp()}] could not open a terminal — skipping the terminal half`);
}

console.log(`[${stamp()}] unloading (navigating away)`);
await page.goto("about:blank", { waitUntil: "load", timeout: 30000 });

// A window that is still alive server-side holds its workspaceStorage slot, so a reopen taken too
// soon lands in a fresh `<id>-N` slot and can only be empty. WAIT_MS lets the orphan be reaped
// first (SHIM_RECONNECT_SHORT_GRACE_MS, 15s by default) so the original slot is free again.
const waitMs = Number(process.env.WAIT_MS || 2000);
console.log(`[${stamp()}] waiting ${waitMs}ms before reopening`);
await page.waitForTimeout(waitMs);

const reopened = await openWindow(browser);
await reopened.waitForTimeout(8000); // editor restore is not instant
console.log(`[${stamp()}] tabs after reopen: ${JSON.stringify(await tabs(reopened))}`);
console.log(`[${stamp()}] terminals after reopen: ${JSON.stringify(await terminalText(reopened))}`);

// Where the workbench actually keeps its state: there is no state.vscdb anywhere on the server side
// of this container, so this inventory shows what the *browser* holds per origin. Relevant because
// the mini-launcher publishes the instance on a random host port, i.e. a new origin after a restart.
const clientStorage = await reopened.evaluate(async () => ({
  indexedDB: (await indexedDB.databases()).map((d) => d.name),
  localStorageKeys: Object.keys(localStorage).length,
}));
console.log(`[${stamp()}] client-side storage: ${JSON.stringify(clientStorage)}`);
await reopened.screenshot({ path: process.env.OUT || "window-restore.png" });

await browser.close();
