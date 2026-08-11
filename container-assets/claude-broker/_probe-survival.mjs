// Probe: does a CLI process survive its client disappearing mid-stream?
//
// This is the broker's central claim, tested without a browser in the loop, because driving the
// Claude chat webview from Playwright is unreliable. It speaks the wire protocol directly, drops the
// connection mid-turn, and then checks that the process is still running and still producing.
//
// Runs *inside* the container (baked in by the Dockerfile):
//   docker exec -e SHIM_BROKER_SOCK=/tmp/probe-broker.sock <container> \
//       node /usr/local/bin/claude-broker-probe.mjs
//
// Phase A exercises the mechanics with a fake NDJSON producer (no API calls). Phase B repeats it
// against the real CLI, which costs one trivial turn; skip it with PROBE_SKIP_REAL=1.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const SOCK = process.env.SHIM_BROKER_SOCK || "/tmp/probe-broker.sock";
const BROKER = process.env.PROBE_BROKER || "/usr/local/bin/claude-broker.mjs";
const CLAUDE = process.env.PROBE_CLAUDE || "/usr/bin/claude";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const say = (msg) => console.log(`[probe ${stamp()}] ${msg}`);

const failures = [];
function check(ok, label) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
}

// ---------------------------------------------------------------------------- broker under test

const brokerLog = [];

function startBroker() {
  try {
    fs.unlinkSync(SOCK);
  } catch {
    // Not there.
  }
  const proc = spawn("node", [BROKER], {
    env: { ...process.env, SHIM_BROKER_SOCK: SOCK, SHIM_BROKER_IDLE_KEEP_MS: "4000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  proc.stdout.on("data", (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        brokerLog.push(line);
        console.log(`    | ${line}`);
      }
    }
  });
  proc.stderr.on("data", (c) => console.log(`    ! ${c.toString().trim()}`));
  return proc;
}

async function waitForLog(pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = brokerLog.find((l) => pattern.test(l));
    if (hit) return hit;
    await sleep(200);
  }
  return null;
}

// ---------------------------------------------------------------------------- protocol client

/** A minimal wrapper-client: sends hello, collects frames, can be dropped on command. */
function connectClient(argv, cwd = "/home/coder/project") {
  const state = { frames: [], stdout: "", closed: false, sock: null };
  const sock = net.createConnection(SOCK);
  state.sock = sock;
  let buf = "";
  sock.on("connect", () => {
    sock.write(JSON.stringify({ t: "hello", argv, cwd, env: process.env }) + "\n");
  });
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      state.frames.push(msg);
      if (msg.t === "stdout") state.stdout += Buffer.from(msg.d, "base64").toString();
    }
  });
  sock.on("close", () => {
    state.closed = true;
  });
  sock.on("error", (e) => say(`client socket error: ${e.code || e.message}`));
  return state;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnedPid() {
  const line = [...brokerLog].reverse().find((l) => l.includes("spawned "));
  const m = line && line.match(/pid=(\d+)/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------- phase A

async function phaseA() {
  say("phase A: mechanics with a fake NDJSON producer (no API calls)");
  // Emits a frame a second for 20s, then a `result` frame — long enough to drop the client
  // mid-stream, and it never reads stdin, so only the broker's own handling is under test.
  const script =
    'i=0; while [ $i -lt 20 ]; do i=$((i+1)); echo "{\\"type\\":\\"tick\\",\\"i\\":$i}"; sleep 1; done; ' +
    'echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\"}"';
  const client = connectClient(["/bin/sh", "-c", script]);

  await sleep(3500);
  const pid = spawnedPid();
  check(pid !== null, "broker logged a spawned child");
  check(client.frames.some((f) => f.t === "ready"), "client received ready");
  const ticksBefore = (client.stdout.match(/"tick"/g) || []).length;
  check(ticksBefore >= 2, `client relayed frames before the drop (got ${ticksBefore})`);

  say("dropping the client mid-stream, as a dying extension host would");
  client.sock.destroy();
  await sleep(3000);

  check(pidAlive(pid), "child is still running after the client vanished");

  say("waiting for the turn to complete with nobody attached");
  const exitLine = await waitForLog(/exited code=0 .*sawResult=true/, 30000);
  check(!!exitLine, "turn ran to completion and the result frame was detected");
  check(!pidAlive(pid), "child exited on its own once done");

  const reaped = await waitForLog(/record dropped/, 8000);
  check(!!reaped, "record was reaped after completion");
}

// ---------------------------------------------------------------------------- phase B

async function phaseB() {
  say("phase B: the real CLI (one trivial turn)");
  const before = countTranscripts();
  const client = connectClient([
    CLAUDE,
    "-p",
    "Reply with exactly the five words: broker survival probe is fine",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);

  await sleep(4000);
  const pid = spawnedPid();
  check(pid !== null, "broker spawned the real CLI");

  say("dropping the client mid-turn");
  client.sock.destroy();
  await sleep(2000);
  check(pidAlive(pid), "CLI is still running after the client vanished");

  const exitLine = await waitForLog(/exited code=0 .*sawResult=true/, 120000);
  check(!!exitLine, "the real turn completed with no client attached");

  const after = countTranscripts();
  check(after > before, `a transcript was written while detached (${before} -> ${after})`);
}

function countTranscripts() {
  const dir = "/home/coder/.claude/projects/-home-coder-project";
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .reduce((total, f) => total + fs.statSync(path.join(dir, f)).size, 0);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------- run

const broker = startBroker();
await sleep(700);

try {
  await phaseA();
  brokerLog.length = 0;
  if (process.env.PROBE_SKIP_REAL === "1") say("phase B skipped (PROBE_SKIP_REAL=1)");
  else await phaseB();
} finally {
  broker.kill("SIGTERM");
  await sleep(400);
}

console.log("");
if (failures.length === 0) {
  say("all checks passed");
  process.exit(0);
}
say(`${failures.length} check(s) failed:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
