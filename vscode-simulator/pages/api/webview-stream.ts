import type { NextApiRequest, NextApiResponse } from "next";
import { getShimSession } from "@/simulator-lib/shimSession";

// Server-Sent Events stream of host→webview messages from the persistent shim session
// (build-plan slice 2). The browser panel opens this to receive every message the real
// extension posts through `webview.postMessage`, starting with the backlog captured before
// the connection (so the initial `session_states_update` is never missed).
//
// Optional `?viewId=` filters to a single webview view; omit it to receive all views'
// messages (each event carries its own viewId).
export const config = {
  api: {
    // SSE must not be buffered by Next's response handling.
    responseLimit: false,
    bodyParser: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const viewFilter = typeof req.query.viewId === "string" ? req.query.viewId : null;

  const session = await getShimSession();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ viewIds: session.viewIds(), viewFilter })}\n\n`);

  const unsubscribe = session.subscribe((entry) => {
    if (viewFilter && entry.viewId !== viewFilter) {
      return;
    }
    res.write(`id: ${entry.seq}\ndata: ${JSON.stringify({ viewId: entry.viewId, message: entry.message })}\n\n`);
  });

  // Heartbeat comment keeps intermediaries from closing an idle connection.
  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  req.on("error", cleanup);

  // Keep the handler open until the client disconnects.
  await new Promise<void>((resolve) => {
    req.on("close", resolve);
  });
}
