async function getBrowserDebuggingURL(): Promise<string> {
  try {
    const response = await fetch("http://127.0.0.1:9222/json/version", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      webSocketDebuggerUrl?: unknown;
    };
    if (typeof data.webSocketDebuggerUrl !== "string") {
      throw new Error("webSocketDebuggerUrl is missing");
    }

    return data.webSocketDebuggerUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to get browser debugging URL: ${message}`);
    throw new Error("Failed to get browser debugging URL");
  }
}

export { getBrowserDebuggingURL };
