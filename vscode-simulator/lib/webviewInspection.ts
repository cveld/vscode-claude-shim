import type { ConsoleMessage, Page, Request } from "@playwright/test";

export type InspectionMessage = {
  type: string;
  text: string;
  location?: string;
};

export type FailedRequest = {
  url: string;
  method: string;
  resourceType: string;
  errorText: string;
};

export type NetworkEntry = {
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  ok: boolean | null;
};

export type WebviewInspectionResult = {
  consoleMessages: InspectionMessage[];
  pageErrors: string[];
  requestFailures: FailedRequest[];
  network: NetworkEntry[];
  extraAssetRequests: string[];
  bridgeMessages: unknown[];
  bridgeMessageTypes: string[];
};

const NEXT_NOISE_MARKERS = ["/_next/webpack-hmr", "/_next/static/chunks/"];

export function createWebviewInspection(page: Page) {
  const consoleMessages: InspectionMessage[] = [];
  const pageErrors: string[] = [];
  const requestFailures: FailedRequest[] = [];
  const network = new Map<string, NetworkEntry>();

  page.on("console", (message) => {
    const text = message.text();
    if (shouldIgnoreUrl(text)) return;
    consoleMessages.push({
      type: message.type(),
      text,
      location: formatLocation(message),
    });
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.stack ?? error.message);
  });

  page.on("request", (request) => {
    upsertNetworkEntry(network, request, null, null);
  });

  page.on("response", (response) => {
    upsertNetworkEntry(network, response.request(), response.status(), response.ok());
  });

  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "Unknown request failure";
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      errorText,
    });
    upsertNetworkEntry(network, request, null, false);
  });

  return {
    async collect(): Promise<WebviewInspectionResult> {
      const entries = Array.from(network.values()).filter((entry) => !shouldIgnoreUrl(entry.url));
      const extraAssetRequests = entries
        .map((entry) => entry.url)
        .filter((url) => url.includes("/api/webview-asset?path="))
        .map(extractAssetPath)
        .filter((assetPath): assetPath is string => Boolean(assetPath))
        .filter((assetPath) => assetPath !== "index.js" && assetPath !== "index.css")
        .filter((assetPath, index, all) => all.indexOf(assetPath) === index)
        .sort();

      const bridgeMessages = await readBridgeMessages(page);
      const bridgeMessageTypes = bridgeMessages
        .map((message) => {
          if (message && typeof message === "object" && "type" in message) {
            const value = (message as { type?: unknown }).type;
            return typeof value === "string" ? value : JSON.stringify(value);
          }
          return typeof message;
        })
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort();

      return {
        consoleMessages,
        pageErrors,
        requestFailures,
        network: entries,
        extraAssetRequests,
        bridgeMessages,
        bridgeMessageTypes,
      };
    },
  };
}

function upsertNetworkEntry(
  network: Map<string, NetworkEntry>,
  request: Request,
  status: number | null,
  ok: boolean | null,
) {
  const key = `${request.method()} ${request.url()} ${request.resourceType()}`;
  const current = network.get(key);
  network.set(key, {
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    status: status ?? current?.status ?? null,
    ok: ok ?? current?.ok ?? null,
  });
}

function formatLocation(message: ConsoleMessage): string | undefined {
  const location = message.location();
  if (!location.url) return undefined;
  return `${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`;
}

function extractAssetPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("path");
  } catch {
    return null;
  }
}

function shouldIgnoreUrl(value: string): boolean {
  return NEXT_NOISE_MARKERS.some((marker) => value.includes(marker));
}

async function readBridgeMessages(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const messages = (window as Window & { __webviewExperimentMessages?: unknown[] }).__webviewExperimentMessages;
    return Array.isArray(messages) ? messages : [];
  });
}
