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
import { hasHardVisibleChatGptErrorText } from "../browser/actions/chatgptErrors.js";
import { resolveOutputPath } from "./writeOutputPath.js";

const LIVE_POLL_MS = 2000;
const DEFAULT_STALL_THRESHOLD_MS = 60_000;
const DEFAULT_COMPLETION_STABLE_MS = 8_000;

export interface BrowserHarvestOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  browserEndpoint?: { host: string; port: number };
  stallWindowMs?: number;
  quietOutput?: boolean;
}

export interface BrowserLiveTailOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  browserEndpoint?: { host: string; port: number };
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
  const runtimeConversationRef =
    (runtime.tabUrl && extractConversationIdFromUrl(runtime.tabUrl) ? runtime.tabUrl : undefined) ??
    runtime.conversationId ??
    (runtime.tabUrl ? extractConversationIdFromUrl(runtime.tabUrl) : undefined);
  const harvestConversationRef =
    (harvest.url && extractConversationIdFromUrl(harvest.url) ? harvest.url : undefined) ??
    harvest.conversationId ??
    (harvest.url ? extractConversationIdFromUrl(harvest.url) : undefined);
  const harvestMatchesRuntime = Boolean(
    harvest.targetId && runtime.chromeTargetId && harvest.targetId === runtime.chromeTargetId,
  );
  const harvestTargetIsConflicting = Boolean(
    harvest.targetId && runtime.chromeTargetId && harvest.targetId !== runtime.chromeTargetId,
  );
  const harvestUrlIsAmbiguousRoot = isChatGptRootUrl(harvest.url);

  if (harvestConversationRef && (harvestMatchesRuntime || !runtime.chromeTargetId)) {
    return harvestConversationRef;
  }
  if (runtimeConversationRef) {
    return runtimeConversationRef;
  }
  if (
    runtime.chromeTargetId &&
    (meta.status === "running" || harvestTargetIsConflicting || harvestUrlIsAmbiguousRoot)
  ) {
    return runtime.chromeTargetId;
  }
  return harvest.targetId ?? harvest.url ?? runtime.tabUrl ?? runtime.chromeTargetId ?? "current";
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

function resolveBrowserProfileLabel(meta: SessionMetadata | null | undefined): string | null {
  const runtime = meta?.browser?.runtime ?? {};
  const config = meta?.browser?.config ?? {};
  const options = meta?.options?.browserConfig ?? {};
  return (
    runtime.userDataDir ??
    runtime.chromeProfileRoot ??
    config.manualLoginProfileDir ??
    options.manualLoginProfileDir ??
    null
  );
}

export function resolveBrowserProfileLabelForTest(
  meta: SessionMetadata | null | undefined,
): string | null {
  return resolveBrowserProfileLabel(meta);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolvePidStatus(pid: unknown): { pid: number; alive: boolean; label: string } | null {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  const normalizedPid = Math.trunc(pid);
  const alive = isPidAlive(normalizedPid);
  return {
    pid: normalizedPid,
    alive,
    label: `${normalizedPid}(${alive ? "alive" : "dead"})`,
  };
}

function formatPidStatus(
  label: string,
  status: ReturnType<typeof resolvePidStatus>,
): string | null {
  return status ? `${label}=${status.label}` : null;
}

function isChatGptRootUrl(url: string | null | undefined): boolean {
  const value = String(url ?? "").trim();
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      (host === "chatgpt.com" || host === "chat.openai.com") &&
      (parsed.pathname === "" || parsed.pathname === "/")
    );
  } catch {
    return false;
  }
}

function isUnsavedRootConversationTab(
  tab: Pick<
    ChatGptTabSummary,
    | "url"
    | "stopExists"
    | "thinkingActive"
    | "assistantCount"
    | "lastUserSnippet"
    | "lastAssistantSnippet"
  >,
): boolean {
  return Boolean(
    isChatGptRootUrl(tab.url) &&
    (tab.stopExists ||
      tab.thinkingActive ||
      tab.assistantCount > 0 ||
      tab.lastUserSnippet ||
      tab.lastAssistantSnippet),
  );
}

