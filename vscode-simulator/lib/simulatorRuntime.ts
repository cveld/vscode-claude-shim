import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { IDE_HEADER, ideLockPath, removeLockfile, writeLockfile, generateAuthToken } from "@/simulator-lib/ideProtocol";
import { getPinnedTarget } from "@/simulator-lib/simulatorTarget";

export type SimulatorState = {
  id: string;
  rootId: string;
  relativePath: string;
  hostPath: string;
  type: "folder" | "workspace";
  workspaceFolders: string[];
  state: "stopped" | "starting" | "running" | "error";
  port: number | null;
  pid: number;
  lockFilePath: string | null;
  authTokenPresent: boolean;
  startedAt: string | null;
  lastConnectionAt: string | null;
  lastError: string | null;
  transport: "ws";
};

function createBaseState(): SimulatorState {
  const target = getPinnedTarget();
  return {
    id: target.id,
    rootId: target.rootId,
    relativePath: target.relativePath,
    hostPath: target.hostPath,
    type: target.type,
    workspaceFolders: target.workspaceFolders,
    state: "stopped",
    port: null,
    pid: process.pid,
    lockFilePath: null,
    authTokenPresent: false,
    startedAt: null,
    lastConnectionAt: null,
    lastError: null,
    transport: "ws",
  };
}

class SimulatorRuntimeManager {
  private state: SimulatorState = createBaseState();
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private authToken: string | null = null;
  private startPromise: Promise<SimulatorState> | null = null;
  private stopPromise: Promise<void> | null = null;

  getState(): SimulatorState {
    return { ...this.state, workspaceFolders: [...this.state.workspaceFolders] };
  }

  async start(): Promise<SimulatorState> {
    if (this.state.state === "running") {
      return this.getState();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<SimulatorState> {
    if (this.stopPromise) {
      await this.stopPromise;
      return this.getState();
    }

    this.stopPromise = this.doStop().finally(() => {
      this.stopPromise = null;
    });
    await this.stopPromise;
    return this.getState();
  }

  private async doStart(): Promise<SimulatorState> {
    await this.doStop();

    this.state = { ...createBaseState(), state: "starting" };

    try {
      const authToken = generateAuthToken();
      const server = http.createServer((_, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, transport: "ws" }));
      });
      const wss = new WebSocketServer({ noServer: true });

      server.on("upgrade", (req, socket, head) => {
        const incoming = req.headers[IDE_HEADER];
        const provided = Array.isArray(incoming) ? incoming[0] : incoming;
        if (!this.authToken || provided !== this.authToken) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      });

      wss.on("connection", (ws) => {
        this.state.lastConnectionAt = new Date().toISOString();
        ws.on("error", (err) => {
          this.state.lastError = err instanceof Error ? err.message : String(err);
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });

      const address = server.address() as AddressInfo | null;
      if (!address || typeof address.port !== "number") {
        throw new Error("Failed to resolve simulator runtime port");
      }

      const lockFilePath = writeLockfile(address.port, this.state.workspaceFolders, authToken);

      this.server = server;
      this.wss = wss;
      this.authToken = authToken;
      this.state = {
        ...this.state,
        state: "running",
        port: address.port,
        lockFilePath,
        authTokenPresent: true,
        startedAt: new Date().toISOString(),
        lastError: null,
      };

      return this.getState();
    } catch (err) {
      this.state = {
        ...this.state,
        state: "error",
        lastError: err instanceof Error ? err.message : String(err),
      };
      throw err;
    }
  }

  private async doStop(): Promise<void> {
    const currentPort = this.state.port;

    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.close(1001, "runtime-stopping");
        } catch {
          // Ignore close failures while shutting down.
        }
      }
      await new Promise<void>((resolve) => {
        this.wss?.close(() => resolve());
      });
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
    }

    if (currentPort !== null) {
      try {
        removeLockfile(currentPort);
      } catch (err) {
        this.state.lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const preserved = createBaseState();
    preserved.lastConnectionAt = this.state.lastConnectionAt;
    preserved.lastError = this.state.lastError;
    this.state = preserved;
    this.server = null;
    this.wss = null;
    this.authToken = null;
  }
}

declare global {
  var __vscodeSimulatorRuntime__: SimulatorRuntimeManager | undefined;
}

function getManager(): SimulatorRuntimeManager {
  if (!globalThis.__vscodeSimulatorRuntime__) {
    globalThis.__vscodeSimulatorRuntime__ = new SimulatorRuntimeManager();
  }
  return globalThis.__vscodeSimulatorRuntime__;
}

export const simulatorRuntime = {
  getState(): SimulatorState {
    return getManager().getState();
  },
  start(): Promise<SimulatorState> {
    return getManager().start();
  },
  stop(): Promise<SimulatorState> {
    return getManager().stop();
  },
};
