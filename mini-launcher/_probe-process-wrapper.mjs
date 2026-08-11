// Probe: is `claudeCode.claudeProcessWrapper` honoured for a real agent query?
//
// The setting is the interposition point for a session-broker daemon: if the extension launches
// the CLI through a wrapper we control, that wrapper can hand the process off to a long-lived
// daemon instead of letting it die with the extension host. Confirming the short `auth status`
// call goes through the wrapper is not enough — what matters is the stream-json query, which is
// the process that carries a running turn.
//
// This script opens a window and holds it, so a session-open signal written beforehand
// (~/.claude/.shim-open-session) makes the extension resume that session and spawn the CLI.
// Inspect the container while it holds:
//
//   docker exec <container> cat /tmp/shim-wrapper-probe.log
//   docker exec <container> ps -eo pid,ppid,args --no-headers | grep -i claude
//
// Usage: PORT=37431 HOLD_MS=45000 node _probe-process-wrapper.mjs

import { chromium } from "playwright";

const PORT = process.env.PORT || "8080";
const URL = `http://localhost:${PORT}/?folder=/home/coder/project`;
const HOLD_MS = Number(process.env.HOLD_MS || 45000);

const stamp = () => new Date().toISOString().slice(11, 19);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

console.log(`[${stamp()}] opening ${URL}`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
console.log(`[${stamp()}] workbench up; holding ${HOLD_MS}ms for the session to resume`);
await page.waitForTimeout(HOLD_MS);

console.log(`[${stamp()}] done holding — leaving the window open is not possible, detaching now`);
await browser.close();
