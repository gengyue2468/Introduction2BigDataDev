import { Hono, MiddlewareHandler } from "hono";
import {
  isSafeNavigationURL,
  isValidURL,
  normalizeInputURL,
} from "./lib/valid";
import { getBrowserDebuggingURL } from "./lib/browser";
import { htmlParser } from "./lib/parser";
import {
  startNetworkIdleTracking,
  type NetworkIdleTracker,
} from "./lib/network-idle";

import { pluginRegistry, type BrowserProfile } from "./plugins";

const authMiddleware: MiddlewareHandler = async (c, next) => {
  const authorization = c.req.header("Authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (!Bun.env.ACCESS_TOKEN || bearerToken !== Bun.env.ACCESS_TOKEN) {
    return c.json({ error: "咦，你是谁啊？" }, 401);
  }
  await next();
};

const app = new Hono();

const method = {
  allowGet: Bun.env.ALLOW_GET === "true",
  allowPost: Bun.env.ALLOW_POST === "true",
};

const DEFAULT_CHALLENGE_WAIT_MS = 300_000;
const CHALLENGE_POLL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 480_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;
const NETWORK_IDLE_MAX_WAIT_MS = 5_000;
const MAX_CONCURRENT_READS = Math.max(
  1,
  Math.min(16, Number(Bun.env.MAX_CONCURRENT_READS) || 2),
);

let activeReads = 0;

function tryAcquireReadSlot() {
  if (activeReads >= MAX_CONCURRENT_READS) return null;
  activeReads++;
  return () => {
    activeReads = Math.max(0, activeReads - 1);
  };
}

const CHALLENGE_TITLE_PATTERN = /^(?:just a moment|checking your browser|verifying you are human|verify you are human|security check|browser verification|human verification|access verification|one more step|making sure you're not a bot|are you a human|checking your connection|performing security verification|proving you're not a robot|humanity check in progress|checking for signs of life|请稍候|正在检查您的浏览器|正在验证您是否为真人|真人验证|安全检查|浏览器验证|访问验证|还差一步|正在确认您不是机器人|您是真人吗)(?:\.{1,3}|[!。…])?$/i;
const CHALLENGE_BODY_PATTERN = /(?:checking your browser|verify you are human|security verification|prove you are human|enable javascript and cookies|正在验证您|正在进行安全检查|请完成安全验证)/i;

interface ChallengeState {
  title: string;
  url: string;
  text: string;
  readyState: string;
}

interface ReadDiagnostics {
  startedAt: number;
  responseStatus?: number;
  responseURL?: string;
  challengeDetectedAt?: number;
  challengeCompletedAt?: number;
}

class OperationTimeoutError extends Error {
  status = 504;
}

function getErrorStatusCode(error: unknown) {
  if (typeof error !== "object" || error === null) return 500;

  const status = Reflect.get(error, "status");
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return status;
  }

  const statusCode = Reflect.get(error, "statusCode");
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
    return statusCode;
  }

  return 500;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeout: number,
  label: string,
  onTimeout?: () => void,
) {
  if (!Number.isFinite(timeout) || timeout <= 0) return promise;
  let id: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    id = setTimeout(
      () => {
        reject(new OperationTimeoutError(`${label} failed after ${timeout}ms`));
        onTimeout?.();
      },
      timeout,
    );
  });
  try {
    return await Promise.race([promise, t]);
  } finally {
    if (id) clearTimeout(id);
  }
}

function parseQueryNumber(
  c: any,
  name: string,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number | null {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    return null;
  }

  return value;
}

function remainingTime(deadlineAt: number, requestedMs: number, label: string) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new OperationTimeoutError(`request deadline exceeded during ${label}`);
  }
  return Math.min(requestedMs, remaining);
}

function getCurrentURL(view: Bun.WebView, fallback: string) {
  try {
    return view.url || fallback;
  } catch {
    return fallback;
  }
}

async function applyBrowserProfile(
  view: Bun.WebView,
  profile: BrowserProfile,
) {
  const userAgentParams: Record<string, unknown> = {
    userAgent: profile.userAgent,
  };
  if (profile.acceptLanguage) userAgentParams.acceptLanguage = profile.acceptLanguage;
  if (profile.platform) userAgentParams.platform = profile.platform;
  if (profile.userAgentMetadata) {
    userAgentParams.userAgentMetadata = profile.userAgentMetadata;
  }
  await view.cdp("Emulation.setUserAgentOverride", userAgentParams);

  if (profile.viewport) {
    const { width, height, ...metrics } = profile.viewport;
    await view.resize(width, height);
    await view.cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: metrics.deviceScaleFactor ?? 1,
      mobile: metrics.mobile ?? false,
      ...(metrics.screenWidth === undefined
        ? {}
        : { screenWidth: metrics.screenWidth }),
      ...(metrics.screenHeight === undefined
        ? {}
        : { screenHeight: metrics.screenHeight }),
    });
  }
}

