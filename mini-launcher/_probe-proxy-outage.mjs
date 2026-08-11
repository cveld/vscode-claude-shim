// Probe: is the "launcher re-pushes its Caddy route" repair pattern actually survivable for an open
// tab, or does a proxy outage cost you the window?
//
// Context: the wildcard route that maps `<slug>.shim.<domain>` to a container lives in Caddy's runtime
// config (see docs/plan-launcher.md decision 10). A Caddy restart re-adapts the Caddyfile and drops it,
// so the launcher has to notice and re-push. Caddy sends no notification — the launcher just checks,
// which is what ensureRoute() below does: `GET /id/<id>` returns 200 when present and 404
// (`unknown object ID`) when not.
//
// This simulates the worst case: delete the route while a workbench is open and connected, leave it
// broken, then repair it the way the launcher would. Afterwards check the container log for
//
//     [ManagementConnection] The client has disconnected, will wait for reconnection ...
//     [ManagementConnection] The client has reconnected.
//
// which is VS Code's own reconnect path — the one case where re-attach *is* supported, because the
// page is still alive.
//
// Usage: SLUG=2026-07-vscode-shim-tester node _probe-proxy-outage.mjs

import http from "node:http";
import { chromium } from "playwright";

const ADMIN = process.env.CADDY_ADMIN || "http://127.0.0.1:2019";
const ROUTE_ID = process.env.ROUTE_ID || "shim-wildcard";
const SERVER = process.env.CADDY_SERVER || "srv0";
const DOMAIN = process.env.DOMAIN || "shim.carlintveld.localhost";
const SLUG = process.env.SLUG || "2026-07-vscode-shim-tester";
const FILE = process.env.FILE || "test.txt";
const OUTAGE_MS = Number(process.env.OUTAGE_MS || 12000);

const stamp = () => new Date().toISOString().slice(11, 19);

const ROUTE = {
  "@id": ROUTE_ID,
  match: [{ host: [`*.${DOMAIN}`] }],
  handle: [
    {
      handler: "reverse_proxy",
      upstreams: [{ dial: "{http.request.host.labels.3}:8080" }],
    },
  ],
  terminal: true,
};

// Caddy's admin API rejects `fetch()` from Node with
// `403 client is not allowed to access from origin ''`, because undici always sends
// `Sec-Fetch-Mode: cors` and Caddy then treats the call as a browser cross-origin request. The
// allowed origin defaults to the admin *listen* address, so `Origin: http://0.0.0.0:2019` also works
// here — but only while admin stays bound to 0.0.0.0. `node:http` sends no `Sec-Fetch-*` headers at
// all, so it is accepted regardless of how admin is bound. That is what the launcher should use.
function adminRequest(method, path, body) {
  const url = new URL(path, ADMIN);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Exactly the check the launcher would run: cheap, idempotent, no notification needed.
async function ensureRoute() {
  const probe = await adminRequest("GET", `/id/${ROUTE_ID}`);
  if (probe.status === 200) return "already present";
  const res = await adminRequest("POST", `/config/apps/http/servers/${SERVER}/routes`, ROUTE);
  if (res.status >= 300) throw new Error(`could not add route: HTTP ${res.status} ${res.body}`);
  return "re-added";
}

async function deleteRoute() {
  const res = await adminRequest("DELETE", `/id/${ROUTE_ID}`);
  if (res.status >= 300) throw new Error(`could not delete route: HTTP ${res.status} ${res.body}`);
}

async function reconnectBanner(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || "";
    const hit = text.split("\n").find((l) => /reconnect|disconnect/i.test(l));
    return hit ? hit.trim().slice(0, 120) : null;
  });
}

console.log(`[${stamp()}] ensureRoute: ${await ensureRoute()}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const url = `http://${SLUG}.${DOMAIN}/?folder=/home/coder/project`;
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
// The Explorer only lists files once the management connection is up, so this asserts connectivity.
await page.waitForFunction((n) => document.body.innerText.includes(n), FILE, { timeout: 45000 });
console.log(`[${stamp()}] connected through the proxy`);

console.log(`[${stamp()}] deleting the route — proxy outage begins`);
await deleteRoute();
await page.waitForTimeout(OUTAGE_MS);
console.log(`[${stamp()}] during outage, page says: ${JSON.stringify(await reconnectBanner(page))}`);

console.log(`[${stamp()}] repairing: ensureRoute -> ${await ensureRoute()}`);
await page.waitForTimeout(20000);
console.log(`[${stamp()}] after repair, page says: ${JSON.stringify(await reconnectBanner(page))}`);

// Does the still-open page work again? The Explorer entry is served over the restored connection.
const recovered = await page
  .waitForFunction((n) => document.body.innerText.includes(n), FILE, { timeout: 30000 })
  .then(() => true)
  .catch(() => false);
console.log(`[${stamp()}] workbench functional again: ${recovered}`);
await page.screenshot({ path: process.env.OUT || "proxy-outage.png" });

await browser.close();
