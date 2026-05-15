import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { sessionStore } from "../sessionStore.js";
import type { BrowserHarvestState, SessionMetadata } from "../sessionStore.js";
import type { BrowserOwnerLabelSource } from "../browser/ownerLabel.js";
import {
  collectChatGptTabs,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
  extractConversationIdFromUrl,
  formatBrowserTabState,
  harvestChatGptTab,
  sessionMatchesTab,
  type ChatGptTabSummary,
} from "../browser/liveTabs.js";
import { resolveOutputPath } from "./writeOutputPath.js";

const LIVE_POLL_MS = 2000;
const DEFAULT_STALL_THRESHOLD_MS = 60_000;

export interface BrowserHarvestOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallWindowMs?: number;
  quietOutput?: boolean;
}

export interface BrowserLiveTailOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallThresholdMs?: number;
}

interface BrowserOwnerSummary {
  label: string;
  source: BrowserOwnerLabelSource;
}

function sessionBrowserEndpoint(
  meta: SessionMetadata | null | undefined,
): { host: string; port: number } | null {
  const runtime = meta?.browser?.runtime ?? {};
  const remote: { host?: string; port?: number } = meta?.browser?.config?.remoteChrome ?? {};
  const host = runtime.chromeHost ?? remote.host;
  const port = runtime.chromePort ?? remote.port;
  if (!host || !port) {
    return null;
  }
  return { host, port };
}

function collectUniqueEndpoints(metas: SessionMetadata[]): Array<{ host: string; port: number }> {
  const entries = new Map<string, { host: string; port: number }>();
  entries.set(`${DEFAULT_REMOTE_CHROME_HOST}:${DEFAULT_REMOTE_CHROME_PORT}`, {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  });
  for (const meta of metas) {
    const endpoint = sessionBrowserEndpoint(meta);
    if (!endpoint) {
      continue;
    }
    entries.set(`${endpoint.host}:${endpoint.port}`, endpoint);
  }
  return Array.from(entries.values());
}

function buildSessionIndex(metas: SessionMetadata[]): SessionMetadata[] {
  return metas
    .filter(
      (meta) => meta?.mode === "browser" || meta?.options?.mode === "browser" || meta?.browser,
    )
    .sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
    );
}

function resolveLinkedSession(
  tab: ChatGptTabSummary,
  metas: SessionMetadata[],
): SessionMetadata | null {
  return buildSessionIndex(metas).find((meta) => sessionMatchesTab(meta, tab)) ?? null;
}

function snippet(text: string, max = 120): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function isLowSignalAssistantSnippet(text: string | null | undefined): boolean {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return !normalized || normalized.length <= 2 || normalized === "the";
}

function chooseAssistantSnippet(
  primary: string | null | undefined,
  fallback?: string | null,
  max = 120,
): string {
  const primarySnippet = snippet(primary ?? "", max);
  if (!isLowSignalAssistantSnippet(primarySnippet)) {
    return primarySnippet;
  }
  const fallbackSnippet = snippet(fallback ?? "", max);
  return isLowSignalAssistantSnippet(fallbackSnippet) ? "" : fallbackSnippet;
}

function resolveSessionTabRef(meta: SessionMetadata): string {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  return (
    harvest.url ??
    runtime.tabUrl ??
    harvest.conversationId ??
    runtime.conversationId ??
    harvest.targetId ??
    runtime.chromeTargetId ??
    "current"
  );
}

export function resolveSessionTabRefForTest(meta: SessionMetadata): string {
  return resolveSessionTabRef(meta);
}

function resolveBrowserOwner(meta: SessionMetadata | null | undefined): BrowserOwnerSummary | null {
  if (!meta || (meta.mode !== "browser" && meta.options?.mode !== "browser" && !meta.browser)) {
    return null;
  }
  const candidates: Array<{ label: unknown; source: BrowserOwnerLabelSource }> = [
    { label: meta.browser?.ownerLabel, source: meta.browser?.ownerSource ?? "explicit" },
    {
      label: meta.browser?.runtime?.ownerLabel,
      source: meta.browser?.runtime?.ownerSource ?? "explicit",
    },
    {
      label: meta.browser?.config?.ownerLabel,
      source: meta.browser?.config?.ownerSource ?? "explicit",
    },
    {
      label: meta.options?.browserConfig?.ownerLabel,
      source: meta.options?.browserConfig?.ownerSource ?? "explicit",
    },
    { label: meta.options?.slug, source: "slug" },
    { label: meta.id, source: "session-id" },
  ];
  for (const candidate of candidates) {
    const label = String(candidate.label ?? "").trim();
    if (label) {
      return { label, source: candidate.source };
    }
  }
  return null;
}

