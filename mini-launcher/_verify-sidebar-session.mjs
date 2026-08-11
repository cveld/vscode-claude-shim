// Live end-to-end: with a `sidebar` + sessionId signal written, a fresh window should resume
// THAT session inside the side bar webview (via the bundle patch). We assert the session's
// distinctive text appears, and figure out whether it's in the side bar vs an editor tab.
import { chromium } from "playwright";
import fs from "node:fs";

const PORT = process.env.PORT || "8899";
const URL = `http://localhost:${PORT}/?folder=/home/coder/project`;
const OUT = process.env.OUT || ".";
const DISTINCTIVE = "What are you working on today?";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on("console", (m) => { const t = m.text(); if (/shim|sidebar|session|resume/i.test(t)) console.log("[page]", t.slice(0,160)); });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  // The companion extension waits for the Claude command, then reveals the side bar; the patched
  // build path then boots the webview into the session. Give it time.
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `${OUT}/live-sidebar-session.png` });

  // Find which frame holds the distinctive text and locate it (side bar vs editor area).
  const hits = [];
  for (const f of page.frames()) {
    try {
      const has = await f.evaluate((t) => !!(document.body && document.body.innerText.includes(t)), DISTINCTIVE);
      if (has) {
        // Locate the frame's iframe element in the parent to get its x position.
        const fe = await f.frameElement().catch(() => null);
        let box = null;
        if (fe) box = await fe.boundingBox().catch(() => null);
        hits.push({ url: f.url().slice(0, 50), name: f.name(), box });
      }
    } catch {}
  }
  const layout = await page.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; };
    return {
      viewportW: window.innerWidth,
      auxbar: r(".part.auxiliarybar"),
      sidebar: r(".part.sidebar"),
      editor: r(".part.editor"),
      editorTabs: [...document.querySelectorAll(".tabs-container .tab .label-name")].map((e) => e.textContent.trim()),
    };
  });

  // Decide region for each hit by x-position vs the layout parts.
  function regionFor(box) {
    if (!box || !layout.auxbar) return "unknown";
    const cx = box.x + box.width / 2;
    const inAux = layout.auxbar && cx >= layout.auxbar.x - 5 && cx <= layout.auxbar.x + layout.auxbar.w + 5;
    const inEditor = layout.editor && cx >= layout.editor.x - 5 && cx <= layout.editor.x + layout.editor.w + 5;
    if (inAux) return "AUX_SIDEBAR";
    if (inEditor) return "EDITOR";
    return "other";
  }
  const result = {
    distinctiveFound: hits.length > 0,
    hits: hits.map((h) => ({ ...h, region: regionFor(h.box) })),
    layout,
  };
  fs.writeFileSync(`${OUT}/live-sidebar-session.json`, JSON.stringify(result, null, 2));
  console.log("LIVE RESULT:", JSON.stringify(result));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
