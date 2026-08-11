// Stable per-project URL through the host's Caddy proxy, instead of `localhost:<random port>`.
//
// Every instance is reachable at `http://<slug>.mini-launcher.carlintveld.localhost` — no port, and
// the same link after every container restart (Docker hands out a new host port on each start, which
// is why the port URL is only a fallback here). Chromium resolves any `*.localhost` name to 127.0.0.1
// without hosts-file entries and still treats it as a secure context over plain HTTP.
//
// Caddy needs exactly one route for all of this, because it accepts placeholders in the upstream
// address: the request's own subdomain label is used as the upstream host, which resolves to the
// container's network alias over Docker DNS. So nothing here is per-project — new projects need no
// Caddy change at all. See docs/plan-launcher.md decision 10 for the reverse-engineering behind it.
//
// The route lives in Caddy's *runtime* config. A Caddy restart re-adapts its Caddyfile and drops it,
// and Caddy offers no notification for that, so `ensureProxyRoute()` simply checks and re-pushes —
// cheaply, memoized, on the paths the launcher already has (launch, and the instance-status poll).

import http from "node:http";
import crypto from "node:crypto";
import Docker from "dockerode";
import type { Instance } from "@/mini-lib/docker";

/** Suffix the instance subdomain is placed under. */
export const PROXY_DOMAIN = process.env.SHIM_PROXY_DOMAIN || "mini-launcher.carlintveld.localhost";

/** Docker network shared with the Caddy container, so Caddy can resolve instances by alias. */
export const PROXY_NETWORK = process.env.SHIM_PROXY_NETWORK || "shim-net";

/** Caddy's admin API. Published on the host's loopback by the proxy's own compose file. */
const CADDY_ADMIN = process.env.SHIM_CADDY_ADMIN || "http://127.0.0.1:2019";

/** The proxy container itself, which has to share PROXY_NETWORK for Docker DNS to resolve aliases. */
const PROXY_CONTAINER = process.env.SHIM_PROXY_CONTAINER || "caddy-proxy";

// Same endpoint as lib/docker.ts; kept local so this module does not import it back and create a
// runtime import cycle (docker.ts already imports this one).
const DOCKER_PIPE = "//./pipe/docker_engine";
const docker = new Docker({ socketPath: DOCKER_PIPE });

/** Addressable id for our route, so it can be read and replaced without touching array indices. */
const ROUTE_ID = "shim-wildcard";

/** Kept short: this runs on the UI's 5s status poll, and a missing Caddy must not slow it down. */
const ADMIN_TIMEOUT_MS = 1500;

/** How long a successful check is trusted before Caddy is queried again. */
const ENSURE_TTL_MS = 30_000;

const CONTAINER_PORT = 8080;

/**
 * Instance subdomain label: a DNS label derived deterministically from the project, so the URL is
 * stable across restarts and unique per root + folder.
 */
export function slugFor(rootId: string, relativePath: string): string {
  const raw = `${rootId}-${relativePath}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = raw || "instance";
  if (base.length <= 63) return base;
  // Too long for a DNS label — truncate and re-add uniqueness with a hash of the full value.
  const hash = crypto.createHash("sha256").update(base).digest("hex").slice(0, 8);
  return `${base.slice(0, 54).replace(/-+$/, "")}-${hash}`;
}

export function proxyUrlFor(slug: string): string {
  return `http://${slug}.${PROXY_DOMAIN}`;
}

type AdminResponse = { status: number; body: string };

// Deliberately `node:http` rather than `fetch`: undici always sends `Sec-Fetch-Mode: cors`, which
// makes Caddy apply its browser cross-origin check and answer
// `403 client is not allowed to access from origin ''`. Sending an `Origin` matching the admin listen
// address also works, but only while admin stays bound to that address; this does not depend on it.
function adminRequest(method: string, path: string, body?: unknown): Promise<AdminResponse> {
  const url = new URL(path, CADDY_ADMIN);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        timeout: ADMIN_TIMEOUT_MS,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Caddy admin API timed out after ${ADMIN_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function wildcardRoute() {
  // Host labels are indexed from the right, so the instance label sits one past the domain's own
  // labels. Derived rather than hardcoded, so changing SHIM_PROXY_DOMAIN cannot silently break it.
  const slugLabel = PROXY_DOMAIN.split(".").length;
  return {
    "@id": ROUTE_ID,
    match: [{ host: [`*.${PROXY_DOMAIN}`] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `{http.request.host.labels.${slugLabel}}:${CONTAINER_PORT}` }],
      },
    ],
    terminal: true,
  };
}

