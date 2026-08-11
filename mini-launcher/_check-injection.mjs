// Verify the bundle patch injected data-initial-session into the side bar webview's #root,
// independent of whether Claude is authenticated (login screen still renders inside #root).
import { chromium } from "playwright";

const PORT = process.env.PORT || "8899";
const URL = `http://localhost:${PORT}/?folder=/home/coder/project`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await page.waitForTimeout(15000);

  const findings = [];
  for (const f of page.frames()) {
    try {
      const info = await f.evaluate(() => {
        const root = document.getElementById("root");
        if (!root) return null;
        return {
          initialSession: root.getAttribute("data-initial-session"),
          isSidebar: typeof window.IS_SIDEBAR !== "undefined" ? window.IS_SIDEBAR : null,
          isFullEditor: typeof window.IS_FULL_EDITOR !== "undefined" ? window.IS_FULL_EDITOR : null,
          isSessionListOnly: typeof window.IS_SESSION_LIST_ONLY !== "undefined" ? window.IS_SESSION_LIST_ONLY : null,
        };
      });
      if (info) findings.push({ frame: f.name() || "(root)", url: f.url().slice(0, 45), ...info });
    } catch {}
  }
  console.log("INJECTION CHECK:", JSON.stringify(findings, null, 2));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
