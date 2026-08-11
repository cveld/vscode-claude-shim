import { defineConfig } from "@playwright/test";

const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4592",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: reuseExistingServer
    ? undefined
    : {
        command: "npm run dev",
        url: "http://127.0.0.1:4592",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
