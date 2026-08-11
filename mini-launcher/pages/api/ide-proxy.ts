import type { Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import type { NextApiRequest, NextApiResponse } from "next";
import { WebSocket, WebSocketServer } from "ws";

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(426).json({ error: "Use WebSocket upgrade" });
}

async function onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
  const url = new URL(req.url ?? "/api/ide-proxy", "http://localhost:4591");
  const port = Number(url.searchParams.get("port"));
  const authToken = url.searchParams.get("authToken");

  if (!Number.isFinite(port) || !authToken) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const target = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: {
      "x-claude-code-ide-authorization": authToken,
    },
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.handleUpgrade(req, socket, head, (client: WebSocket) => {
    target.on("open", () => {
      client.on("message", (data, isBinary) => target.send(data, { binary: isBinary }));
      target.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
      client.on("close", (code, reason) => target.close(code, reason.toString()));
      target.on("close", (code, reason) => client.close(code, reason.toString()));
      client.on("error", () => target.close());
      target.on("error", () => client.close());
    });

    target.on("error", () => {
      client.close();
    });
  });
}

const globalWithProxy = globalThis as typeof globalThis & {
  __miniLauncherIdeProxyInstalled__?: boolean;
};

if (!globalWithProxy.__miniLauncherIdeProxyInstalled__) {
  globalWithProxy.__miniLauncherIdeProxyInstalled__ = true;
  process.nextTick(() => {
    const server = (globalThis as { __NEXT_DEV_SERVER__?: { server?: { on?: Function } } }).__NEXT_DEV_SERVER__?.server;
    if (!server?.on) return;
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      if (typeof req.url !== "string" || !req.url.startsWith("/api/ide-proxy")) return;
      void onUpgrade(req, socket, head);
    });
  });
}