function formatTabEvidence(
  tab: Pick<
    ChatGptTabSummary,
    | "url"
    | "stopExists"
    | "thinkingActive"
    | "completionVisible"
    | "assistantCount"
    | "lastUserSnippet"
    | "lastAssistantSnippet"
    | "reasoningUiState"
    | "reasoningDowngradeSuspected"
    | "error"
  >,
): string | null {
  const evidence: string[] = [];
  if (tab.error) {
    evidence.push("visible-chatgpt-error");
  }
  if (isUnsavedRootConversationTab(tab)) {
    evidence.push("root-url");
  }
  if (tab.stopExists) {
    evidence.push("visible-stop-button");
  }
  if (tab.thinkingActive && !tab.completionVisible) {
    evidence.push("response-progress-active");
  }
  if (tab.assistantCount > 0) {
    evidence.push(`assistant-turns=${tab.assistantCount}`);
  }
  if (tab.lastUserSnippet) {
    evidence.push("last-user-present");
  }
  if (tab.lastAssistantSnippet) {
    evidence.push("last-assistant-present");
  }
  if (tab.reasoningUiState === "complete") {
    evidence.push("reasoning-ui-complete");
  } else if (tab.reasoningUiState === "active") {
    evidence.push("reasoning-ui-active");
  } else if (tab.reasoningDowngradeSuspected || tab.reasoningUiState === "missing") {
    evidence.push("reasoning-ui-missing");
  }
  return evidence.length > 0 ? evidence.join(",") : null;
}

function formatReasoningUiSignal(
  tab: Pick<ChatGptTabSummary, "reasoningUiState" | "reasoningDowngradeSuspected">,
): string | null {
  if (!tab.reasoningUiState && !tab.reasoningDowngradeSuspected) {
    return null;
  }
  const state = tab.reasoningUiState ?? "unknown";
  const parts = [`reasoningUi=${state}`];
  if (tab.reasoningDowngradeSuspected) {
    parts.push("downgrade=suspect");
  }
  return parts.join(" ");
}

function formatReasoningUiDetail(
  tab: Pick<
    ChatGptTabSummary,
    "reasoningUiState" | "reasoningUiText" | "reasoningUiEvidence" | "reasoningDowngradeSuspected"
  >,
): string | null {
  if (!tab.reasoningUiState && !tab.reasoningDowngradeSuspected) {
    return null;
  }
  const state = tab.reasoningUiState ?? "unknown";
  const text = snippet(tab.reasoningUiText ?? "", 100);
  const evidence = Array.isArray(tab.reasoningUiEvidence)
    ? tab.reasoningUiEvidence.filter(Boolean).join(",")
    : "";
  const suffix = tab.reasoningDowngradeSuspected ? " downgrade=suspect" : "";
  const evidenceSuffix = evidence ? ` evidence=${evidence}` : "";
  return text
    ? `${state} (${text})${suffix}${evidenceSuffix}`
    : `${state}${suffix}${evidenceSuffix}`;
}

