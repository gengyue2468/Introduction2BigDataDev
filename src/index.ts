import { Hono, MiddlewareHandler } from "hono";
import {
  isSafeNavigationURL,
  isValidURL,
  normalizeInputURL,
} from "./lib/valid";
import {
  BROWSER_CONNECTION_TIMEOUT_MS,
  getBrowserDebuggingURL,
} from "./lib/browser";
import { htmlParser } from "./lib/parser";
import {
  startNetworkIdleTracking,
  type NetworkIdleTracker,
} from "./lib/network-idle";

import { pluginRegistry, type BrowserProfile } from "./plugins";
import {
  buildJdItemURL,
  extractJdItem,
  normalizeSkuId,
  type JdItem,
  type JdItemResult,
} from "./lib/jd";
import {
  buildTaobaoItemURL,
  extractTaobaoItem,
  normalizeTaobaoItemId,
  type TaobaoItem,
  type TaobaoItemResult,
} from "./lib/taobao";
import { resolve } from "node:path";
import { DashboardStore } from "./dashboard/store";
import { DashboardQueue } from "./dashboard/queue";
import { createDashboardAPI } from "./dashboard/api";

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
const MAX_JD_BATCH_SIZE = 20;
const JD_BATCH_CONCURRENCY = Math.max(
  1,
  Math.min(MAX_CONCURRENT_READS, Number(Bun.env.JD_BATCH_CONCURRENCY) || 1),
);
const MAX_TAOBAO_BATCH_SIZE = 20;
const TAOBAO_BATCH_CONCURRENCY = Math.max(
  1,
  Math.min(MAX_CONCURRENT_READS, Number(Bun.env.TAOBAO_BATCH_CONCURRENCY) || 1),
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
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number | null {
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

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

interface PageSnapshot {
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
  normalizedUrl: string;
  finalUrl: string;
  partial: boolean;
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
  kind = "read",
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
    `[${kind}]`,
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

interface CaptureOptions {
  signal?: AbortSignal;
  query?: (name: string) => string | undefined;
}

function captureOptionsFromRequest(c: any): CaptureOptions {
  return { signal: c.req.raw.signal, query: (name) => c.req.query(name) };
}

async function capturePage(
  url: string,
  kind: "read" | "jd" | "taobao" = "read",
  options: CaptureOptions = {},
): Promise<PageSnapshot> {
  options.signal?.throwIfAborted();
  if (typeof url !== "string" || !url) {
    throw new RequestError("似乎没看到 URL", 400);
  }

  const normalizedUrl = normalizeInputURL(url);
  if (!isValidURL(normalizedUrl)) {
    throw new RequestError("URL 无效欸", 400);
  }
  if (!(await isSafeNavigationURL(normalizedUrl))) {
    throw new RequestError("Unsafe URL", 400);
  }

  const navigateMs = parseQueryNumber(options.query?.("navigate_timeout"), 20000, 1000, 120000);
  const maxWaitMs = parseQueryNumber(options.query?.("max_wait"), 60000, 1000, 300000);
  const stableWindowMs = parseQueryNumber(options.query?.("stable_window"), 200, 50, 5000);
  const requestTimeoutMs = parseQueryNumber(
    options.query?.("request_timeout"),
    DEFAULT_REQUEST_TIMEOUT_MS,
    1000,
    MAX_REQUEST_TIMEOUT_MS,
  );
  const stableThreshold = parseQueryNumber(
    options.query?.("stable_threshold"),
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
    throw new RequestError("Invalid timeout parameter", 400);
  }

  const releaseReadSlot = tryAcquireReadSlot();
  if (!releaseReadSlot) {
    throw new RequestError("Too many reads in progress", 429);
  }

  const deadlineAt = Date.now() + requestTimeoutMs;
  const diagnostics: ReadDiagnostics = { startedAt: Date.now() };

  try {
    let partial = false;
    const debuggingURL = await withTimeout(
      getBrowserDebuggingURL(),
      remainingTime(
        deadlineAt,
        BROWSER_CONNECTION_TIMEOUT_MS,
        "browser connection",
      ),
      "browser connection",
    );
    options.signal?.throwIfAborted();
    const view = new Bun.WebView({
      backend: {
        type: "chrome",
        url: debuggingURL,
      },
      headless: true,
    });
    const requestSignal = options.signal;
    const onRequestAbort = () => view.close();
    let cleanupDiagnostics = () => {};
    let networkIdleTracker: NetworkIdleTracker | null = null;

    requestSignal?.addEventListener("abort", onRequestAbort, { once: true });

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

      const networkIdleWaitMs = Math.min(maxWaitMs, NETWORK_IDLE_MAX_WAIT_MS);
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

        await new Promise((resolve) => setTimeout(resolve, stableWindowMs));
      }

      const pageSnapshot = await withTimeout(
        view.evaluate<Omit<PageSnapshot, "normalizedUrl" | "finalUrl" | "partial">>(`(() => {
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

      const finalUrl = getCurrentURL(view, normalizedUrl);
      return {
        ...pageSnapshot,
        normalizedUrl,
        finalUrl,
        partial,
      };
    } finally {
      networkIdleTracker?.close();
      cleanupDiagnostics();
      requestSignal?.removeEventListener("abort", onRequestAbort);
      const finalURL = getCurrentURL(view, normalizedUrl);
      logNavigationDiagnostics(normalizedUrl, finalURL, diagnostics, partial, kind);
      view.close();
    }
  } finally {
    releaseReadSlot();
  }
}

function errorResponse(c: any, error: unknown, label: string) {
  const message = error instanceof Error ? error.message : String(error);
  const status = getErrorStatusCode(error);
  if (status === 429) c.header("Retry-After", "5");
  return c.json({ error: label, message }, status);
}

async function readPage(c: any, url: string) {
  try {
    const pageSnapshot = await capturePage(url, "read", captureOptionsFromRequest(c));
    const { title, description, pageMeta, authors, html, text } = pageSnapshot;

    /*
     * All page data is collected in one evaluate call so metadata and HTML
     * describe the same DOM state and cannot overlap on the WebView slot.
     */
    const rawText = (await htmlParser(pageSnapshot.normalizedUrl, html)) || text;
    const frontmatter = buildFrontmatter(
      title,
      description,
      pageMeta,
      authors,
      pageSnapshot.normalizedUrl,
      pageSnapshot.partial,
    );

    const finalText = `---
${frontmatter.join("\n")}
---

${rawText}
      `;

    return c.text(finalText);
  } catch (error) {
    return errorResponse(c, error, "抓取页面失败");
  }
}

async function readJdItem(skuId: string, options: CaptureOptions = {}): Promise<JdItem> {
  const sourceUrl = buildJdItemURL(skuId);
  const pageSnapshot = await capturePage(sourceUrl, "jd", options);
  return extractJdItem(pageSnapshot.html, skuId, sourceUrl);
}

async function readTaobaoItem(itemId: string, options: CaptureOptions = {}): Promise<TaobaoItem> {
  const sourceUrl = buildTaobaoItemURL(itemId);
  const pageSnapshot = await capturePage(
    sourceUrl,
    "taobao",
    options,
  );
  return extractTaobaoItem(pageSnapshot.html, itemId, sourceUrl);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    ),
  );

  return results;
}

function jdErrorResult(skuId: string, error: unknown): JdItemResult {
  return {
    sku_id: skuId,
    item_name: "",
    shop_name: "",
    daily_price: null,
    actual_price: null,
    source_url: buildJdItemURL(skuId),
    observed_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

function taobaoErrorResult(
  itemId: string,
  error: unknown,
): TaobaoItemResult {
  return {
    item_id: itemId,
    item_name: "",
    shop_name: "",
    daily_price: null,
    actual_price: null,
    source_url: buildTaobaoItemURL(itemId),
    observed_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

app.get("/", (c) => {
  const getMethodIntro = method.allowGet ? "GET /:url" : null;
  const postMethodIntro = method.allowPost
    ? 'POST /read with JSON body { "url": "..." }'
    : null;
  const jdMethodIntro = method.allowGet
    ? ["GET /jd/items/:skuId", "GET /jd/average?sku_id=..."]
    : [];
  const taobaoMethodIntro = method.allowGet
    ? [
        "GET /taobao/items/:itemId",
        "GET /taobao/average?item_id=...",
      ]
    : [];

  const endpoints = [
    getMethodIntro,
    postMethodIntro,
    ...jdMethodIntro,
    ...taobaoMethodIntro,
  ].filter(Boolean);

  return c.text(`# viewview

## Usage:

${endpoints.map((e) => `- ${e}`).join("\n")}

## Response:

- Content-Type: text/plain
- Body: Markdown text with frontmatter containing metadata like title, description, authors, etc.

## Example:

${method.allowGet ? "- GET /https://example.com" : ""}
${method.allowPost ? '- POST /read with body { "url": "https://example.com" }' : ""}
${method.allowGet ? "- GET /jd/items/100342771276" : ""}
${method.allowGet ? "- GET /jd/average?sku_id=100342771276&sku_id=..." : ""}
${method.allowGet ? "- GET /taobao/items/1039489952733" : ""}
${method.allowGet ? "- GET /taobao/average?item_id=1039489952733&item_id=..." : ""}

## Health Check:

- GET /health

[View on GitHub](https://github.com/gengyue2468/viewview)
`);
});

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Bun hot reload keeps globalThis: stop the old worker before recovering its jobs.
const runtime = globalThis as typeof globalThis & {
  __viewviewDashboard?: { store: DashboardStore; queue: DashboardQueue };
};
const previousDashboard = runtime.__viewviewDashboard;
if (previousDashboard) {
  void previousDashboard.queue.stop().finally(() => previousDashboard.store.close());
}
const dashboardStore = new DashboardStore(
  Bun.env.DATABASE_PATH || resolve(import.meta.dir, "../data/viewview.sqlite"),
);
const dashboardQueue = new DashboardQueue(dashboardStore, (job, signal) =>
  job.platform === "jd"
    ? readJdItem(job.item_id, { signal })
    : readTaobaoItem(job.item_id, { signal }),
);
runtime.__viewviewDashboard = { store: dashboardStore, queue: dashboardQueue };
app.route("/api", createDashboardAPI(dashboardStore, dashboardQueue, Bun.env.ACCESS_TOKEN));
dashboardQueue.start();

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

function getJdSkuIds(c: any): {
  skuIds: string[];
  invalid: string[];
} {
  const requestURL = new URL(c.req.url);
  const rawValues = [
    ...requestURL.searchParams.getAll("sku_id"),
    ...requestURL.searchParams.getAll("sku_ids"),
  ];
  const candidates = rawValues.flatMap((value) => value.split(","));
  const skuIds: string[] = [];
  const invalid: string[] = [];

  for (const candidate of candidates) {
    const rawSkuId = candidate.trim();
    if (!rawSkuId) continue;

    const skuId = normalizeSkuId(rawSkuId);
    if (!skuId) {
      invalid.push(rawSkuId);
    } else if (!skuIds.includes(skuId)) {
      skuIds.push(skuId);
    }
  }

  return { skuIds, invalid: [...new Set(invalid)] };
}

function getTaobaoItemIds(c: any): {
  itemIds: string[];
  invalid: string[];
} {
  const requestURL = new URL(c.req.url);
  const rawValues = [
    ...requestURL.searchParams.getAll("item_id"),
    ...requestURL.searchParams.getAll("item_ids"),
  ];
  const candidates = rawValues.flatMap((value) => value.split(","));
  const itemIds: string[] = [];
  const invalid: string[] = [];

  for (const candidate of candidates) {
    const rawItemId = candidate.trim();
    if (!rawItemId) continue;

    const itemId = normalizeTaobaoItemId(rawItemId);
    if (!itemId) {
      invalid.push(rawItemId);
    } else if (!itemIds.includes(itemId)) {
      itemIds.push(itemId);
    }
  }

  return { itemIds, invalid: [...new Set(invalid)] };
}

app.get("/jd/items/:skuId", async (c) => {
  if (!method.allowGet) {
    return c.json({ error: "Method Not Allowed" }, 405);
  }

  const rawSkuId = c.req.param("skuId");
  const skuId = normalizeSkuId(rawSkuId);
  if (!skuId) {
    return c.json({ error: "skuId 必须是数字" }, 400);
  }

  try {
    return c.json(await readJdItem(skuId, captureOptionsFromRequest(c)));
  } catch (error) {
    return errorResponse(c, error, "读取京东商品失败");
  }
});

app.get("/jd/average", async (c) => {
  if (!method.allowGet) {
    return c.json({ error: "Method Not Allowed" }, 405);
  }

  const { skuIds, invalid } = getJdSkuIds(c);
  if (invalid.length > 0) {
    return c.json({ error: "sku_id 无效", invalid }, 400);
  }
  if (skuIds.length === 0) {
    return c.json({ error: "至少需要一个 sku_id" }, 400);
  }
  if (skuIds.length > MAX_JD_BATCH_SIZE) {
    return c.json(
      { error: `一次最多查询 ${MAX_JD_BATCH_SIZE} 个 sku_id` },
      400,
    );
  }

  const items = await mapWithConcurrency(
    skuIds,
    JD_BATCH_CONCURRENCY,
    async (skuId): Promise<JdItemResult> => {
      try {
        return await readJdItem(skuId, captureOptionsFromRequest(c));
      } catch (error) {
        return jdErrorResult(skuId, error);
      }
    },
  );
  const validPrices = items.flatMap((item) =>
    item.actual_price === null ? [] : [item.actual_price],
  );
  const averageActualPrice = validPrices.length
    ? Number(
        (validPrices.reduce((sum, price) => sum + price, 0) / validPrices.length).toFixed(2),
      )
    : null;

  return c.json({
    sku_ids: skuIds,
    total: items.length,
    valid: validPrices.length,
    failed: items.length - validPrices.length,
    average_actual_price: averageActualPrice,
    items,
  });
});

app.get("/taobao/items/:itemId", async (c) => {
  if (!method.allowGet) {
    return c.json({ error: "Method Not Allowed" }, 405);
  }

  const rawItemId = c.req.param("itemId");
  const itemId = normalizeTaobaoItemId(rawItemId);
  if (!itemId) {
    return c.json({ error: "itemId 必须是数字" }, 400);
  }

  try {
    return c.json(await readTaobaoItem(itemId, captureOptionsFromRequest(c)));
  } catch (error) {
    return errorResponse(c, error, "读取淘宝商品失败");
  }
});

app.get("/taobao/average", async (c) => {
  if (!method.allowGet) {
    return c.json({ error: "Method Not Allowed" }, 405);
  }

  const { itemIds, invalid } = getTaobaoItemIds(c);
  if (invalid.length > 0) {
    return c.json({ error: "item_id 无效", invalid }, 400);
  }
  if (itemIds.length === 0) {
    return c.json({ error: "至少需要一个 item_id" }, 400);
  }
  if (itemIds.length > MAX_TAOBAO_BATCH_SIZE) {
    return c.json(
      { error: `一次最多查询 ${MAX_TAOBAO_BATCH_SIZE} 个 item_id` },
      400,
    );
  }

  const items = await mapWithConcurrency(
    itemIds,
    TAOBAO_BATCH_CONCURRENCY,
    async (itemId): Promise<TaobaoItemResult> => {
      try {
        return await readTaobaoItem(itemId, captureOptionsFromRequest(c));
      } catch (error) {
        return taobaoErrorResult(itemId, error);
      }
    },
  );
  const validPrices = items.flatMap((item) =>
    item.actual_price === null ? [] : [item.actual_price],
  );
  const averageActualPrice = validPrices.length
    ? Number(
        (validPrices.reduce((sum, price) => sum + price, 0) / validPrices.length).toFixed(2),
      )
    : null;

  return c.json({
    item_ids: itemIds,
    total: items.length,
    valid: validPrices.length,
    failed: items.length - validPrices.length,
    average_actual_price: averageActualPrice,
    items,
  });
});

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
