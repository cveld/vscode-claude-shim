import type { NextApiRequest, NextApiResponse } from "next";
import { getExtensionLabel } from "@/simulator-lib/extensionPaths";
import { getWebviewAssetInfo } from "@/simulator-lib/webviewAssets";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const info = getWebviewAssetInfo();
    // Serve entry assets under a real path prefix (/webview/…) rather than the query form
    // (/api/webview-asset?path=…). index.js is an ES module: a relative import like `./169.js`
    // resolves against the script's URL, so with a path prefix it becomes /webview/169.js
    // (also handled), whereas the query form drops the query and 404s on /api/169.js.
    return res.json({
      extensionLabel: getExtensionLabel(),
      assetRoot: info.assetRoot,
      entryScript: info.entryScript,
      entryStyle: info.entryStyle,
      entryScriptUrl: `/webview/${info.entryScript}`,
      entryStyleUrl: `/webview/${info.entryStyle}`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
