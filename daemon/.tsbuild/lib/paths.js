// Pure path-validation/translation logic for the launcher daemon (see
// docs/plan-launcher-daemon.md, decisions 5-7). No filesystem or Docker access here — this
// module only turns host paths into root-relative/container paths and back, so it can be unit
// tested without a real filesystem. Callers (the HTTP layer) do their own fs.stat calls.
import path from 'node:path';
// Explorer/PowerShell "copy as path" wraps the value in double quotes; strip them before
// treating the value as a path.
export function stripQuotes(raw) {
    const trimmed = raw.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
// Normalizes a raw, possibly relative, possibly forward-slashed path into an absolute
// Windows path with no trailing separator, resolving any `..` segments so a path can't be
// used to escape a root by construction (e.g. `C:\work\..\Windows`).
export function toAbsoluteHostPath(raw) {
    const stripped = stripQuotes(raw);
    const resolved = path.win32.resolve(stripped);
    return trimTrailingSep(resolved);
}
function trimTrailingSep(p) {
    return p.length > 3 && p.endsWith(path.win32.sep) ? p.slice(0, -1) : p;
}
// Case-insensitive compare, matching Windows filesystem semantics.
function samePath(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}
// Finds the root that contains `absHostPath`, if any. Matching is boundary-aware: a root
// `C:\work\git\github\cveld` must not match `C:\work\git\github\cveldX`.
// Returns `{ root, relativePath }` (relativePath uses forward slashes, no leading slash) or
// `null` if the path falls outside every configured root — callers must fail closed on null.
export function resolveRoot(roots, absHostPath) {
    for (const root of roots) {
        const rootPath = trimTrailingSep(path.win32.resolve(root.hostPath));
        if (samePath(absHostPath, rootPath)) {
            return { root, relativePath: '' };
        }
        const prefix = rootPath + path.win32.sep;
        if (absHostPath.toLowerCase().startsWith(prefix.toLowerCase())) {
            const relative = absHostPath.slice(prefix.length);
            return { root, relativePath: relative.split(path.win32.sep).join('/') };
        }
    }
    return null;
}
// Joins a root's container path with a root-relative path (forward slashes).
export function toContainerPath(root, relativePath) {
    if (!relativePath)
        return root.containerPath;
    return `${root.containerPath}/${relativePath}`;
}
// Joins a root's host path with a root-relative path (forward slashes) into an absolute
// Windows path — the inverse of `resolveRoot`. Used when a caller already has `rootId` +
// `relativePath` (e.g. from `GET /api/browse`) instead of a raw pasted path.
export function toHostPath(root, relativePath) {
    if (!relativePath)
        return trimTrailingSep(path.win32.resolve(root.hostPath));
    return path.win32.join(root.hostPath, ...relativePath.split('/'));
}
// `.code-workspace` files are the only thing distinguished from a plain folder by name alone;
// actual existence/type on disk is the caller's job (fs.stat), not this pure module's.
export function classifyByExtension(absHostPath) {
    return absHostPath.toLowerCase().endsWith('.code-workspace') ? 'workspace' : 'folder';
}
// Full pipeline for `GET /api/resolve`: raw pasted input -> validated, root-relative result.
// Returns `null` (fail closed) if the path is outside every configured root.
export function resolveHostPath(roots, raw) {
    const absHostPath = toAbsoluteHostPath(raw);
    const match = resolveRoot(roots, absHostPath);
    if (!match)
        return null;
    const { root, relativePath } = match;
    return {
        rootId: root.id,
        relativePath,
        hostPath: absHostPath,
        containerPath: toContainerPath(root, relativePath),
        type: classifyByExtension(absHostPath),
    };
}
