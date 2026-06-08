import type { BrowserLogger, ResolvedBrowserConfig } from "./types.js";
import {
  discoverDevToolsActivePortCandidates,
  type DevToolsActivePortCandidate,
} from "./detect.js";

export interface AttachRunningConnectionInfo {
  host: string;
  port: number;
  browserWSEndpoint: string;
  profileRoot: string;
}

export async function resolveAttachRunningConnection(
  config: Pick<ResolvedBrowserConfig, "chromePath" | "remoteChrome">,
  logger: BrowserLogger,
): Promise<AttachRunningConnectionInfo> {
  const host = config.remoteChrome?.host ?? "127.0.0.1";
  const port = config.remoteChrome?.port ?? 9222;
  if (config.chromePath) {
    logger("Note: --browser-chrome-path is ignored when --browser-attach-running is enabled.");
  }

  logger(
    config.remoteChrome
      ? `Using explicit attach-running target ${host}:${port}.`
      : `Using default attach-running target ${host}:${port}.`,
  );

  const candidates = (await discoverDevToolsActivePortCandidates({ host }))
    .filter((candidate) => candidate.port === port)
    .sort(compareDevToolsCandidates);

  if (candidates.length === 0) {
    throw new Error(
      `No running browser with attach metadata matched ${host}:${port}. Enable remote debugging in chrome://inspect/#remote-debugging first.`,
    );
  }
  const candidate = candidates[0];
  logger(`Selected attach-running browser metadata from ${candidate.path}`);
  const browserWSEndpoint = await resolveBrowserWSEndpoint(
    host,
    candidate.port,
    candidate.browserWSEndpoint,
    logger,
  );
  return {
    host,
    port: candidate.port,
    browserWSEndpoint,
    profileRoot: candidate.profileRoot,
  };
}

async function resolveBrowserWSEndpoint(
  host: string,
  port: number,
  fallback: string,
  logger: BrowserLogger,
): Promise<string> {
  if (!isBareBrowserWSEndpoint(fallback)) {
    return fallback;
  }
  try {
    const response = await fetch(`http://${formatHttpHost(host)}:${port}/json/version`);
    if (!response.ok) {
      return fallback;
    }
    const version = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof version.webSocketDebuggerUrl === "string" && version.webSocketDebuggerUrl) {
      logger("Resolved attach-running browser websocket endpoint from /json/version.");
      return version.webSocketDebuggerUrl;
    }
  } catch {
    // Fall back to the DevToolsActivePort value; the caller will surface connection errors.
  }
  return fallback;
}

function isBareBrowserWSEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.pathname.replace(/\/+$/u, "") === "/devtools/browser";
  } catch {
    return false;
  }
}

function formatHttpHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function compareDevToolsCandidates(
  left: DevToolsActivePortCandidate,
  right: DevToolsActivePortCandidate,
): number {
  if (right.mtimeMs !== left.mtimeMs) {
    return right.mtimeMs - left.mtimeMs;
  }
  return left.path.localeCompare(right.path);
}
