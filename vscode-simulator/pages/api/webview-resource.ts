import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import path from "node:path";
import { resolveExtensionResourcePath } from "@/simulator-lib/webviewAssets";

// Serves files from the installed extension's resources/ directory (logos, icons, welcome art)
// under the same-origin /resources/ prefix. The facade's asWebviewUri rewrites the extension's
// file:// resource URIs to this prefix, so the webview's asset_uris_response points here.
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawPath = req.query.path;
  if (!rawPath || Array.isArray(rawPath)) {
    return res.status(400).json({ error: "Missing asset path query parameter" });
  }

  try {
    const assetPath = resolveExtensionResourcePath(rawPath);
    if (!fs.existsSync(assetPath)) {
      return res.status(404).json({ error: "Requested extension resource does not exist" });
    }

    const stat = fs.statSync(assetPath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: "Requested extension resource is not a file" });
    }

    const extension = path.extname(assetPath).toLowerCase();
    res.setHeader("Content-Type", CONTENT_TYPES[extension] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(assetPath).pipe(res);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
}