async function attachNavigationDiagnostics(
  view: Bun.WebView,
  diagnostics: ReadDiagnostics,
) {
  await view.cdp("Network.enable");

  const documentRequests = new Set<string>();
  const onRequest = (event: Event) => {
    const data = ((event as MessageEvent).data ?? {}) as {
      requestId?: string;
      type?: string;
    };
    if (data.requestId && data.type === "Document") {
      documentRequests.add(data.requestId);
    }
  };
  const onResponse = (event: Event) => {
    const data = ((event as MessageEvent).data ?? {}) as {
      requestId?: string;
      response?: { status?: number; url?: string };
    };
    if (!data.requestId || !documentRequests.has(data.requestId)) return;
    diagnostics.responseStatus = data.response?.status;
    diagnostics.responseURL = data.response?.url;
  };

  view.addEventListener("Network.requestWillBeSent", onRequest);
  view.addEventListener("Network.responseReceived", onResponse);

  return () => {
    view.removeEventListener("Network.requestWillBeSent", onRequest);
    view.removeEventListener("Network.responseReceived", onResponse);
  };
}

function logNavigationDiagnostics(
  targetURL: string,
  finalURL: string,
  diagnostics: ReadDiagnostics,
  partial: boolean,
) {
  const describeURL = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "unknown";
    }
  };

  console.info(
    "[read]",
    JSON.stringify({
      target: describeURL(targetURL),
      final: describeURL(finalURL),
      status: diagnostics.responseStatus ?? null,
      challengeMs:
        diagnostics.challengeDetectedAt && diagnostics.challengeCompletedAt
          ? diagnostics.challengeCompletedAt - diagnostics.challengeDetectedAt
          : null,
      partial,
      durationMs: Date.now() - diagnostics.startedAt,
    }),
  );
}

function isChallengePage(state: ChallengeState): boolean {
  const title = state.title.replace(/\s+/g, " ").trim();
  const text = state.text.replace(/\s+/g, " ").trim();
  return CHALLENGE_TITLE_PATTERN.test(title) || CHALLENGE_BODY_PATTERN.test(text);
}

async function getChallengeState(
  view: Bun.WebView,
  timeoutMs: number,
): Promise<ChallengeState> {
  return withTimeout(
    view.evaluate<ChallengeState>(`({
      title: document.title || "",
      url: location.href,
      text: (document.body?.innerText || "").slice(0, 4000),
      readyState: document.readyState
    })`),
    timeoutMs,
    "challenge check",
    () => view.close(),
  );
}

async function waitForChallengeCompletion(
  view: Bun.WebView,
  maxWait: number,
  deadlineAt: number,
  diagnostics: ReadDiagnostics,
): Promise<boolean> {
  let state = await getChallengeState(
    view,
    remainingTime(deadlineAt, 5000, "challenge check"),
  );
  if (!isChallengePage(state)) return false;

  diagnostics.challengeDetectedAt = Date.now();
  const deadline = Math.min(Date.now() + maxWait, deadlineAt);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(CHALLENGE_POLL_MS, remaining)),
    );

    state = await getChallengeState(
      view,
      remainingTime(deadlineAt, 5000, "challenge check"),
    );
    if (!isChallengePage(state) && state.readyState === "complete") {
      diagnostics.challengeCompletedAt = Date.now();
      return true;
    }
  }

  throw new OperationTimeoutError(
    `challenge failed to complete after ${maxWait}ms`,
  );
}

