import { expect, test } from "@playwright/test";

test("session tile sends a defined sessionId in the request body", async ({ page }) => {
  let sessionsRouteHits = 0;
  const expectedSessionId = "session-123";
  const capturedBodySessionIds: Array<string | null> = [];

  await page.route("**/api/instance", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        instance: {
          id: "inst-1",
          name: "shim-inst-1",
          rootId: "root-a",
          relativePath: "demo",
          type: "folder",
          password: "",
          createdAt: Date.now(),
          port: 8080,
          state: "running",
        },
      }),
    });
  });

  await page.route("**/api/sessions", async (route) => {
    sessionsRouteHits += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: expectedSessionId,
          title: "Debug session",
          firstUserMessage: "Inspect request payload",
          startedAt: "2026-07-15T00:00:00.000Z",
          lastActivity: "2026-07-15T00:05:00.000Z",
          messageCount: 3,
          totalTokensBurned: 42,
          isActive: true,
          instanceUrl: "http://localhost:8080",
          canOpen: true,
          openMode: "session-open",
        },
      ]),
    });
  });

  await page.route("**/api/session-open", async (route) => {
    const request = route.request();
    const bodyText = request.postData() ?? "";
    const body = bodyText ? JSON.parse(bodyText) : {};

    capturedBodySessionIds.push(typeof body.sessionId === "string" ? body.sessionId : null);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        sessionId: expectedSessionId,
        openUrl: "http://localhost:8080",
        openMode: "fallback",
        reason: "Session targeting is not wired yet; opening container root.",
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Claude sessions" })).toBeVisible();
  await expect.poll(() => sessionsRouteHits).toBeGreaterThan(0);

  const tile = page.getByRole("button", { name: /Debug session/i });
  await expect(tile).toBeVisible();
  await tile.click();

  await expect.poll(() => capturedBodySessionIds.length).toBe(1);
  expect(capturedBodySessionIds[0]).toBe(expectedSessionId);

  await expect(page.getByText("sessionId is required")).toHaveCount(0);
  await expect(page.getByText("Claude session not found for the pinned folder")).toHaveCount(0);
});
