# RE: how the Claude Code extension and CLI detect each other

Findings from reading the installed VS Code extension's `extension.js` (minified, but not
obfuscated) and running `strings` over the `claude` CLI's compiled binary
(`/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` — a Bun-compiled executable;
`strings -a` recovers most of the bundled source as text, just without structure).

## Extension side: lock file + local WebSocket/MCP server

On activation (`onStartupFinished`), the extension:

1. Picks a free localhost port (tries up to 50 times, `127.0.0.1` only).
2. Starts an MCP server on that port, transport `ws`.
3. Writes a lock file to `<lockDir>/<port>.lock` (function named `Xq` in the minified bundle)
   containing:
   ```json
   {
     "pid": "<parent process pid>",
     "workspaceFolders": ["<paths>"],
     "ideName": "<vscode.env.appName, e.g. 'code-server'>",
     "transport": "ws",
     "runningInWindows": true,
     "authToken": "<randomUUID>"
   }
   ```
4. Sets `CLAUDE_CODE_SSE_PORT=<port>` in the terminal environment it controls
   (`environmentVariableCollection`).
5. On `workspace.onDidChangeWorkspaceFolders`, rewrites the lock file with the new folders.
6. On dispose, deletes the lock file.

The WebSocket server requires header `x-claude-code-ide-authorization: <authToken>` matching
the UUID from the lock file; otherwise it closes with code `1008` (Unauthorized).

## CLI side: scanning for the lock file

The CLI's IDE-lockfile directory list (function `O0p` in the strings dump) is built as:

- `<claudeConfigDir>/ide` (i.e. `~/.claude/ide` by default, or `$CLAUDE_CONFIG_DIR/ide`)
- if running under WSL: also `~/.claude/ide` translated to the Windows-side path, plus a scan
  of `/mnt/c/Users/*/​.claude/ide` (skipping `Public`/`Default*`/`All Users`)

For each lock file found, the CLI validates it's still live: if the recorded `pid` is no
longer running (and not WSL), or a TCP connect to the port fails, the lock file is treated as
stale and deleted.

This confirms: **the lock-file directory is `~/.claude/ide/`**, written by the extension, read
by the CLI. If `~/.claude` isn't writable by the process running the extension, IDE detection
silently breaks — see
[troubleshooting.md](../troubleshooting.md#claude-directory-not-writable).

## CLI side: IDE-name → binary detection (for `autoConnectIde`, process scanning)

Separately from the lock file, the CLI has a table mapping known IDE identifiers to launcher
binaries, used for **process detection** (`ps aux | grep -E "Visual Studio Code|..."` on
macOS/Linux, `tasklist` on Windows) — this feeds the "Auto-connect to IDE (external terminal)"
setting (`autoConnectIde`), which is a different feature from the lock-file protocol above.
Recognized names include vscode, vscodium, cursor, windsurf, devin-desktop. **`code-server` is
not in this table** — cosmetic only (affects the external-terminal auto-connect heuristic, not
the lock-file mechanism this project relies on).

## CLI side: `autoInstallIdeExtension`

Settings key `autoInstallIdeExtension` ("Auto-install IDE extension", a sibling of
`autoConnectIde` in the CLI's settings object). When enabled (the default) and the CLI detects
it's running inside a supported IDE terminal, it shells out to `code --list-extensions` /
`code --force --install-extension anthropic.claude-code` to keep the companion extension
current. Under code-server there is no `code` binary (only `code-server`), so the spawn fails
— see [troubleshooting.md](../troubleshooting.md#code---force---install-extension-anthropicclaude-code-crashes-after-login).
No env var was found to disable this specifically; the settings.json key is the way.

## Not related: `officialMarketplaceAutoInstall*`

`~/.claude.json` persists `officialMarketplaceAutoInstallAttempted/Failed/RetryCount/...` —
initially suspected to be about the VS Code extension install, but strings context
(`plugin_official_marketplace_fetch`, `git_unavailable`, `gcs_unavailable`,
`xcrun: error: ... treating as git_unavailable`) shows this is the **plugin marketplace**
auto-install (fetched via git or GCS), unrelated to the IDE extension.
