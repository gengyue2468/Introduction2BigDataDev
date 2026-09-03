/**
 * Track network activity from before navigation and wait for a bounded quiet
 * window. Long-lived connections such as WebSockets and EventSource are
 * intentionally ignored.
 */
export interface NetworkIdleTracker {
  wait(idleTime?: number, maxWait?: number): Promise<void>;
  close(): void;
}

export async function startNetworkIdleTracking(
  view: Bun.WebView,
  networkAlreadyEnabled = false,
): Promise<NetworkIdleTracker> {
  if (!networkAlreadyEnabled) await view.cdp("Network.enable");

  const inFlight = new Set<string>();
  const ignoredTypes = new Set(["WebSocket", "EventSource"]);
  const activeWaitCleanups = new Set<() => void>();

  const onStart = (event: Event) => {
    const data = ((event as MessageEvent).data ?? {}) as {
      requestId?: string;
      type?: string;
    };

    if (!data.requestId || ignoredTypes.has(data.type ?? "")) return;
    inFlight.add(data.requestId);
  };

  const onEnd = (event: Event) => {
    const data = ((event as MessageEvent).data ?? {}) as { requestId?: string };
    if (data.requestId) inFlight.delete(data.requestId);
  };

  view.addEventListener("Network.requestWillBeSent", onStart);
  view.addEventListener("Network.loadingFinished", onEnd);
  view.addEventListener("Network.loadingFailed", onEnd);

  return {
    wait(idleTime = 500, maxWait = 10000) {
      return new Promise<void>((resolve) => {
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let fallback: ReturnType<typeof setTimeout> | null = null;
        let settled = false;

        const cleanupWait = () => {
          view.removeEventListener("Network.requestWillBeSent", onActivity);
          view.removeEventListener("Network.loadingFinished", armIdleTimer);
          view.removeEventListener("Network.loadingFailed", armIdleTimer);
          if (idleTimer) clearTimeout(idleTimer);
          if (fallback) clearTimeout(fallback);
          activeWaitCleanups.delete(cleanupWait);
        };

        const settle = () => {
          if (settled) return;
          settled = true;
          cleanupWait();
          resolve();
        };

        const armIdleTimer = () => {
          if (idleTimer || settled || inFlight.size > 0) return;
          idleTimer = setTimeout(settle, Math.max(0, idleTime));
        };

        const onActivity = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        };

        activeWaitCleanups.add(cleanupWait);
        view.addEventListener("Network.requestWillBeSent", onActivity);
        view.addEventListener("Network.loadingFinished", armIdleTimer);
        view.addEventListener("Network.loadingFailed", armIdleTimer);
        armIdleTimer();

        if (Number.isFinite(maxWait) && maxWait > 0) {
          fallback = setTimeout(settle, maxWait);
        }
      });
    },
    close() {
      for (const cleanup of activeWaitCleanups) cleanup();
      view.removeEventListener("Network.requestWillBeSent", onStart);
      view.removeEventListener("Network.loadingFinished", onEnd);
      view.removeEventListener("Network.loadingFailed", onEnd);
    },
  };
}

export async function waitForNetworkIdle(
  view: Bun.WebView,
  idleTime = 500,
  maxWait = 10000,
  networkAlreadyEnabled = false,
): Promise<void> {
  const tracker = await startNetworkIdleTracking(view, networkAlreadyEnabled);
  try {
    await tracker.wait(idleTime, maxWait);
  } finally {
    tracker.close();
  }
}
