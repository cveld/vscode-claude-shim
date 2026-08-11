// Broker client: what the extension actually gets as its "Claude process".
//
// Invoked by wrapper.sh as `node client.mjs <executable> <cli args...>`, with the extension's three
// pipes as its own stdio. It hands the argv to the broker, which owns the real CLI process, and
// relays the streams. When the extension host dies this process dies with it — and that is fine,
// because the CLI it stands in for belongs to the broker. See docs/plan-session-broker.md.
//
// Two hard rules:
//   - stdout is a strict NDJSON channel. Nothing of ours may ever be written to it.
//   - if the broker is unreachable, degrade to stock behaviour rather than block the user.

import net from "node:net";
import { spawn } from "node:child_process";

const SOCK = process.env.SHIM_BROKER_SOCK || "/tmp/claude-broker.sock";
const argv = process.argv.slice(2);

let connected = false;
let relayed = false; // Anything received from the broker.
let forwarded = false; // Anything sent to the broker.
let finishing = false;

function warn(msg) {
  try {
    process.stderr.write(`[claude-broker-client] ${msg}\n`);
  } catch {
    // Nowhere left to complain to.
  }
}

const SIGNAL_NUMBERS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

function exitCodeFor(code, signal) {
  if (signal) return 128 + (SIGNAL_NUMBERS[signal] || 0);
  return code === null || code === undefined ? 0 : code;
}

/**
 * Winds down without process.exit(), which would truncate stdout: writes to a pipe are async, and
 * the last NDJSON frames of a turn are exactly what must not be lost. Releasing the handles lets
 * Node exit on its own once stdout has drained.
 */
function finish(code) {
  if (finishing) return;
  finishing = true;
  process.exitCode = code;
  try {
    sock.destroy();
  } catch {
    // Already gone.
  }
  try {
    process.stdin.pause();
    process.stdin.destroy();
  } catch {
    // Already gone.
  }
}

/** Stock behaviour: run the CLI ourselves, as if no wrapper were configured. */
function fallbackDirect(reason) {
  if (relayed || forwarded) {
    // Too late to start over — the query is already half-executed on the broker side, and running
    // it again would duplicate the turn.
    warn(`broker connection lost mid-query (${reason}); giving up`);
    finish(1);
    return;
  }
  warn(`broker unreachable (${reason}); running the CLI directly`);
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
  } catch (err) {
    warn(`direct spawn failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  child.on("error", (err) => {
    warn(`direct spawn failed: ${err.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = exitCodeFor(code, signal);
  });
}

if (argv.length === 0) {
  warn("no command given");
  process.exit(2);
}

const sock = net.createConnection(SOCK);
let lineBuf = "";

sock.on("connect", () => {
  connected = true;
  sock.write(
    JSON.stringify({ t: "hello", argv, cwd: process.cwd(), env: process.env }) + "\n",
  );

  process.stdin.on("data", (chunk) => {
    forwarded = true;
    if (sock.destroyed) return;
    sock.write(JSON.stringify({ t: "stdin", d: chunk.toString("base64") }) + "\n");
  });
  process.stdin.on("error", () => {
    // The extension host going away closes this pipe; the broker keeps the CLI alive regardless.
  });
  process.stdin.on("end", () => {
    if (!sock.destroyed) sock.write(JSON.stringify({ t: "stdin-end" }) + "\n");
  });
  process.stdin.resume();
});

sock.on("data", (chunk) => {
  lineBuf += chunk.toString("utf8");
  let idx;
  while ((idx = lineBuf.indexOf("\n")) !== -1) {
    const line = lineBuf.slice(0, idx).trim();
    lineBuf = lineBuf.slice(idx + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      warn("unparseable broker frame");
      finish(1);
      return;
    }

    if (msg.t === "stdout") {
      relayed = true;
      process.stdout.write(Buffer.from(msg.d || "", "base64"));
    } else if (msg.t === "stderr") {
      relayed = true;
      process.stderr.write(Buffer.from(msg.d || "", "base64"));
    } else if (msg.t === "exit") {
      finish(exitCodeFor(msg.code, msg.signal));
      return;
    } else if (msg.t === "fatal") {
      fallbackDirect(msg.msg || "broker reported a fatal error");
      return;
    } else if (msg.t === "ready") {
      relayed = true;
    }
  }
});

sock.on("error", (err) => {
  if (finishing) return;
  if (!connected) {
    fallbackDirect(err.code || err.message);
    return;
  }
  warn(`broker socket error: ${err.code || err.message}`);
  finish(1);
});

sock.on("close", () => {
  if (finishing) return;
  fallbackDirect("broker closed the connection");
});

// The extension host can vanish at any moment, taking our stdout pipe with it. That is not an
// error worth reporting — the CLI keeps running on the broker side.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") finish(0);
});
process.stderr.on("error", () => {});

// Watchdog for the parent going away. Without it we linger as a zombie: an idle session produces no
// output, so there is no write to fail with EPIPE, and stdin reaching EOF is not by itself proof the
// parent is gone. That matters to the broker, not just to us — while this socket stays open the
// broker still counts a client as attached, so it never detaches the session, never closes the CLI's
// stdin after a completed turn, and never reaps the record. Reparenting is the reliable signal.
const initialPpid = process.ppid;
setInterval(() => {
  if (process.ppid !== initialPpid) {
    warn("parent process is gone; disconnecting (the CLI stays alive on the broker)");
    finish(0);
  }
}, 2000).unref();
