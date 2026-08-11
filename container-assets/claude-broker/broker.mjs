// Session broker: owns the Claude CLI processes so they outlive the extension host.
//
// The VS Code extension spawns the CLI as its own child, so closing the browser tab takes a
// running turn down with it. Launched through `claudeCode.claudeProcessWrapper`, the wrapper's
// client connects here instead, and this daemon becomes the CLI's parent. See
// docs/plan-session-broker.md for the design and docs/re/session-broker.md for the measurements
// it rests on.
//
// Two invariants carry the whole feature:
//
//   1. Always drain the child's stdout/stderr, attached client or not. An undrained pipe fills at
//      64KB and the CLI blocks mid-turn — the exact failure this exists to prevent.
//   2. Never end the child's stdin while it should live. Stdin EOF is *how* the CLI dies with the
//      extension host today.
//
// Step 1 deliberately does not reattach a new client to a live stream; see the collision handling
// below and "Step 2" in the plan.

import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";

const SOCK = process.env.SHIM_BROKER_SOCK || "/tmp/claude-broker.sock";
const BUFFER_BYTES = num("SHIM_BROKER_BUFFER_BYTES", 8 * 1024 * 1024);
const IDLE_KEEP_MS = num("SHIM_BROKER_IDLE_KEEP_MS", 10 * 60 * 1000);
const ORPHAN_MAX_MS = num("SHIM_BROKER_ORPHAN_MAX_MS", 30 * 60 * 1000);
const PARK_MS = num("SHIM_BROKER_PARK_MS", 45 * 1000);
const COLLISION = collisionMode();

// Guards the NDJSON line scanner against a stream that never produces a newline.
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** key -> record. A record is one CLI process plus everything we know about it. */
const records = new Map();
let recordSeq = 0;
let pendingSeq = 0;
let shuttingDown = false;

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function collisionMode() {
  const raw = (process.env.SHIM_BROKER_ON_COLLISION || "park").toLowerCase();
  if (raw === "park" || raw === "kill") return raw;
  log(`unsupported SHIM_BROKER_ON_COLLISION=${raw}; using park`);
  return "park";
}

function log(msg, rec) {
  const stamp = new Date().toISOString();
  const key = rec ? rec.key : "-";
  const pid = rec && rec.proc ? rec.proc.pid : "-";
  process.stdout.write(`[claude-broker] ${stamp} key=${key} pid=${pid} ${msg}\n`);
}

// ---------------------------------------------------------------------------- framing

function send(sock, obj) {
  if (!sock || sock.destroyed) return;
  try {
    sock.write(JSON.stringify(obj) + "\n");
  } catch {
    // A client that vanished mid-write is handled by its own close/error handlers.
  }
}

/** Feeds `chunk` through a line splitter, calling onLine for each complete line. */
function makeLineScanner(onLine) {
  let buf = "";
  let overflowed = false;
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      overflowed = false;
      if (line) onLine(line);
    }
    if (buf.length > MAX_LINE_BYTES) {
      if (!overflowed) {
        overflowed = true;
        log(`line scanner over ${MAX_LINE_BYTES} bytes without a newline; dropping partial`);
      }
      buf = "";
    }
  };
}

// ---------------------------------------------------------------------------- session keys

/**
 * The session id the extension asked to resume. Handed to us on the command line, which is why
 * the broker can decide new-or-existing before the process even starts.
 */
