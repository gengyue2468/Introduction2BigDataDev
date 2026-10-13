import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type BrowserKind = "edge" | "chrome" | "chromium";

export interface BrowserExecutable {
  kind: BrowserKind;
  path: string;
}

export const DEFAULT_CDP_PORT = 9222;
export const BROWSER_CONNECTION_TIMEOUT_MS = 30_000;

const BROWSER_START_TIMEOUT_MS = 15_000;
const CDP_POLL_INTERVAL_MS = 100;

function getEnv(name: string): string | undefined {
  const value = Bun.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripWrappingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function getCDPPort(): number {
  const raw = getEnv("BROWSER_CDP_PORT") ?? getEnv("CDP_PORT");
  if (!raw) return DEFAULT_CDP_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BROWSER_CDP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function inferBrowserKind(path: string): BrowserKind {
  const normalized = path.toLowerCase();
  if (normalized.includes("edge") || normalized.includes("msedge")) {
    return "edge";
  }
  if (normalized.includes("chromium")) return "chromium";
  return "chrome";
}

function findExplicitBrowser(pathValue: string): BrowserExecutable {
  const path = stripWrappingQuotes(pathValue);
  const executablePath = existsSync(path) ? path : Bun.which(path);
  if (!executablePath) {
    throw new Error(`BROWSER_PATH does not point to an executable: ${path}`);
  }
  return { kind: inferBrowserKind(executablePath), path: executablePath };
}

function getWindowsCandidatePaths(): Array<{
  kind: BrowserKind;
  path: string;
}> {
  const roots = [
    Bun.env.ProgramFiles,
    Bun.env["ProgramFiles(x86)"],
    Bun.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));

  const candidates: Array<{ kind: BrowserKind; path: string }> = [];
  const addCandidates = (
    kind: BrowserKind,
    channels: string[],
    executable: string,
  ) => {
    for (const root of roots) {
      for (const channel of channels) {
        candidates.push({
          kind,
          path: join(root, ...channel.split("/"), executable),
        });
      }
    }
  };

  // Prefer Edge when both browsers are installed. This order is intentional:
  // the current host commonly has Edge installed in Program Files (x86).
  addCandidates(
    "edge",
    [
      "Microsoft/Edge/Application",
      "Microsoft/Edge Beta/Application",
      "Microsoft/Edge Dev/Application",
      "Microsoft/Edge SxS/Application",
    ],
    "msedge.exe",
  );
  addCandidates(
    "chrome",
    [
      "Google/Chrome/Application",
      "Google/Chrome Beta/Application",
      "Google/Chrome Dev/Application",
      "Google/Chrome SxS/Application",
    ],
    "chrome.exe",
  );
  addCandidates("chromium", ["Chromium/Application"], "chrome.exe");

  return candidates;
}

function getMacCandidatePaths(): Array<{
  kind: BrowserKind;
  path: string;
}> {
  const applicationRoots = ["/Applications", join(homedir(), "Applications")];
  const candidates: Array<{ kind: BrowserKind; path: string }> = [];
  const addCandidates = (
    kind: BrowserKind,
    appNames: string[],
    executable: string,
  ) => {
    for (const root of applicationRoots) {
      for (const appName of appNames) {
        candidates.push({
          kind,
          path: join(root, `${appName}.app`, "Contents", "MacOS", executable),
        });
      }
    }
  };

  addCandidates("edge", ["Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev"], "Microsoft Edge");
  addCandidates("chrome", ["Google Chrome", "Google Chrome Beta", "Google Chrome Dev"], "Google Chrome");
  addCandidates("chromium", ["Chromium"], "Chromium");

  return candidates;
}

function getKnownBrowserCandidates(): Array<{
  kind: BrowserKind;
  path: string;
}> {
  if (process.platform === "win32") return getWindowsCandidatePaths();
  if (process.platform === "darwin") return getMacCandidatePaths();
  return [];
}

function getPathBrowserCandidates(): Array<{
  kind: BrowserKind;
  command: string;
}> {
  if (process.platform === "win32") {
    return [
      { kind: "edge", command: "msedge.exe" },
      { kind: "chrome", command: "chrome.exe" },
      { kind: "chromium", command: "chromium.exe" },
    ];
  }

  if (process.platform === "darwin") {
    return [
      { kind: "edge", command: "Microsoft Edge" },
      { kind: "chrome", command: "Google Chrome" },
      { kind: "chromium", command: "chromium" },
    ];
  }

  return [
    { kind: "edge", command: "microsoft-edge-stable" },
    { kind: "edge", command: "microsoft-edge" },
    { kind: "chrome", command: "google-chrome-stable" },
    { kind: "chrome", command: "google-chrome" },
    { kind: "chromium", command: "chromium" },
    { kind: "chromium", command: "chromium-browser" },
  ];
}

export function detectBrowserExecutable(): BrowserExecutable {
  const explicitPath = getEnv("BROWSER_PATH");
  if (explicitPath) return findExplicitBrowser(explicitPath);

  for (const candidate of getKnownBrowserCandidates()) {
    if (existsSync(candidate.path)) return candidate;
  }

  for (const candidate of getPathBrowserCandidates()) {
    const path = Bun.which(candidate.command);
    if (path) return { kind: candidate.kind, path };
  }

  throw new Error(
    "Could not find Microsoft Edge, Google Chrome, or Chromium. Set BROWSER_PATH to the browser executable.",
  );
}

function getProfileName(): string {
  const profileName = stripWrappingQuotes(getEnv("PROFILE_NAME") ?? "Default").trim();
  if (
    !profileName ||
    profileName === "." ||
    profileName === ".." ||
    profileName.includes("/") ||
    profileName.includes("\\")
  ) {
    throw new Error(
      "PROFILE_NAME must be a browser profile directory name such as Default or Profile 1",
    );
  }
  return profileName;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${process.platform === "win32" ? "\\" : "/"}`)) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function getUserDataDir(kind: BrowserKind): string {
  const configured = getEnv("BROWSER_USER_DATA_DIR");
  if (configured) return resolve(expandHome(stripWrappingQuotes(configured)));

  // Chromium 136+ requires a non-default user data directory for CDP. Keep
  // the directory stable so this browser can retain its own cookies/session,
  // while never touching the user's normal Edge/Chrome data directory.
  return join(tmpdir(), "viewview", "browser-data", kind);
}

export interface BrowserLaunchOptions {
  port: number;
  profileName: string;
  userDataDir: string;
}

export function buildBrowserLaunchArgs({
  port,
  profileName,
  userDataDir,
}: BrowserLaunchOptions): string[] {
  return [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileName}`,
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
}

async function getExistingDebuggingURL(port: number): Promise<string | null> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/json/version`,
      { signal: AbortSignal.timeout(1_000) },
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      webSocketDebuggerUrl?: unknown;
    };
    return typeof data.webSocketDebuggerUrl === "string"
      ? data.webSocketDebuggerUrl
      : null;
  } catch {
    return null;
  }
}

function isAutomaticLaunchEnabled(): boolean {
  return getEnv("AUTO_LAUNCH_BROWSER")?.toLowerCase() !== "false";
}

async function waitForDebuggingURL(
  port: number,
  browserProcess: Bun.Subprocess,
): Promise<string> {
  const deadline = Date.now() + BROWSER_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const debuggingURL = await getExistingDebuggingURL(port);
    if (debuggingURL) return debuggingURL;

    if (browserProcess.exitCode !== null) {
      throw new Error(
        `The browser exited before CDP became available (exit code ${browserProcess.exitCode})`,
      );
    }

    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, CDP_POLL_INTERVAL_MS),
    );
  }

  throw new Error(
    `The browser did not expose CDP on 127.0.0.1:${port} within ${BROWSER_START_TIMEOUT_MS}ms`,
  );
}

async function launchBrowserAndWait(port: number): Promise<string> {
  const executable = detectBrowserExecutable();
  const profileName = getProfileName();
  const userDataDir = getUserDataDir(executable.kind);
  await mkdir(userDataDir, { recursive: true });

  // Avoid starting a second browser if another request won the race while we
  // were detecting the executable or creating the data directory.
  const existingURL = await getExistingDebuggingURL(port);
  if (existingURL) return existingURL;

  const args = buildBrowserLaunchArgs({ port, profileName, userDataDir });
  console.info(
    `[browser] launching ${executable.kind} from ${executable.path} with profile ${profileName} and CDP port ${port}`,
  );

  const browserProcess = Bun.spawn({
    cmd: [executable.path, ...args],
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  browserProcess.unref();

  try {
    return await waitForDebuggingURL(port, browserProcess);
  } catch (error) {
    // This is only the process we just started. Existing browser processes are
    // deliberately never terminated by this launcher.
    if (browserProcess.exitCode === null) browserProcess.kill();
    throw error;
  }
}

let launchPromise: Promise<string> | null = null;

export async function getBrowserDebuggingURL(): Promise<string> {
  const port = getCDPPort();
  const existingURL = await getExistingDebuggingURL(port);
  if (existingURL) return existingURL;

  if (!isAutomaticLaunchEnabled()) {
    throw new Error(
      `No CDP endpoint found on 127.0.0.1:${port}; set AUTO_LAUNCH_BROWSER=true or start a browser manually`,
    );
  }

  if (!launchPromise) {
    launchPromise = launchBrowserAndWait(port).finally(() => {
      launchPromise = null;
    });
  }

  return launchPromise;
}
