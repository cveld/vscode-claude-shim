import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createWebviewInspection } from "@/simulator-lib/webviewInspection";

const FRAME_SELECTOR = 'iframe[data-testid="webview-frame"]';

test("captures the render-first webview runtime signals", async ({ page }, testInfo) => {
  const inspection = createWebviewInspection(page);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  // Not "networkidle": the panel and iframe hold long-lived SSE streams open by design.
  await page.waitForLoadState("load");

  // The bundle renders in an isolated same-origin iframe; reach into its document to observe it.
  await page.waitForSelector(FRAME_SELECTOR, { timeout: 30_000 });

  await page.waitForFunction(
    (selector) => {
      const iframe = document.querySelector(selector) as HTMLIFrameElement | null;
      const root = iframe?.contentDocument?.getElementById("root");
      return Boolean(root && (root.textContent ?? "").trim().length > 0);
    },
    FRAME_SELECTOR,
    { timeout: 40_000 },
  );

  // Give the bundle a moment to complete its init round-trip through the shim session.
  await page.waitForTimeout(2_000);

  const panelHeading = page.getByRole("heading", { name: "Render-first webview experiment" });
  const panelSection = page.locator("section.panel", { has: panelHeading }).first();
  const status = page.locator('[data-testid="webview-experiment-status"]').first();
  const renderSurface = page.locator('[data-testid="webview-render-surface"]').first();
  const eventLog = page.locator('[data-testid="webview-event-log"]').first();
  const frame = page.locator(FRAME_SELECTOR).first();
  const renderRoot = page.frameLocator(FRAME_SELECTOR).locator("#root");

  await expect(panelHeading).toBeVisible();
  await expect(panelSection).toBeVisible();
  await expect(status).toBeVisible();
  await expect(renderSurface).toBeVisible();
  await expect(eventLog).toBeVisible();
  await expect(frame).toBeVisible();

  const statusText = ((await status.textContent()) ?? "").trim();
  const eventLogText = (await eventLog.textContent()) ?? "";

  const frameContent = await page.evaluate((selector) => {
    const iframe = document.querySelector(selector) as HTMLIFrameElement | null;
    const root = iframe?.contentDocument?.getElementById("root");
    return {
      html: root?.innerHTML ?? "",
      text: (root?.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  }, FRAME_SELECTOR);

  const renderBox = await renderRoot.boundingBox();
  const visibleRender = Boolean(renderBox && renderBox.width > 0 && renderBox.height > 0);
  const meaningfulRender = frameContent.text.length > 0;

  const screenshotPath = testInfo.outputPath("webview-inspection.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const collected = await inspection.collect();
  const summary = {
    statusText,
    visibleRender,
    meaningfulRender,
    renderText: frameContent.text,
    renderHtml: frameContent.html,
    eventLogText,
    screenshotPath,
    consoleMessages: collected.consoleMessages,
    pageErrors: collected.pageErrors,
    requestFailures: collected.requestFailures,
    network: collected.network,
    extraAssetRequests: collected.extraAssetRequests,
  };

  const summaryPath = testInfo.outputPath("webview-inspection-summary.json");
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  testInfo.annotations.push({ type: "status", description: statusText });
  testInfo.annotations.push({ type: "visibleRender", description: String(visibleRender) });
  testInfo.annotations.push({ type: "meaningfulRender", description: String(meaningfulRender) });
  testInfo.annotations.push({ type: "extraAssetRequests", description: JSON.stringify(collected.extraAssetRequests) });
  testInfo.annotations.push({ type: "requestFailures", description: JSON.stringify(collected.requestFailures) });
  testInfo.annotations.push({ type: "pageErrors", description: JSON.stringify(collected.pageErrors) });

  console.log(`Webview inspection status: ${statusText}`);
  console.log(`Webview inspection visible render: ${visibleRender}`);
  console.log(`Webview inspection meaningful render: ${meaningfulRender}`);
  console.log(`Webview inspection render text: ${frameContent.text}`);
  console.log(`Webview inspection extra asset requests: ${JSON.stringify(collected.extraAssetRequests)}`);
  console.log(`Webview inspection request failures: ${JSON.stringify(collected.requestFailures)}`);
  console.log(`Webview inspection page errors: ${JSON.stringify(collected.pageErrors)}`);

  const repoArtifactsDir = path.resolve(process.cwd(), "artifacts", "webview-inspection");
  await fs.mkdir(repoArtifactsDir, { recursive: true });
  await fs.writeFile(path.join(repoArtifactsDir, "latest-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await fs.copyFile(screenshotPath, path.join(repoArtifactsDir, "latest-screenshot.png"));

  expect(statusText.length).toBeGreaterThan(0);
  expect(eventLogText.length).toBeGreaterThan(0);
  expect(meaningfulRender).toBe(true);
});