function resolveBrowserOwnerLabel(meta: SessionMetadata | null | undefined): string | null {
  return resolveBrowserOwner(meta)?.label ?? null;
}

export function resolveBrowserOwnerLabelForTest(
  meta: SessionMetadata | null | undefined,
): string | null {
  return resolveBrowserOwnerLabel(meta);
}

function deriveLiveTailState(
  harvested: Pick<
    ChatGptTabSummary,
    "stopExists" | "thinkingActive" | "completionVisible" | "authenticated"
  >,
  unchangedSince: number,
  stallThresholdMs: number,
): BrowserHarvestState {
  if (harvested.stopExists || harvested.thinkingActive) {
    return "running";
  }
  if (harvested.authenticated && harvested.completionVisible) {
    return "completed";
  }
  return Date.now() - unchangedSince >= stallThresholdMs ? "stalled" : "detached";
}

export function deriveLiveTailStateForTest(
  harvested: Pick<
    ChatGptTabSummary,
    "stopExists" | "thinkingActive" | "completionVisible" | "authenticated"
  >,
  unchangedSince: number,
  stallThresholdMs: number,
): BrowserHarvestState {
  return deriveLiveTailState(harvested, unchangedSince, stallThresholdMs);
}

function isBrowserTabActive(
  tab: Pick<
    ChatGptTabSummary,
    | "state"
    | "stopExists"
    | "thinkingActive"
    | "completionVisible"
    | "authenticated"
    | "sendExists"
    | "promptReady"
    | "assistantCount"
  >,
): boolean {
  return tab.stopExists || tab.thinkingActive || formatBrowserTabState(tab) === "running";
}

export function isBrowserTabActiveForTest(
  tab: Pick<
    ChatGptTabSummary,
    | "state"
    | "stopExists"
    | "thinkingActive"
    | "completionVisible"
    | "authenticated"
    | "sendExists"
    | "promptReady"
    | "assistantCount"
  >,
): boolean {
  return isBrowserTabActive(tab);
}

function formatBrowserSignals(
  tab: Pick<
    ChatGptTabSummary,
    | "state"
    | "stopExists"
    | "thinkingActive"
    | "completionVisible"
    | "authenticated"
    | "sendExists"
    | "promptReady"
    | "assistantCount"
  >,
): string {
  const thinkingActive = tab.stopExists || tab.thinkingActive;
  return `active=${isBrowserTabActive(tab) ? "yes" : "no"} stop=${tab.stopExists ? "yes" : "no"} thinking=${thinkingActive ? "yes" : "no"} completeUi=${tab.completionVisible ? "yes" : "no"} send=${tab.sendExists ? "yes" : "no"}`;
}

export function formatBrowserSignalsForTest(
  tab: Pick<
    ChatGptTabSummary,
    | "state"
    | "stopExists"
    | "thinkingActive"
    | "completionVisible"
    | "authenticated"
    | "sendExists"
    | "promptReady"
    | "assistantCount"
  >,
): string {
  return formatBrowserSignals(tab);
}

async function persistHarvest(
  sessionId: string,
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
): Promise<void> {
  const browser = buildHarvestBrowserMetadata(meta, harvested);
  await sessionStore.updateSession(sessionId, { browser });
}

function buildHarvestBrowserMetadata(
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
  harvestedAt = new Date(),
): NonNullable<SessionMetadata["browser"]> {
  const hash = createHash("sha1")
    .update(harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "")
    .digest("hex");
  const owner = resolveBrowserOwner(meta);
  return {
    ...(meta.browser ?? {}),
    harvest: {
      ...(meta.browser?.harvest ?? {}),
      ...(owner ? { ownerLabel: owner.label, ownerSource: owner.source } : {}),
      targetId: harvested.targetId,
      url: harvested.url,
      conversationId: harvested.conversationId ?? extractConversationIdFromUrl(harvested.url),
      harvestedAt: harvestedAt.toISOString(),
      assistantHash: hash,
      state: harvested.state,
      stopExists: harvested.stopExists,
      thinkingActive: harvested.thinkingActive,
      completionVisible: harvested.completionVisible,
      sendExists: harvested.sendExists,
      assistantCount: harvested.assistantCount,
      currentModelLabel: harvested.currentModelLabel,
      firstAssistantSnippet: harvested.firstAssistantSnippet,
      openingLine: harvested.openingLine,
      lastAssistantSnippet: harvested.lastAssistantSnippet,
      lastUserSnippet: harvested.lastUserSnippet,
    },
  };
}