function sameRoute(existing: any, expected: any): boolean {
  return (
    JSON.stringify(existing?.match) === JSON.stringify(expected.match) &&
    JSON.stringify(existing?.handle) === JSON.stringify(expected.handle)
  );
}

/** The HTTP server that listens on :80 — where a browser reaches a portless URL. */
async function serverKeyForPort80(): Promise<string> {
  const res = await adminRequest("GET", "/config/apps/http/servers/");
  if (res.status !== 200) throw new Error(`Caddy has no HTTP servers configured (HTTP ${res.status})`);
  const servers = JSON.parse(res.body || "{}") as Record<string, { listen?: string[] }>;
  for (const [key, server] of Object.entries(servers)) {
    if ((server.listen ?? []).some((addr) => addr === ":80" || addr.endsWith(":80"))) return key;
  }
  throw new Error("Caddy has no server listening on :80");
}

/**
 * Caddy resolves instances by Docker DNS, which only works for containers sharing the network. If the
 * proxy container is not attached, the route is installed fine but every request 502s — so this is
 * checked too, and the launcher reports "no stable URL" rather than offering a link that cannot work.
 */
async function proxyContainerOnNetwork(): Promise<void> {
  const info = await docker.getContainer(PROXY_CONTAINER).inspect();
  if (!info.NetworkSettings?.Networks?.[PROXY_NETWORK]) {
    throw new Error(
      `${PROXY_CONTAINER} is not attached to the ${PROXY_NETWORK} network — run: docker network connect ${PROXY_NETWORK} ${PROXY_CONTAINER}`,
    );
  }
}

let lastEnsuredAt = 0;

/**
 * Makes sure Caddy carries the wildcard route, and reports whether proxy URLs are usable.
 *
 * Never throws: when Caddy is down the launcher must stay fully usable through the published-port
 * URL, so callers treat `false` as "hand out the fallback link".
 */
export async function ensureProxyRoute(): Promise<boolean> {
  if (Date.now() - lastEnsuredAt < ENSURE_TTL_MS) return true;

  try {
    await proxyContainerOnNetwork();

    const expected = wildcardRoute();
    const existing = await adminRequest("GET", `/id/${ROUTE_ID}`);

    if (existing.status === 200) {
      // Present, but possibly stale — SHIM_PROXY_DOMAIN may have changed since it was installed.
      if (sameRoute(JSON.parse(existing.body || "{}"), expected)) {
        lastEnsuredAt = Date.now();
        return true;
      }
      const replaced = await adminRequest("PATCH", `/id/${ROUTE_ID}`, expected);
      if (replaced.status >= 300) throw new Error(`could not update route: HTTP ${replaced.status} ${replaced.body}`);
      lastEnsuredAt = Date.now();
      return true;
    }

    const serverKey = await serverKeyForPort80();
    const added = await adminRequest("POST", `/config/apps/http/servers/${serverKey}/routes`, expected);
    if (added.status >= 300) throw new Error(`could not add route: HTTP ${added.status} ${added.body}`);
    lastEnsuredAt = Date.now();
    return true;
  } catch (err: any) {
    lastEnsuredAt = 0;
    console.warn(`[proxy] no stable URL available: ${err?.message ?? err}`);
    return false;
  }
}

export type ProxiedInstance = Instance & { proxyUrl: string | null };

/** Adds the stable URL to an instance, or `null` when the proxy cannot serve it right now. */
export async function withProxyUrl(instance: Instance): Promise<ProxiedInstance>;
export async function withProxyUrl(instance: null): Promise<null>;
export async function withProxyUrl(instance: Instance | null): Promise<ProxiedInstance | null> {
  if (!instance) return null;
  const available = await ensureProxyRoute();
  return { ...instance, proxyUrl: available ? proxyUrlFor(instance.slug) : null };
}
