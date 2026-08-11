import { activateShim } from "@/simulator-lib/extensionHostShim";
import type { ActivationResult, ShimState } from "@/simulator-lib/extensionHostShim";

// A persistent, activated shim: the real extension is loaded and its webview views are
// resolved exactly once, then kept alive so a browser can drive the real webview↔host
// message pipeline (webview→host via `dispatchToView`, host→webview via `subscribe`).
//
// This differs from `getShimSummary`, which activates a fresh throwaway shim on every call.
// Step 3 of the build plan needs a single long-lived instance whose `viewDispatchers` and
// resolved `onDidReceiveMessage` listeners stay registered for the lifetime of the browser
// connection.

// One outbound host→webview message, tagged with the view it belongs to.
export type OutboundEntry = {
  seq: number;
  viewId: string;
  message: unknown;
};

type OutboundListener = (entry: OutboundEntry) => void;

export type ShimSession = {
  activation: ActivationResult;
  // Deliver a raw webview→host message into the extension's onDidReceiveMessage listeners
  // for the given view (matches the real contract: no wrapper envelope). Returns false when
  // the view id is unknown.
  dispatchToView(viewId: string, message: unknown): boolean;
  // Subscribe to host→webview messages. The listener is first replayed the full backlog of
  // messages emitted before it connected (so the browser never misses the extension's initial
  // `session_states_update` posted during resolve), then receives new messages live. Returns
  // an unsubscribe function.
  subscribe(listener: OutboundListener): () => void;
  // View ids that were resolved during activation (i.e. have a live dispatcher).
  viewIds(): string[];
  // The host-produced HTML the extension set for a resolved view, if any.
  htmlForView(viewId: string): string | null;
  // Number of outbound messages buffered so far (useful for diagnostics/verification).
  outboundCount(): number;
  // Tail of the shim's in-memory log (diagnostics/verification).
  recentLogs(limit?: number): Array<{ level: string; scope: string; message: string }>;
};

type ShimSessionInternal = ShimSession & {
  state: ShimState;
};

let sessionPromise: Promise<ShimSessionInternal> | null = null;
// How many times the extension has actually been activated in this process. Persistence is
// proven when repeated getShimSession() calls leave this at 1.
let activationCount = 0;

export function getActivationCount(): number {
  return activationCount;
}

async function createSession(): Promise<ShimSessionInternal> {
  activationCount += 1;
  const activation = await activateShim({ driveInit: false });
  const state = activation.state;

  const listeners = new Set<OutboundListener>();
  let nextSeq = 1;
  let liveCount = 0;

  // The one-time backlog is ONLY the resolve-phase messages the extension posted before any
  // browser connected (e.g. the initial `session_states_update`). Each new subscriber replays
  // just this, never the accumulating live history — replaying stale init_responses from prior
  // page loads confuses the bundle's requestId correlation and leaves it stuck "loading".
  const initialBacklog: OutboundEntry[] = [];
  for (const view of state.resolvedViews) {
    for (const message of view.outboundMessages) {
      initialBacklog.push({ seq: nextSeq++, viewId: view.id, message });
    }
  }

  // Live messages go only to currently-connected subscribers; they are not buffered for replay.
  const emit = (viewId: string, message: unknown) => {
    liveCount += 1;
    const entry: OutboundEntry = { seq: nextSeq++, viewId, message };
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // A failing browser listener must not break the extension's send path.
      }
    }
  };
  state.onOutbound = emit;

  return {
    activation,
    state,
    dispatchToView(viewId, message) {
      const dispatch = state.viewDispatchers.get(viewId);
      if (!dispatch) {
        return false;
      }
      dispatch(message);
      return true;
    },
    subscribe(listener) {
      for (const entry of initialBacklog) {
        try {
          listener(entry);
        } catch {
          // ignore replay errors from a single listener
        }
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    viewIds() {
      return [...state.viewDispatchers.keys()];
    },
    htmlForView(viewId) {
      const view = state.resolvedViews.find((candidate) => candidate.id === viewId);
      return view && view.html ? view.html : null;
    },
    outboundCount() {
      return initialBacklog.length + liveCount;
    },
    recentLogs(limit = 40) {
      return state.logs.slice(-limit).map((entry) => ({ level: entry.level, scope: entry.scope, message: entry.message }));
    },
  };
}

// Return the shared persistent session, activating the extension on first use. Concurrent
// callers share the same in-flight activation promise.
export function getShimSession(): Promise<ShimSession> {
  if (!sessionPromise) {
    sessionPromise = createSession();
  }
  return sessionPromise;
}

// Drop the current session so the next getShimSession() re-activates from scratch. Used when
// the extension updates or a caller wants a clean handshake.
export function resetShimSession(): void {
  sessionPromise = null;
}