function parseResumeId(cliArgs) {
  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length) || null;
    if ((arg === "--resume" || arg === "-r") && i + 1 < cliArgs.length) {
      const next = cliArgs[i + 1];
      // `--resume` takes an optional value, so a following flag means "no id".
      if (next && !next.startsWith("-")) return next;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------- process control

/**
 * Children are spawned detached, so they lead their own process group. Signal the group, not just
 * the leader, or the CLI's own children (Bash tools and friends) are left behind.
 */
function killTree(rec, signal) {
  if (!rec.proc || rec.proc.pid === undefined) return;
  try {
    process.kill(-rec.proc.pid, signal);
    return;
  } catch {
    // No group (or already gone) — fall back to the leader.
  }
  try {
    rec.proc.kill(signal);
  } catch {
    // Already reaped.
  }
}

function terminate(rec, reason) {
  if (rec.exited) return;
  log(`terminating: ${reason}`, rec);
  killTree(rec, "SIGTERM");
  setTimeout(() => {
    if (!rec.exited) {
      log("SIGTERM ignored; escalating to SIGKILL", rec);
      killTree(rec, "SIGKILL");
    }
  }, 5000).unref();
}

function clearTimers(rec) {
  for (const name of ["idleTimer", "orphanTimer", "parkTimer"]) {
    if (rec[name]) {
      clearTimeout(rec[name]);
      rec[name] = null;
    }
  }
}

/** Removes a record, but only if it is still the one registered under its key. */
function dropRecord(rec, reason) {
  clearTimers(rec);
  if (records.get(rec.key) === rec) {
    records.delete(rec.key);
    log(`record dropped: ${reason}`, rec);
  }
}

/** True while `rec` is the live registration for its key — every timer must check this. */
function isCurrent(rec) {
  return records.get(rec.key) === rec;
}

function armIdleTimer(rec) {
  clearTimeout(rec.idleTimer);
  rec.idleTimer = setTimeout(() => {
    rec.idleTimer = null;
    if (!isCurrent(rec)) return;
    if (!rec.exited) terminate(rec, "idle keep window elapsed while still running");
    dropRecord(rec, "idle keep window elapsed");
  }, IDLE_KEEP_MS);
}

function armOrphanCap(rec) {
  if (rec.orphanTimer) return;
  const remaining = Math.max(0, ORPHAN_MAX_MS - (Date.now() - rec.startedAt));
  rec.orphanTimer = setTimeout(() => {
    rec.orphanTimer = null;
    if (!isCurrent(rec) || rec.exited) return;
    terminate(rec, `orphan cap of ${ORPHAN_MAX_MS}ms reached with no client`);
  }, remaining);
}

// ---------------------------------------------------------------------------- spawning

/**
 * Starts a CLI process and registers it. `conn` becomes its attached client; any stdin the client
 * already sent while it was parked is replayed first, so nothing is lost.
 */
function spawnFor(conn, hello, forcedKey) {
  const argv = hello.argv;
  const cliArgs = argv.slice(1);
  const key = forcedKey || parseResumeId(cliArgs) || `pending:${++pendingSeq}`;

  let proc;
  try {
    proc = spawn(argv[0], cliArgs, {
      cwd: hello.cwd || process.cwd(),
      env: hello.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  } catch (err) {
    log(`spawn failed for key=${key}: ${err.message}`);
    send(conn.sock, { t: "fatal", msg: `spawn failed: ${err.message}` });
    return null;
  }

  const rec = {
    id: ++recordSeq,
    key,
    proc,
    argv,
    cwd: hello.cwd,
    client: conn,
    buffer: [],
    bufferBytes: 0,
    sawResult: false,
    startedAt: Date.now(),
    exited: false,
    parked: null,
    idleTimer: null,
    orphanTimer: null,
    parkTimer: null,
  };

  // Overwrites any previous registration under this key on purpose: the old record's timers all
  // check isCurrent(), so they become no-ops instead of dropping this one.
  records.set(key, rec);
  conn.rec = rec;
  log(`spawned ${argv[0]} (${cliArgs.length} args)`, rec);
  send(conn.sock, { t: "ready", key, reattached: false });

  const scan = makeLineScanner((line) => onStdoutLine(rec, line));

  proc.stdout.on("data", (chunk) => {
    buffer(rec, "stdout", chunk);
    if (rec.client) send(rec.client.sock, { t: "stdout", d: chunk.toString("base64") });
    scan(chunk.toString("utf8"));
  });

  proc.stderr.on("data", (chunk) => {
    buffer(rec, "stderr", chunk);
    if (rec.client) send(rec.client.sock, { t: "stderr", d: chunk.toString("base64") });
  });

  proc.stdin.on("error", (err) => {
    // The CLI closing stdin first is normal at end of session.
    if (err.code !== "EPIPE") log(`stdin error: ${err.message}`, rec);
  });

  proc.on("error", (err) => {
    log(`process error: ${err.message}`, rec);
    if (rec.client) send(rec.client.sock, { t: "fatal", msg: `process error: ${err.message}` });
  });

  // `close` rather than `exit`: exit can fire while stdout still has buffered data, and losing the
  // tail of an NDJSON stream would truncate the last frames of a turn.
  proc.on("close", (code, signal) => {
    rec.exited = true;
    log(`exited code=${code} signal=${signal} sawResult=${rec.sawResult}`, rec);
    if (rec.client) send(rec.client.sock, { t: "exit", code, signal });

    const parked = takeParked(rec);
    if (parked) {
      log("parked client released by exit; spawning fresh", rec);
      spawnFor(parked.conn, parked.hello, rec.key);
      return;
    }
    if (!rec.client) dropRecord(rec, "exited with no client attached");
  });

  if (conn.stdinQueue.length > 0) {
    log(`replaying ${conn.stdinQueue.length} buffered stdin frame(s)`, rec);
    for (const chunk of conn.stdinQueue) writeStdin(rec, chunk);
    conn.stdinQueue = [];
  }

  return rec;
}

function buffer(rec, stream, chunk) {
  rec.buffer.push({ stream, chunk });
  rec.bufferBytes += chunk.length;
  while (rec.bufferBytes > BUFFER_BYTES && rec.buffer.length > 1) {
    rec.bufferBytes -= rec.buffer.shift().chunk.length;
  }
}

function writeStdin(rec, chunk) {
  if (rec.exited) return;
  try {
    rec.proc.stdin.write(chunk);
  } catch (err) {
    if (err.code !== "EPIPE") log(`stdin write failed: ${err.message}`, rec);
  }
}

function onStdoutLine(rec, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Not every line is ours to understand (--verbose, stray output).
  }
  if (!msg || typeof msg !== "object") return;

  // End of a turn. This is what lets a detached session be reaped promptly instead of sitting on
  // the orphan cap.
  if (msg.type === "result") rec.sawResult = true;

  // A fresh conversation has no --resume id, so the real one only arrives here.
  if (rec.key.startsWith("pending:") && msg.type === "system" && typeof msg.session_id === "string") {
    const next = msg.session_id;
    if (records.has(next)) {
      log(`session_id ${next} already registered; keeping provisional key`, rec);
      return;
    }
    if (records.get(rec.key) === rec) records.delete(rec.key);
    const previous = rec.key;
    rec.key = next;
    records.set(next, rec);
    log(`rekeyed from ${previous}`, rec);
  }
}

// ---------------------------------------------------------------------------- parking

function park(rec, conn, hello) {
  rec.parked = { conn, hello };
  conn.parkedOn = rec;
  log("client parked, waiting for the running turn to finish", rec);

  rec.parkTimer = setTimeout(() => {
    rec.parkTimer = null;
    const parked = takeParked(rec);
    if (!parked) return;
    // The old turn outlasted the extension's own initialize timeout budget. Spawn anyway under a
    // provisional key and leave the old process to finish; both then append to one transcript,
    // which reads as a branch. Untidy but not destructive — see the plan.
    log(`park timed out after ${PARK_MS}ms; spawning alongside the running turn`, rec);
    spawnFor(parked.conn, parked.hello, null);
  }, PARK_MS);
}

function takeParked(rec) {
  const parked = rec.parked;
  if (!parked) return null;
  rec.parked = null;
  if (rec.parkTimer) {
    clearTimeout(rec.parkTimer);
    rec.parkTimer = null;
  }
  parked.conn.parkedOn = null;
  return parked;
}

// ---------------------------------------------------------------------------- client protocol

function onHello(conn, msg) {
  if (conn.rec || conn.parkedOn) {
    send(conn.sock, { t: "fatal", msg: "duplicate hello" });
    return;
  }
  if (!Array.isArray(msg.argv) || msg.argv.length < 1 || typeof msg.argv[0] !== "string") {
    send(conn.sock, { t: "fatal", msg: "invalid hello.argv" });
    return;
  }

  const resumeId = parseResumeId(msg.argv.slice(1));
  const existing = resumeId ? records.get(resumeId) : undefined;

  if (!existing || existing.exited) {
    if (existing) dropRecord(existing, "previous process for this session had exited");
    spawnFor(conn, msg, resumeId);
    return;
  }

  // Collision: this session is already running. Never kill it by default — surviving work is the
  // entire point of the broker.
  if (existing.client) {
    log("collision with a session that still has a client; spawning alongside", existing);
    spawnFor(conn, msg, null);
    return;
  }
  if (existing.parked) {
    log("collision with an already-parked session; spawning alongside", existing);
    spawnFor(conn, msg, null);
    return;
  }
  if (COLLISION === "kill") {
    log("collision: SHIM_BROKER_ON_COLLISION=kill, dropping the running turn", existing);
    existing.parked = { conn, hello: msg };
    conn.parkedOn = existing;
    terminate(existing, "collision with a new client");
    return;
  }
  park(existing, conn, msg);
}

function onStdin(conn, msg) {
  const chunk = Buffer.from(msg.d || "", "base64");
  if (conn.rec) {
    writeStdin(conn.rec, chunk);
    return;
  }
  // Parked (or pre-hello): hold it. Forwarding now would inject the new client's handshake into
  // the turn that is still running.
  conn.stdinQueue.push(chunk);
}

function onConnection(sock) {
  const conn = { sock, rec: null, parkedOn: null, stdinQueue: [] };

  const scan = makeLineScanner((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log(`unparseable client frame: ${err.message}`);
      send(sock, { t: "fatal", msg: "unparseable frame" });
      sock.destroy();
      return;
    }
    try {
      if (msg.t === "hello") onHello(conn, msg);
      else if (msg.t === "stdin") onStdin(conn, msg);
      else if (msg.t === "stdin-end") {
        // Deliberately ignored: a dying extension host closes the client's stdin exactly like a
        // deliberate shutdown does, so honouring this would defeat invariant 2. Completed turns
        // are reaped via sawResult on detach instead.
      }
    } catch (err) {
      log(`error handling ${msg.t}: ${err.stack || err.message}`);
    }
  });

  sock.on("data", (chunk) => {
    try {
      scan(chunk.toString("utf8"));
    } catch (err) {
      log(`error scanning client data: ${err.message}`);
    }
  });

  sock.on("error", (err) => log(`client socket error: ${err.message}`));

  sock.on("close", () => {
    try {
      if (conn.parkedOn) {
        const rec = conn.parkedOn;
        takeParked(rec);
        log("parked client disconnected before its turn finished", rec);
      }
      if (conn.rec) detach(conn.rec);
    } catch (err) {
      log(`error on client close: ${err.stack || err.message}`);
    }
  });
}

/** The moment that matters: the extension is gone, the CLI is not. */
function detach(rec) {
  if (rec.client) rec.client.rec = null;
  rec.client = null;

  if (rec.exited) {
    dropRecord(rec, "client left after the process had exited");
    return;
  }
  if (rec.sawResult) {
    // The turn is complete, so ending stdin is safe and lets the CLI shut down cleanly.
    log("client left after the turn completed; closing stdin", rec);
    try {
      rec.proc.stdin.end();
    } catch {
      // Already closed.
    }
    armIdleTimer(rec);
    return;
  }
  log("client left mid-turn; keeping the process alive", rec);
  armOrphanCap(rec);
}

// ---------------------------------------------------------------------------- lifecycle

function socketIsLive(path) {
  return new Promise((resolve) => {
    const probe = net.createConnection(path);
    const done = (result) => {
      probe.destroy();
      resolve(result);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

async function start() {
  if (fs.existsSync(SOCK)) {
    if (await socketIsLive(SOCK)) {
      log(`another broker is already listening on ${SOCK}; exiting`);
      process.exit(0);
    }
    fs.unlinkSync(SOCK);
    log(`removed stale socket ${SOCK}`);
  }

  const server = net.createServer(onConnection);
  server.on("error", (err) => {
    log(`server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(SOCK, () => {
    fs.chmod(SOCK, 0o600, () => {});
    log(
      `listening on ${SOCK} (collision=${COLLISION} park=${PARK_MS}ms ` +
        `idle=${IDLE_KEEP_MS}ms orphanCap=${ORPHAN_MAX_MS}ms buffer=${BUFFER_BYTES}B)`,
    );
  });

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Children are left running, but their pipes terminate here, so they will hit EPIPE. The
    // restart loop in entrypoint-wrapper.sh covers crashes; it cannot save a turn in flight.
    log(`${signal} received; closing the socket and leaving ${records.size} child(ren) running`);
    server.close(() => {
      try {
        fs.unlinkSync(SOCK);
      } catch {
        // Already gone.
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  log(`failed to start: ${err.stack || err.message}`);
  process.exit(1);
});