function buildFrontmatter(
  title: string,
  description: string,
  pageMeta: Record<string, string> | null,
  authors: string[],
  url: string,
  partial: boolean,
): string[] {
  const meta = pageMeta || ({} as Record<string, string>);
  return [
    `title: ${title || "无题"}`,
    description ? `description: ${description}` : null,
    meta.siteName ? `site_name: ${meta.siteName}` : null,
    meta.pageType ? `type: ${meta.pageType}` : null,
    authors.length > 0 ? `author: ${authors.join(", ")}` : null,
    meta.publishedTime ? `published_time: ${meta.publishedTime}` : null,
    meta.modifiedTime ? `modified_time: ${meta.modifiedTime}` : null,
    meta.section ? `section: ${meta.section}` : null,
    meta.keywords ? `keywords: ${meta.keywords}` : null,
    meta.canonicalUrl && meta.canonicalUrl !== url
      ? `canonical_url: ${meta.canonicalUrl}`
      : null,
    `url: ${url}`,
    partial ? `partial: true` : null,
  ].filter((value): value is string => value !== null);
}

async function navigateToURL(
  view: Bun.WebView,
  target: string,
  timeoutMs: number,
): Promise<boolean> {
  let navFailed: Error | null = null;

  view.onNavigationFailed = (err) => {
    navFailed = err;
  };
  try {
    await withTimeout(view.navigate(target), timeoutMs, "navigate", () => {
      // WebView has no abort signal. Closing the view prevents a timed-out
      // navigation from racing with later operations on the same target.
      view.close();
    });
  } catch (error) {
    if (error instanceof OperationTimeoutError) throw error;
    const failure = navFailed as Error | null;
    if (failure) {
      console.warn(`Navigate to ${target} failed: ${failure.message}`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Navigate to ${target} failed: ${message}`);
    }
    return true;
  } finally {
    view.onNavigated = null;
    view.onNavigationFailed = null;
  }

  return false;
}

async function readPage(c: any, url: string) {
  if (typeof url !== "string" || !url) {
    return c.json({ error: "似乎没看到 URL" }, 400);
  }

  const normalizedUrl = normalizeInputURL(url);

  if (!isValidURL(normalizedUrl)) {
    return c.json({ error: "URL 无效欸" }, 400);
  }

  if (!(await isSafeNavigationURL(normalizedUrl))) {
    return c.json({ error: "Unsafe URL" }, 400);
  }

  const navigateMs = parseQueryNumber(c, "navigate_timeout", 20000, 1000, 120000);
  const maxWaitMs = parseQueryNumber(c, "max_wait", 60000, 1000, 300000);
  const stableWindowMs = parseQueryNumber(c, "stable_window", 200, 50, 5000);
  const requestTimeoutMs = parseQueryNumber(
    c,
    "request_timeout",
    DEFAULT_REQUEST_TIMEOUT_MS,
    1000,
    MAX_REQUEST_TIMEOUT_MS,
  );
  const stableThreshold = parseQueryNumber(
    c,
    "stable_threshold",
    3,
    1,
    20,
    true,
  );

  if (
    navigateMs === null ||
    maxWaitMs === null ||
    stableWindowMs === null ||
    requestTimeoutMs === null ||
    stableThreshold === null
  ) {
    return c.json({ error: "Invalid timeout parameter" }, 400);
  }

  const releaseReadSlot = tryAcquireReadSlot();
  if (!releaseReadSlot) {
    c.header("Retry-After", "5");
    return c.json({ error: "Too many reads in progress" }, 429);
  }

  const deadlineAt = Date.now() + requestTimeoutMs;
  const diagnostics: ReadDiagnostics = { startedAt: Date.now() };

  try {
    let partial = false;

    const debuggingURL = await withTimeout(
      getBrowserDebuggingURL(),
      remainingTime(deadlineAt, 5000, "browser connection"),
      "browser connection",
    );
    const view = new Bun.WebView({
      backend: {
        type: "chrome",
        url: debuggingURL,
      },
      headless: true,
    });
    const requestSignal = c.req.raw.signal as AbortSignal;
    const onRequestAbort = () => view.close();
    let cleanupDiagnostics = () => {};
    let networkIdleTracker: NetworkIdleTracker | null = null;

    requestSignal.addEventListener("abort", onRequestAbort, { once: true });

    try {
      if (
        await navigateToURL(
          view,
          "about:blank",
          remainingTime(deadlineAt, 5000, "about:blank"),
        )
      ) {
        partial = true;
      }

      if (Bun.env.ENABLE_UA_OVERRIDE !== "false") {
        const matchedUA = pluginRegistry.resolve(normalizedUrl);
        if (matchedUA) {
          await withTimeout(
            applyBrowserProfile(view, matchedUA),
            remainingTime(deadlineAt, 10000, "browser profile"),
            "browser profile",
            () => view.close(),
          );
        }
      }

      cleanupDiagnostics = await withTimeout(
        attachNavigationDiagnostics(view, diagnostics),
        remainingTime(deadlineAt, 5000, "navigation diagnostics"),
        "navigation diagnostics",
        () => view.close(),
      );
      networkIdleTracker = await withTimeout(
        startNetworkIdleTracking(view, true),
        remainingTime(deadlineAt, 5000, "network tracking"),
        "network tracking",
        () => view.close(),
      );

      if (
        await navigateToURL(
          view,
          normalizedUrl,
          remainingTime(deadlineAt, navigateMs, "navigation"),
        )
      ) {
        partial = true;
      }

      const firstFinalURL = getCurrentURL(view, normalizedUrl);
      if (
        /^https?:\/\//i.test(firstFinalURL) &&
        !(await isSafeNavigationURL(firstFinalURL))
      ) {
        throw new Error("Unsafe navigation target");
      }

      await waitForChallengeCompletion(
        view,
        remainingTime(deadlineAt, DEFAULT_CHALLENGE_WAIT_MS, "challenge"),
        deadlineAt,
        diagnostics,
      );
      const challengeFinalURL = getCurrentURL(view, normalizedUrl);
      if (
        /^https?:\/\//i.test(challengeFinalURL) &&
        !(await isSafeNavigationURL(challengeFinalURL))
      ) {
        throw new Error("Unsafe navigation target");
      }
      const networkIdleWaitMs = Math.min(
        maxWaitMs,
        NETWORK_IDLE_MAX_WAIT_MS,
      );
      await withTimeout(
        networkIdleTracker!.wait(
          stableWindowMs,
          remainingTime(deadlineAt, networkIdleWaitMs, "network idle"),
        ),
        remainingTime(deadlineAt, networkIdleWaitMs, "network idle"),
        "network idle",
        () => view.close(),
      );

      let lastLen = -1;
      let stableCount = 0;
      const pollStarted = Date.now();

      while (true) {
        const elapsed = Date.now() - pollStarted;
        if (elapsed >= maxWaitMs || Date.now() >= deadlineAt) {
          partial = true;
          break;
        }

        const contentState = await withTimeout(
          view.evaluate<{ contentLen: number; readyState: string }>(
            "({ contentLen: document.body?.innerText?.length ?? 0, readyState: document.readyState })",
          ),
          remainingTime(deadlineAt, 5000, "content check"),
          "content check",
          () => view.close(),
        );

        if (
          contentState.readyState === "complete" &&
          contentState.contentLen === lastLen
        ) {
          stableCount++;
          if (stableCount >= stableThreshold) break;
        } else {
          stableCount = 0;
          lastLen = contentState.contentLen;
        }

        await new Promise((r) => setTimeout(r, stableWindowMs));
      }

      const pageSnapshot = await withTimeout(
        view.evaluate<{
          title: string;
          description: string;
          pageMeta: {
            siteName: string;
            pageType: string;
            publishedTime: string;
            modifiedTime: string;
            keywords: string;
            section: string;
            canonicalUrl: string;
          };
          authors: string[];
          html: string;
          text: string;
        }>(`(() => {
          const meta = (selector) =>
            document.querySelector(selector)?.getAttribute("content") || "";

          return {
            title:
              document.title ||
              meta('meta[property="og:title"]') ||
              meta('meta[name="twitter:title"]') ||
              document.querySelector("h1")?.textContent?.trim() ||
              document.querySelector("h2")?.textContent?.trim() ||
              "",
            description:
              meta('meta[name="description"]') ||
              meta('meta[property="og:description"]') ||
              meta('meta[name="twitter:description"]') ||
              document.querySelector("p")?.textContent?.trim() ||
              "",
            pageMeta: {
              siteName:
                meta('meta[property="og:site_name"]') ||
                meta('meta[name="application-name"]'),
              pageType: meta('meta[property="og:type"]'),
              publishedTime:
                meta('meta[property="article:published_time"]') ||
                meta('meta[property="og:published_time"]') ||
                meta('meta[name="pubdate"]'),
              modifiedTime:
                meta('meta[property="article:modified_time"]') ||
                meta('meta[property="og:updated_time"]') ||
                meta('meta[name="lastmod"]'),
              keywords:
                meta('meta[name="keywords"]') ||
                meta('meta[property="article:tag"]'),
              section: meta('meta[property="article:section"]'),
              canonicalUrl:
                document.querySelector('link[rel="canonical"]')?.href || "",
            },
            authors: Array.from(
              document.querySelectorAll(
                'meta[name="author"], meta[property="article:author"]',
              ),
            )
              .map((element) => element.getAttribute("content") || "")
              .filter(Boolean),
            html: document.documentElement?.outerHTML || "",
            text:
              document.body?.innerText ||
              document.documentElement?.innerText ||
              "",
          };
        })()`),
        remainingTime(deadlineAt, 5000, "page snapshot"),
        "page snapshot",
        () => view.close(),
      );

      const { title, description, pageMeta, authors, html, text } = pageSnapshot;

      /*
       * All page data is collected in one evaluate call so metadata and HTML
       * describe the same DOM state and cannot overlap on the WebView slot.
       */

      const rawText = (await htmlParser(url, html)) || text;
      const frontmatter = buildFrontmatter(
        title,
        description,
        pageMeta,
        authors,
        normalizedUrl,
        partial,
      );

      const finalText = `---
${frontmatter.join("\n")}
---

${rawText}
          `;

      return c.text(finalText);
    } finally {
      networkIdleTracker?.close();
      cleanupDiagnostics();
      requestSignal.removeEventListener("abort", onRequestAbort);
      const finalURL = getCurrentURL(view, normalizedUrl);
      logNavigationDiagnostics(normalizedUrl, finalURL, diagnostics, partial);
      view.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json(
      { error: "抓取页面失败", message },
      getErrorStatusCode(error),
    );
  } finally {
    releaseReadSlot();
  }
}

app.get("/", (c) => {
  const getMethodIntro = method.allowGet ? "GET /:url" : null;
  const postMethodIntro = method.allowPost
    ? 'POST /read with JSON body { "url": "..." }'
    : null;

  const endpoints = [getMethodIntro, postMethodIntro].filter(Boolean);

  return c.text(`# viewview

## Usage:

${endpoints.map((e) => `- ${e}`).join("\n")}

## Response:

- Content-Type: text/plain
- Body: Markdown text with frontmatter containing metadata like title, description, authors, etc.

## Example:

${method.allowGet ? "- GET /https://example.com" : ""}
${method.allowPost ? '- POST /read with body { "url": "https://example.com" }' : ""}

## Health Check:

- GET /health

[View on GitHub](https://github.com/gengyue2468/viewview)
`);
});

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

const SERVICE_QUERY_PARAMS = new Set([
  "navigate_timeout",
  "max_wait",
  "stable_window",
  "stable_threshold",
  "request_timeout",
]);

function getLegacyGetURL(c: any): string {
  const target = decodeURIComponent(c.req.path.slice(1));
  const requestURL = new URL(c.req.url);
  const targetParams = new URLSearchParams();

  requestURL.searchParams.forEach((value, key) => {
    if (!SERVICE_QUERY_PARAMS.has(key)) targetParams.append(key, value);
  });

  if (!targetParams.size) return target;
  return `${target}${target.includes("?") ? "&" : "?"}${targetParams}`;
}

function getExplicitGetURL(c: any): string {
  const target = c.req.query("url") || "";
  const requestURL = new URL(c.req.url);
  const targetParams = new URLSearchParams();

  requestURL.searchParams.forEach((value, key) => {
    if (key !== "url" && !SERVICE_QUERY_PARAMS.has(key)) {
      targetParams.append(key, value);
    }
  });

  if (!targetParams.size) return target;
  return `${target}${target.includes("?") ? "&" : "?"}${targetParams}`;
}

app.get("/read", async (c) => {
  if (!method.allowGet) {
    return c.json({ error: "Method Not Allowed" }, 405);
  }
  return readPage(c, getExplicitGetURL(c));
});

app.get("/*", (c) => {
  if (!method.allowGet) {
    return c.json({ error: "Method Not Allowed" }, 405);
  }

  try {
    return readPage(c, getLegacyGetURL(c));
  } catch {
    return c.json({ error: "Invalid URL encoding" }, 400);
  }
});

app.post("/read", authMiddleware, async (c) => {
  if (!method.allowPost) {
    return c.json({ error: "Method Not Allowed" }, 405);
  }
  const req = await c.req.json();
  return readPage(c, req.url);
});

Bun.serve({
  fetch: app.fetch,
  port: 9233,
  // Challenge completion may legitimately take up to five minutes. All
  // application-level operations have their own bounded timeouts.
  idleTimeout: 0,
});