function resolveBrowserRuntimeLabel(
  meta: SessionMetadata | null | undefined,
  tab?: Pick<
    ChatGptTabSummary,
    | "state"
    | "blocker"
    | "stopExists"
    | "thinkingActive"
    | "reasoningUiState"
    | "reasoningDowngradeSuspected"
    | "completionVisible"
    | "authenticated"
    | "sendExists"
    | "promptReady"
    | "assistantCount"
  >,
): string | null {
  if (!meta) {
    return null;
  }
  const runtime = meta.browser?.runtime ?? {};
  const controllerPid = resolvePidStatus(runtime.controllerPid);
  const chromePid = resolvePidStatus(runtime.chromePid);
  const staleRunningStatus = Boolean(
    meta.status === "running" &&
    tab &&
    !isBrowserTabActive(tab) &&
    controllerPid &&
    !controllerPid.alive,
  );
  const parts = [
    meta.status ? `status=${meta.status}${staleRunningStatus ? "(stale)" : ""}` : null,
    tab ? "cdp=reachable" : null,
    formatPidStatus("controllerPid", controllerPid),
    formatPidStatus("chromePid", chromePid),
    meta.startedAt ? `startedAt=${meta.startedAt}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function resolveBrowserRuntimeLabelForTest(
  meta: SessionMetadata | null | undefined,
  tab?: Parameters<typeof resolveBrowserRuntimeLabel>[1],
): string | null {
  return resolveBrowserRuntimeLabel(meta, tab);
}

function deriveLiveTailState(
  harvested: Pick<
    ChatGptTabSummary,
    "blocker" | "stopExists" | "thinkingActive" | "completionVisible" | "authenticated"
  >,
  unchangedSince: number,
  stallThresholdMs: number,
  fullText = "",
  completionStableMs = DEFAULT_COMPLETION_STABLE_MS,
  activeClearedSince = unchangedSince,
): BrowserHarvestState {
  if (harvested.blocker) {
    return "blocked";
  }
  if (harvested.stopExists) {
    return "running";
  }
  if (
    harvested.thinkingActive &&
    !harvested.completionVisible &&
    !isLowSignalAssistantSnippet(fullText)
  ) {
    return "running";
  }
  if (harvested.authenticated && harvested.completionVisible) {
    const stableSince = Math.max(unchangedSince, activeClearedSince);
    const stableForMs = Date.now() - stableSince;
    if (isLowSignalAssistantSnippet(fullText)) {
      return stableForMs >= stallThresholdMs ? "stalled" : "running";
    }
    if (stableForMs < completionStableMs) {
      return "running";
    }
    return "completed";
  }
  return Date.now() - unchangedSince >= stallThresholdMs ? "stalled" : "detached";
}

export function deriveLiveTailStateForTest(
  harvested: Pick<
    ChatGptTabSummary,
    "blocker" | "stopExists" | "thinkingActive" | "completionVisible" | "authenticated"
  >,
  unchangedSince: number,
  stallThresholdMs: number,
  fullText?: string,
  completionStableMs?: number,
  activeClearedSince?: number,
): BrowserHarvestState {
  return deriveLiveTailState(
    harvested,
    unchangedSince,
    stallThresholdMs,
    fullText,
    completionStableMs,
    activeClearedSince,
  );
}

function isBrowserTabActive(
  tab: Pick<
    ChatGptTabSummary,
    | "state"
    | "blocker"
    | "stopExists"
    | "thinkingActive"
    | "reasoningUiState"
    | "reasoningDowngradeSuspected"
    | "completionVisible"
    | "authenticated"
    | "sendExists"
    | "promptReady"
    | "assistantCount"
  >,
): boolean {
  if (tab.blocker) {
    return false;
  }
  const hasAssistantActivity = tab.assistantCount > 0;
  const thinkingActive =
    tab.stopExists || (tab.thinkingActive && !tab.completionVisible && hasAssistantActivity);
  return (
    tab.stopExists ||
    thinkingActive ||
    (formatBrowserTabState(tab) === "running" && !tab.completionVisible && hasAssistantActivity)
  );
}

export function isBrowserTabActiveForTest(
  tab: Pick<
    ChatGptTabSummary,
    | "state"
    | "blocker"
    | "stopExists"
    | "thinkingActive"
    | "reasoningUiState"
    | "reasoningDowngradeSuspected"
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
    | "blocker"
    | "stopExists"
    | "thinkingActive"
    | "reasoningUiState"
    | "reasoningDowngradeSuspected"
    | "completionVisible"
    | "authenticated"
    | "sendExists"
    | "promptReady"
    | "assistantCount"
  >,
): string {
  const hasAssistantActivity = tab.assistantCount > 0;
  const thinkingActive =
    tab.stopExists || (tab.thinkingActive && !tab.completionVisible && hasAssistantActivity);
  const parts = [
    `active=${isBrowserTabActive(tab) ? "yes" : "no"}`,
    `stop=${tab.stopExists ? "yes" : "no"}`,
    `progress=${thinkingActive ? "yes" : "no"}`,
    `completeUi=${tab.completionVisible ? "yes" : "no"}`,
    `send=${tab.sendExists ? "yes" : "no"}`,
  ];
  const reasoningSignal = formatReasoningUiSignal(tab);
  if (reasoningSignal) {
    parts.push(reasoningSignal);
  }
  if (tab.blocker) {
    parts.push(`blocker=${tab.blocker}`);
  }
  return parts.join(" ");
}

export function formatBrowserSignalsForTest(
  tab: Pick<
    ChatGptTabSummary,
    | "state"
    | "blocker"
    | "stopExists"
    | "thinkingActive"
    | "reasoningUiState"
    | "reasoningDowngradeSuspected"
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
      blocker: harvested.blocker,
      stopExists: harvested.stopExists,
      thinkingActive: harvested.thinkingActive,
      reasoningUiState: harvested.reasoningUiState,
      reasoningUiText: harvested.reasoningUiText,
      reasoningUiEvidence: harvested.reasoningUiEvidence,
      reasoningDowngradeSuspected: harvested.reasoningDowngradeSuspected,
      deepResearchStopExists: harvested.deepResearchStopExists,
      deepResearchActive: harvested.deepResearchActive,
      completionVisible: harvested.completionVisible,
      sendExists: harvested.sendExists,
      assistantCount: harvested.assistantCount,
      currentModelLabel: harvested.currentModelLabel,
      firstAssistantSnippet: harvested.firstAssistantSnippet,
      openingLine: harvested.openingLine,
      lastAssistantSnippet: harvested.lastAssistantSnippet,
      lastUserSnippet: harvested.lastUserSnippet,
      error: harvested.error,
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
  const reasoningDetail = formatReasoningUiDetail(harvested);
  if (reasoningDetail) {
    lines.push(`Reasoning UI: ${reasoningDetail}`);
  }
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
  if (harvested.error) {
    lines.push(`Error: ${snippet(harvested.error)}`);
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
  } else if (isUnsavedRootConversationTab(tab)) {
    lines.push("  conversation=(unsaved root tab)");
  }
  if (linkedSession) {
    lines.push(`  session=${linkedSession.id}`);
    const ownerLabel = resolveBrowserOwnerLabel(linkedSession);
    if (ownerLabel) {
      lines.push(`  owner=${ownerLabel}`);
    }
    const profileLabel = resolveBrowserProfileLabel(linkedSession);
    if (profileLabel) {
      lines.push(`  profile=${profileLabel}`);
    }
    const runtimeLabel = resolveBrowserRuntimeLabel(linkedSession, tab);
    if (runtimeLabel) {
      lines.push(`  runtime=${runtimeLabel}`);
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
  if (tab.error || harvest?.error) {
    lines.push(`  error=${snippet(tab.error || harvest?.error || "")}`);
  }
  const showActivityDetails = isBrowserTabActive(tab) || isUnsavedRootConversationTab(tab);
  const lastUserSnippet = chooseAssistantSnippet(tab.lastUserSnippet, harvest?.lastUserSnippet);
  if (showActivityDetails && lastUserSnippet) {
    lines.push(`  lastUser=${lastUserSnippet}`);
  }
  const evidence = showActivityDetails ? formatTabEvidence(tab) : null;
  if (evidence) {
    lines.push(`  evidence=${evidence}`);
  }
  const reasoningDetail = formatReasoningUiDetail(tab);
  if (reasoningDetail) {
    lines.push(`  reasoning=${reasoningDetail}`);
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
  options: { allowLowSignal?: boolean } = {},
): Promise<void> {
  const resolved = resolveOutputPath(pathInput, cwd);
  if (!resolved) {
    return;
  }
  const payload = content ?? "";
  if (!options.allowLowSignal && isLowSignalAssistantSnippet(payload)) {
    console.log(chalk.dim("write-output skipped: harvested assistant output appears incomplete."));
    return;
  }
  if (isVisibleChatGptErrorOutput(payload)) {
    console.log(chalk.dim("write-output skipped: harvested assistant output is a ChatGPT error."));
    return;
  }
  if (resolved === "-" || resolved === "/dev/stdout") {
    process.stdout.write(`${payload}${payload.endsWith("\n") ? "" : "\n"}`);
    return;
  }
  await fs.writeFile(resolved, payload, "utf8");
  console.log(chalk.dim(`Wrote harvested assistant output to ${resolved}`));
}

function isVisibleChatGptErrorOutput(content: string): boolean {
  return hasHardVisibleChatGptErrorText(content);
}

function isDowngradeSuspectHarvest(harvested: ChatGptTabSummary): boolean {
  return harvested.reasoningDowngradeSuspected === true;
}

function outputForHarvest(harvested: ChatGptTabSummary): string {
  const output = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
  if (
    harvested.blocker === "chatgpt-visible-error" ||
    isVisibleChatGptErrorOutput(output) ||
    isDowngradeSuspectHarvest(harvested)
  ) {
    return "";
  }
  return output;
}

export function outputForHarvestForTest(harvested: ChatGptTabSummary): string {
  return outputForHarvest(harvested);
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
  const endpoint = options.browserEndpoint ??
    sessionBrowserEndpoint(meta) ?? {
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
  const output = outputForHarvest(harvested);
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
  const endpoint = options.browserEndpoint ??
    sessionBrowserEndpoint(meta) ?? {
      host: DEFAULT_REMOTE_CHROME_HOST,
      port: DEFAULT_REMOTE_CHROME_PORT,
    };
  const browserTabRef = options.browserTabRef ?? resolveSessionTabRef(meta);
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  let lastHash: string | null = null;
  let unchangedSince = Date.now();
  let activeClearedSince = Date.now();

  while (true) {
    const harvested = await harvestChatGptTab({
      host: endpoint.host,
      port: endpoint.port,
      ref: browserTabRef,
    });
    if (harvested.stopExists || harvested.thinkingActive) {
      activeClearedSince = Date.now();
    }
    const fullText = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
    const hash = createHash("sha1").update(fullText).digest("hex");
    if (hash !== lastHash) {
      lastHash = hash;
      unchangedSince = Date.now();
      const statusLine = formatLiveTailStatusLine(sessionId, meta, harvested, new Date(), fullText);
      console.log(statusLine);
      await persistHarvest(sessionId, meta, harvested);
    }

    const derivedState = deriveLiveTailState(
      harvested,
      unchangedSince,
      stallThresholdMs,
      fullText,
      DEFAULT_COMPLETION_STABLE_MS,
      activeClearedSince,
    );

    if (
      derivedState === "completed" ||
      derivedState === "stalled" ||
      derivedState === "detached" ||
      derivedState === "blocked"
    ) {
      const finalHarvest: ChatGptTabSummary = {
        ...harvested,
        state: derivedState,
      };
      await persistHarvest(sessionId, meta, finalHarvest);
      printHarvestSummary(sessionId, finalHarvest, resolveBrowserOwner(meta));
      const output = outputForHarvest(finalHarvest);
      if (options.writeOutputPath) {
        await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output, {
          allowLowSignal: derivedState === "completed",
        });
      }
      if (output && !isLowSignalAssistantSnippet(output)) {
        process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
      }
      return finalHarvest;
    }

    await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
  }
}