export function buildHarvestBrowserMetadataForTest(
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
  harvestedAt?: Date,
): NonNullable<SessionMetadata["browser"]> {
  return buildHarvestBrowserMetadata(meta, harvested, harvestedAt);
}

function formatHarvestSummaryLines(
  sessionId: string,
  harvested: ChatGptTabSummary,
  owner: BrowserOwnerSummary | null,
): string[] {
  const lines = [`Session: ${sessionId}`];
  if (owner) {
    lines.push(`Owner: ${owner.label}`);
  }
  lines.push(`Target: ${harvested.targetId}`);
  const conversationId = harvested.conversationId ?? extractConversationIdFromUrl(harvested.url);
  if (conversationId) {
    lines.push(`Conversation: ${conversationId}`);
  }
  lines.push(`State: ${formatBrowserTabState(harvested)}`);
  lines.push(`Model: ${harvested.currentModelLabel || "(unknown)"}`);
  lines.push(`URL: ${harvested.url}`);
  lines.push(`Assistant turns: ${harvested.assistantCount}`);
  lines.push(`Signals: ${formatBrowserSignals(harvested)}`);
  const openingSnippet = chooseAssistantSnippet(
    harvested.openingLine || harvested.firstAssistantSnippet,
  );
  if (openingSnippet) {
    lines.push(`Opening: ${openingSnippet}`);
  }
  const lastAssistantSnippet = chooseAssistantSnippet(harvested.lastAssistantSnippet);
  if (lastAssistantSnippet) {
    lines.push(`Last assistant: ${lastAssistantSnippet}`);
  }
  if (harvested.lastUserSnippet) {
    lines.push(`Last user: ${snippet(harvested.lastUserSnippet)}`);
  }
  return lines;
}

export function formatHarvestSummaryLinesForTest(
  sessionId: string,
  harvested: ChatGptTabSummary,
  ownerLabel?: string | null,
): string[] {
  return formatHarvestSummaryLines(
    sessionId,
    harvested,
    ownerLabel ? { label: ownerLabel, source: "explicit" } : null,
  );
}

function printHarvestSummary(
  sessionId: string,
  harvested: ChatGptTabSummary,
  owner: BrowserOwnerSummary | null,
): void {
  const lines = formatHarvestSummaryLines(sessionId, harvested, owner);
  for (const [index, line] of lines.entries()) {
    console.log(index === 0 ? chalk.bold(line) : line);
  }
  console.log(chalk.dim("---"));
}

function formatBrowserTabStatusLines(
  tab: ChatGptTabSummary,
  linkedSession: SessionMetadata | null,
): string[] {
  const lines = [
    `- ${tab.targetId} ${formatBrowserTabState(tab)} ${formatBrowserSignals(tab)} model=${tab.currentModelLabel || "(unknown)"} turns=${tab.assistantCount}`,
    `  title=${tab.title || "(untitled)"}`,
    `  url=${tab.url}`,
  ];
  const conversationId = tab.conversationId ?? extractConversationIdFromUrl(tab.url);
  if (conversationId) {
    lines.push(`  conversation=${conversationId}`);
  }
  if (linkedSession) {
    lines.push(`  session=${linkedSession.id}`);
    const ownerLabel = resolveBrowserOwnerLabel(linkedSession);
    if (ownerLabel) {
      lines.push(`  owner=${ownerLabel}`);
    }
  }
  const harvest = linkedSession?.browser?.harvest;
  const openingSnippet = chooseAssistantSnippet(
    tab.openingLine || tab.firstAssistantSnippet,
    harvest?.openingLine || harvest?.firstAssistantSnippet,
  );
  if (openingSnippet) {
    lines.push(`  opening=${openingSnippet}`);
  }
  const lastAssistantSnippet = chooseAssistantSnippet(
    tab.lastAssistantSnippet,
    harvest?.lastAssistantSnippet,
  );
  if (lastAssistantSnippet) {
    lines.push(`  last=${lastAssistantSnippet}`);
  }
  return lines;
}

export function formatBrowserTabStatusLinesForTest(
  tab: ChatGptTabSummary,
  linkedSession: SessionMetadata | null,
): string[] {
  return formatBrowserTabStatusLines(tab, linkedSession);
}

