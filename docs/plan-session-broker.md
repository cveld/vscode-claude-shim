# Plan: session broker — keep a running turn alive across extension-host restarts

Status: **step 1 built and verified in a live container** (see [Verification](#verification) for what
was actually measured). Not yet validated after an image rebuild + fresh launch. Step 2 (live
reattach) is designed but not built. See [docs/re/session-broker.md](re/session-broker.md) for the
reverse-engineering this rests on.

## Problem

Closing the browser tab and reopening it destroys whatever the Claude extension was doing. The
[keep-alive patch](re/exthost-keepalive.md) already prevents the *immediate* teardown, but a
reopened tab always gets a fresh extension host and the kept-alive one is reaped, so an in-flight
turn dies either way. Everything that was already written to
`~/.claude/projects/<slug>/*.jsonl` comes back via resume; the work in flight does not.

## Approach

Not a proxy extension — that cannot work, and [the RE doc explains why](re/session-broker.md#why-run-the-real-extension-out-of-process-and-proxy-to-it-cannot-work).
Instead, move the process that carries the turn out of the extension host's family tree:

```
exthost (disposable) → wrapper (disposable) → broker daemon (survives) → claude CLI (survives)
```

The extension is **unmodified**. It launches the CLI through
`claudeCode.claudeProcessWrapper`, a setting it already supports.

## Components

| File | Role |
| --- | --- |
| `container-assets/claude-broker/wrapper.sh` | What the extension spawns. Dispatches: side calls pass straight through, stream-json queries go to the client. |
| `container-assets/claude-broker/client.mjs` | Bridges the extension's three pipes to the broker over a unix socket. |
| `container-assets/claude-broker/broker.mjs` | Long-lived daemon. Owns CLI processes, drains and buffers their output, holds their stdin open. |

**Why a shell script in front:** only stream-json queries need brokering. `claude auth status
--json` and friends also come through the wrapper and must stay cheap and synchronous, so the shell
dispatches those with a real `exec "$@"` and pays no Node startup cost. Node cannot `exec`, hence
the split.

### Wire protocol (wrapper client ↔ broker)

JSON lines both ways, payloads base64 so no encoding or newline concern leaks in.

- client → broker: `{t:"hello", argv, cwd, env}` · `{t:"stdin", d}` · `{t:"stdin-end"}`
- broker → client: `{t:"ready", key, reattached}` · `{t:"stdout", d}` · `{t:"stderr", d}` ·
  `{t:"exit", code, signal}` · `{t:"fatal", msg}`

### Session keys

`--resume=<id>` from the argv when present. A fresh conversation has no id yet, so the broker keys
it provisionally and rekeys when the `session_id` shows up in the `system/init` frame on stdout.

### The two invariants that make survival work

1. **Always drain stdout.** With no client attached, an undrained pipe fills at 64KB and the CLI
   blocks mid-turn — the exact failure this feature exists to prevent. The broker buffers into a
   bounded ring (`SHIM_BROKER_BUFFER_BYTES`, default 8MB).
2. **Never close stdin while the process should live.** The CLI exits on stdin EOF; that is *how*
   it dies with the extension host today.

Children are spawned `detached: true` so they get their own process group and session, out of reach
of any signal aimed at code-server's group.

## Step 1 — survival (this build)

Scope: the turn finishes. The reopened UI still starts fresh and picks the result up from the
transcript on disk. No reattach to a live stream.

Lifecycle rules:

- No client attached and a `{"type":"result"}` frame seen → turn is done: close stdin, let the CLI
  exit, keep the buffer for `SHIM_BROKER_IDLE_KEEP_MS` (default 10min), then drop the record.
- No client attached and no result → keep running, capped by `SHIM_BROKER_ORPHAN_MAX_MS`
  (default 30min) so nothing leaks forever.

### The collision case, and why it is bounded to ~45s

Reopening *the same* session while its old process is still running is the one genuinely awkward
case. The old process must not be killed — that is the whole point — but two CLIs resuming one
session id would both append to the same transcript.

The extension's own handshake sets the budget: the bundled SDK uses
`Que({options, initializeTimeoutMs = 60000})`, so a client that receives nothing for a minute gives
up. Step 1 therefore parks the new client for at most `SHIM_BROKER_PARK_MS` (default 45000, safely
inside that window):

- Old process finishes inside the park window → close its stdin, wait for exit, then spawn a fresh
  CLI for the parked client. The user waits a moment and sees the completed conversation.
- It does not finish in time → spawn a fresh CLI for the new client anyway, with the same
  `--resume`, and log a warning. Both processes then append to one transcript. JSONL records carry
  `parentUuid`, so this reads as a branch rather than corruption, but it is untidy — hence step 2.

`SHIM_BROKER_ON_COLLISION=kill` restores stock behaviour (drop the old process) as an escape hatch.

### Rollout: opt-in first

Wired in but **off by default**, enabled with `SHIM_SESSION_BROKER=1`. A broken broker would break
all Claude usage in the container, and the setting itself has a
[behavioural side effect](re/session-broker.md#side-effect-to-keep-in-mind)
(`resolvePermissionModeInCli` flips to the extension). Flip the default once it has run for a while.

When enabled, `sync-user-settings.mjs` adds `claudeCode.claudeProcessWrapper`, and
`entrypoint-wrapper.sh` starts the broker under a restart loop before handing off to code-server.

**Single point of failure, accepted for now:** the CLI's pipes terminate in the broker, so if the
broker dies its children hit EPIPE and go down with it. The restart loop covers crashes; it does
not make a running turn survive one.

If the broker cannot be reached at all, `client.mjs` falls back to spawning the CLI directly, so a
dead broker degrades to stock behaviour instead of blocking the user.

## Step 2 — live reattach (not in this build)

Replace parking with a real attach: a reopened tab watches the running turn continue. This is the
remaining hard part, and it is protocol work, not plumbing:

- The control channel carries request/response ids. A fresh client sends its own `initialize`; the
  broker has to answer it and synthesise a `system/init` for a CLI that is already mid-turn.
- Replay the buffer so the webview rebuilds the transcript, then splice into the live stream
  without duplicating or dropping frames. `--replay-user-messages` helps here.
- Permission prompts raised while nobody was attached must be parked and re-offered. They travel
  in band (`--permission-prompt-tool stdio`), so no extra channel is needed.
- The IDE side connection is lost across the gap: the extension deletes its
  `~/.claude/ide/<port>.lock` on dispose and the new host listens on a new port, so the surviving
  CLI cannot reach `openFile`/`openDiff` until it reconnects. See
  [ide-protocol.md](re/ide-protocol.md). Probably tolerable — those tools simply fail during the
  gap — but it needs a decision.

`--fork-session` ("When resuming, create a new session ID") is the fallback if attach proves
unworkable: the reopened tab forks the transcript instead of sharing it. It trades a confusing
split across two session files for the absence of any write conflict.

## Wiring

| Where | What |
| --- | --- |
| `Dockerfile` | Bakes the three files into `/usr/local/bin/` (`claude-broker.mjs`, `claude-broker-client.mjs`, `claude-wrapper.sh`) plus the probe as `claude-broker-probe.mjs`. |
| `entrypoint-wrapper.sh` | With `SHIM_SESSION_BROKER=1`, starts the daemon under a restart loop before code-server. |
| `sync-user-settings.mjs` | With the flag set, points `claudeCode.claudeProcessWrapper` at the wrapper — and *removes* it again when the flag is off, since the settings file lives in a persistent volume. Only removes its own path, never a hand-set one. |
| `mini-launcher/lib/docker.ts` | `instanceEnv()` passes `SHIM_SESSION_BROKER=1` into containers it creates, when the launcher process itself has it set. Docker env is fixed at create time, so an existing instance must be removed and relaunched to pick it up. |

## Verification

Three checks, because driving the chat webview from Playwright is unreliable and the claim deserves
better than one path.

**1. Broker mechanics and a real turn, no browser involved.**
[`container-assets/claude-broker/_probe-survival.mjs`](../container-assets/claude-broker/_probe-survival.mjs)
speaks the wire protocol directly and drops the connection mid-stream. Both phases passed:

- phase A (fake NDJSON producer): child still running after the client vanished, turn ran to
  completion with nobody attached, `result` frame detected, record reaped.
- phase B (real `claude -p`): the CLI kept running after the client was dropped 4s in, the turn
  completed detached, the transcript grew from 276537 to 291652 bytes, and the provisional key was
  rekeyed to the real session id from the `system/init` frame.

**2. The real extension, through the whole chain.** With the broker running and the setting pointed
at the wrapper, a session was resumed via the
[session-open bridge](re/mini-launcher/session-open-bridge.md). `ps` showed the ancestry inverted,
which is the entire point:

```text
5467      56  … bootstrap-fork --type=extensionHost …
5532    5467  node /usr/local/bin/claude-broker-client.mjs …/native-binary/claude --output-format stream-json …
5543    4948  …/native-binary/claude --output-format stream-json …      # 4948 = the broker
```

The CLI is a child of the broker, not of the extension host. The startup `auth status --json` call
correctly bypassed the broker entirely (no `--input-format`, so `wrapper.sh` exec'd it straight
through).

**3. Killing the extension host.** `kill 5467` — the CLI (5543) stayed alive under the broker, and
the broker logged `client left mid-turn; keeping the process alive`. That is the feature.

### Bug this surfaced

The first run of check 3 left the *client* behind as a zombie reparented to init. An idle session
produces no output, so there is no write to fail with EPIPE, and stdin reaching EOF is not proof the
parent is gone — the extension host closes the client's stdin when it dies exactly as a deliberate
shutdown would. That mattered beyond one stray process: while its socket stayed open the broker
still counted a client as attached, so it would never detach the session, never close the CLI's
stdin after a completed turn, and never reap the record. `client.mjs` now watches for `process.ppid`
changing and disconnects when it does.

**4. Image rebuild and a fresh launch.** `docker build` plus `docker run -e SHIM_SESSION_BROKER=1`:
the entrypoint started the broker, `sync-user-settings` logged
`applied: claudeCode.claudeProcessWrapper`, the socket appeared at `/tmp/claude-broker.sock`, and the
baked-in probe passed phase A from `/usr/local/bin/claude-broker-probe.mjs`. Re-running the sync with
the flag cleared logged `-claudeCode.claudeProcessWrapper` and removed the key, while a hand-set
wrapper path was left untouched.

### Still to validate

An end-to-end run driven from the mini-launcher UI: launch an instance with the launcher process
carrying `SHIM_SESSION_BROKER=1`, start a long turn in the chat panel, close the tab mid-turn, then
reopen and confirm the finished result is there. Checks 1–4 cover every mechanism this depends on,
but not the click path.

## Known trade-off: detached idle sessions linger

On detach without a completed turn, the broker keeps the process alive until the orphan cap
(`SHIM_BROKER_ORPHAN_MAX_MS`, 30min). A session that was resumed but never ran a turn therefore
lingers just as long as one that is genuinely working, so closing several windows leaves several idle
CLI processes behind.

Reaping on "no output for a while" was considered and rejected: with partial messages off, a
legitimately working turn can be silent for minutes, and the reap would destroy exactly the work this
feature exists to protect. Lower `SHIM_BROKER_ORPHAN_MAX_MS` if the idle processes are a problem.
Step 2's protocol awareness is what makes idle-versus-working distinguishable for real.

## Known nit, not fixed here

`extensions.autoUpdate` is compared against the boolean `false` in `sync-user-settings.mjs`, but VS
Code migrates it to the string `"off"`, so the key is rewritten every boot. Harmless churn; noted
in [the RE doc](re/session-broker.md#noted-while-testing-unrelated).
