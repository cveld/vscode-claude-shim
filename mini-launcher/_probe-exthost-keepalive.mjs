// Probe: does the extension host survive closing the browser window?
//
// code-server's web workbench sends a graceful disconnect + a `Terminate` message to the
// extension host on page unload, which kills the running Claude session within seconds. The
// keep-alive patch (container-assets/patch-workbench-keepalive.mjs) suppresses that during
// unload so the ext host falls back to its reconnection grace time instead.
//
// This script only drives the browser: it opens a window, waits for the workbench, then navigates
// away to `about:blank`. Navigating is deliberate — Playwright's `page.close()` tears the renderer
// down without letting the workbench send its goodbye, so it looks like a keep-alive success even
// on a stock build. A navigation runs `pagehide` with the renderer alive, which is what a real tab
// close does. Inspect the container afterwards to see the verdict:
//
//   docker logs --tail 20 <container>     # "Extension Host Process exited" => not kept alive
//   docker exec <container> ps -eo pid,etimes,args --no-headers | grep extensionHost
//
// Usage: PORT=38281 node _probe-exthost-keepalive.mjs

import { chromium } from "playwright";

const PORT = process.env.PORT || "8080";
const URL = `http://localhost:${PORT}/?folder=/home/coder/project`;
const SETTLE_MS = Number(process.env.SETTLE_MS || 10000);

const stamp = () => new Date().toISOString().slice(11, 19);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

console.log(`[${stamp()}] opening ${URL}`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
console.log(`[${stamp()}] workbench up; letting the extension host settle ${SETTLE_MS}ms`);
await page.waitForTimeout(SETTLE_MS);

// Report what the page thinks about the patch, so a missing patch is obvious here rather than
// looking like a keep-alive success.
const patched = await page.evaluate(() => typeof globalThis.__shimKeepExtHostAlive === "function");
console.log(`[${stamp()}] keep-alive patch present in bundle: ${patched}`);

console.log(`[${stamp()}] navigating away (fires pagehide, like closing the tab)`);
await page.goto("about:blank", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(2000); // let the goodbye (or its absence) reach the server
console.log(`[${stamp()}] detached`);

// Second phase: reopening the window cannot re-attach (a fresh page has no reconnection token),
// so it gets its own extension host and the kept-alive one becomes an orphan. The server reaps it
// after the *short* grace time, which the patch shortens from 5 minutes to seconds. Hold the new
// window open long enough for that to happen.
if (process.env.REOPEN !== "0") {
  const reopened = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  console.log(`[${stamp()}] reopening the window`);
  await reopened.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await reopened.waitForSelector(".monaco-workbench", { timeout: 60000 });
  const orphanWait = Number(process.env.ORPHAN_WAIT_MS || 30000);
  console.log(`[${stamp()}] reopened; holding it open ${orphanWait}ms to watch the orphan get reaped`);
  await reopened.waitForTimeout(orphanWait);
}

await browser.close();
console.log(`[${stamp()}] done — now inspect the container`);