function formatLiveTailStatusLine(
  sessionId: string,
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
  timestamp = new Date(),
  fullText = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "",
): string {
  const owner = resolveBrowserOwner(meta);
  const conversationId = harvested.conversationId ?? extractConversationIdFromUrl(harvested.url);
  const openingSnippet = chooseAssistantSnippet(
    harvested.openingLine || harvested.firstAssistantSnippet,
  );
  const lastSnippet = chooseAssistantSnippet(harvested.lastAssistantSnippet, fullText, 160);
  return [
    `[${timestamp.toISOString()}]`,
    `session=${sessionId}`,
    owner ? `owner=${owner.label}` : null,
    `target=${harvested.targetId || "(unknown)"}`,
    `conversation=${conversationId || "(unknown)"}`,
    `state=${formatBrowserTabState(harvested)}`,
    formatBrowserSignals(harvested),
    `model=${harvested.currentModelLabel || "(unknown)"}`,
    `turns=${harvested.assistantCount}`,
    `opening=${openingSnippet || "(none)"}`,
    `last=${lastSnippet || "(none)"}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatLiveTailStatusLineForTest(
  sessionId: string,
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
  timestamp?: Date,
  fullText?: string,
): string {
  return formatLiveTailStatusLine(sessionId, meta, harvested, timestamp, fullText);
}

async function maybeWriteHarvestOutput(
  pathInput: string | undefined,
  cwd: string,
  content: string,
): Promise<void> {
  const resolved = resolveOutputPath(pathInput, cwd);
  if (!resolved) {
    return;
  }
  const payload = content ?? "";
  if (resolved === "-" || resolved === "/dev/stdout") {
    process.stdout.write(`${payload}${payload.endsWith("\n") ? "" : "\n"}`);
    return;
  }
  await fs.writeFile(resolved, payload, "utf8");
  console.log(chalk.dim(`Wrote harvested assistant output to ${resolved}`));
}

export async function showBrowserTabsStatus(): Promise<void> {
  const metas = await sessionStore.listSessions().catch(() => [] as SessionMetadata[]);
  const endpoints = collectUniqueEndpoints(metas);
  let printedAny = false;
  for (const endpoint of endpoints) {
    let tabs: ChatGptTabSummary[];
    try {
      tabs = await collectChatGptTabs(endpoint);
    } catch {
      continue;
    }
    if (tabs.length === 0) {
      continue;
    }
    printedAny = true;
    console.log(chalk.bold(`Browser Tabs ${endpoint.host}:${endpoint.port}`));
    for (const tab of tabs) {
      const linkedSession = resolveLinkedSession(
        { ...tab, host: endpoint.host, port: endpoint.port },
        metas,
      );
      for (const line of formatBrowserTabStatusLines(tab, linkedSession)) {
        console.log(line);
      }
    }
  }
  if (!printedAny) {
    console.log("No live ChatGPT tabs found on known Chrome DevTools endpoints.");
  }
}

export async function harvestSessionBrowserOutput(
  sessionId: string,
  options: BrowserHarvestOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  const endpoint = sessionBrowserEndpoint(meta) ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  const harvested = await harvestChatGptTab({
    host: endpoint.host,
    port: endpoint.port,
    ref: options.browserTabRef ?? resolveSessionTabRef(meta),
    stallWindowMs: options.stallWindowMs,
  });
  await persistHarvest(sessionId, meta, harvested);
  printHarvestSummary(sessionId, harvested, resolveBrowserOwner(meta));
  const output = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
  if (options.writeOutputPath) {
    await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
  }
  if (!options.quietOutput && output) {
    process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
  }
  return harvested;
}

export async function liveTailSessionBrowserOutput(
  sessionId: string,
  options: BrowserLiveTailOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  const endpoint = sessionBrowserEndpoint(meta) ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  const browserTabRef = options.browserTabRef ?? resolveSessionTabRef(meta);
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  let lastHash: string | null = null;
  let unchangedSince = Date.now();

  while (true) {
    const harvested = await harvestChatGptTab({
      host: endpoint.host,
      port: endpoint.port,
      ref: browserTabRef,
    });
    const fullText = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
    const hash = createHash("sha1").update(fullText).digest("hex");
    if (hash !== lastHash) {
      lastHash = hash;
      unchangedSince = Date.now();
      const statusLine = formatLiveTailStatusLine(sessionId, meta, harvested, new Date(), fullText);
      console.log(statusLine);
      await persistHarvest(sessionId, meta, harvested);
    }

    const derivedState = deriveLiveTailState(harvested, unchangedSince, stallThresholdMs);

    if (derivedState === "completed" || derivedState === "stalled" || derivedState === "detached") {
      const finalHarvest: ChatGptTabSummary = {
        ...harvested,
        state: derivedState,
      };
      await persistHarvest(sessionId, meta, finalHarvest);
      printHarvestSummary(sessionId, finalHarvest, resolveBrowserOwner(meta));
      const output = finalHarvest.lastAssistantMarkdown ?? finalHarvest.lastAssistantText ?? "";
      if (options.writeOutputPath) {
        await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
      }
      if (output) {
        process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
      }
      return finalHarvest;
    }

    await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
  }
}
