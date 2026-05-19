import CDP from "chrome-remote-interface";
import { createHash } from "node:crypto";
import type { SessionMetadata, BrowserHarvestState } from "../sessionStore.js";
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
  INPUT_SELECTORS,
  MODEL_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTORS,
} from "./constants.js";
import { captureAssistantMarkdown, readAssistantSnapshot } from "./actions/assistantResponse.js";
import { buildVisibleStopButtonFunction } from "./actions/stopButton.js";
import { delay } from "./utils.js";

export const DEFAULT_REMOTE_CHROME_HOST = "127.0.0.1";
export const DEFAULT_REMOTE_CHROME_PORT = 9222;

const LOGIN_CTA_PATTERN =
  /\b(log in|login|sign up|sign in|continue with google|continue with microsoft)\b/i;

interface ChromeTarget {
  id?: string;
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
}

interface HostPort {
  host?: string;
  port?: number;
}

export interface ChatGptTabSummary {
  host?: string;
  port?: number;
  targetId: string;
  title: string;
  url: string;
  currentModelLabel: string;
  stopExists: boolean;
  thinkingActive: boolean;
  completionVisible: boolean;
  sendExists: boolean;
  promptReady: boolean;
  loginButtonExists: boolean;
  authenticated: boolean;
  assistantCount: number;
  firstAssistantText: string;
  firstAssistantSnippet: string;
  openingLine: string;
  lastAssistantText: string;
  lastAssistantSnippet: string;
  lastUserText: string;
  lastUserSnippet: string;
  focused: boolean;
  visibilityState: string;
  conversationId?: string;
  fingerprint: string;
  state: BrowserHarvestState;
  blocker?: string;
  deepResearchStopExists?: boolean;
  deepResearchActive?: boolean;
  deepResearchResultText?: string;
  error?: string;
  lastAssistantMarkdown: string | null;
  lastAssistantMessageId?: string;
  lastAssistantTurnId?: string;
}

interface ResolveChatGptTabOptions extends HostPort {
  ref?: string;
}

interface InspectChatGptTabOptions extends HostPort {
  target: ChromeTarget;
}

interface HarvestChatGptTabOptions extends ResolveChatGptTabOptions {
  target?: ChromeTarget;
  stallWindowMs?: number;
}

const noopLogger = Object.assign((_message: string) => {}, {}) as ((message: string) => void) & {
  verbose?: boolean;
};

function trimToSnippet(text: string, max = 140): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function resolveAssistantSnippetText(text: string, markdown: string | null | undefined): string {
  const normalizedText = String(text ?? "").trim();
  const normalizedMarkdown = String(markdown ?? "").trim();
  if (!normalizedMarkdown) {
    return normalizedText;
  }
  if (!normalizedText) {
    return normalizedMarkdown;
  }
  // Copy-button markdown is more reliable than the lightweight DOM snapshot.
  // Completed ChatGPT tabs can expose a short UI/partial node such as "I".
  if (normalizedMarkdown.length >= normalizedText.length + 20) {
    return normalizedMarkdown;
  }
  return normalizedText;
}

export function resolveAssistantSnippetTextForTest(
  text: string,
  markdown: string | null | undefined,
): string {
  return resolveAssistantSnippetText(text, markdown);
}

function firstNonEmptyLine(text: string): string {
  for (const line of String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function isLowSignalAssistantText(text: string | null | undefined): boolean {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized.length <= 2 ||
    normalized === "the" ||
    normalized === "chatgpt said:" ||
    normalized === "chatgpt said" ||
    normalized === "called tool" ||
    normalized === "used tool"
  );
}

function shouldPreferDeepResearchResult(
  currentText: string | null | undefined,
  deepResearchText: string | null | undefined,
): boolean {
  const deepText = String(deepResearchText ?? "").trim();
  if (deepText.length < 40) {
    return false;
  }
  const current = String(currentText ?? "").trim();
  return isLowSignalAssistantText(current) || deepText.length >= current.length + 20;
}

export function shouldPreferDeepResearchResultForTest(
  currentText: string | null | undefined,
  deepResearchText: string | null | undefined,
): boolean {
  return shouldPreferDeepResearchResult(currentText, deepResearchText);
}

function normalizeHostPort(input: HostPort = {}): Required<HostPort> {
  return {
    host: input.host ?? DEFAULT_REMOTE_CHROME_HOST,
    port: input.port ?? DEFAULT_REMOTE_CHROME_PORT,
  };
}

function normalizeUrl(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeTitle(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTargetFingerprint(
  summary: Pick<ChatGptTabSummary, "targetId" | "url" | "lastAssistantText">,
): string {
  return createHash("sha1")
    .update(`${summary.targetId ?? ""}|${summary.url ?? ""}|${summary.lastAssistantText ?? ""}`)
    .digest("hex");
}

function isChatGptUrl(url: string): boolean {
  const normalized = normalizeUrl(url).toLowerCase();
  return (
    normalized.startsWith("https://chatgpt.com") || normalized.startsWith("https://chat.openai.com")
  );
}

function isChatGptConversationUrl(url: string): boolean {
  return /\/c\//.test(normalizeUrl(url));
}

function isChatGptTarget(target: ChromeTarget): boolean {
  if (!target || target.type !== "page") {
    return false;
  }
  return isChatGptUrl(target.url ?? "") || /chatgpt/i.test(target.title ?? "");
}

function extractTargetId(target: ChromeTarget | undefined | null): string | null {
  return target?.targetId ?? target?.id ?? null;
}

function escapeLiteral(value: string): string {
  return JSON.stringify(value);
}

function buildTabInspectionExpression(): string {
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const sendSelectorsLiteral = JSON.stringify(SEND_BUTTON_SELECTORS);
  const answerSelectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  const turnSelectorLiteral = escapeLiteral(CONVERSATION_TURN_SELECTOR);
  const assistantRoleLiteral = escapeLiteral(ASSISTANT_ROLE_SELECTOR);
  const finishedActionsLiteral = escapeLiteral(FINISHED_ACTIONS_SELECTOR);
  const modelButtonSelectorLiteral = escapeLiteral(MODEL_BUTTON_SELECTOR);
  return `(() => {
      const INPUT_SELECTORS = ${inputSelectorsLiteral};
      const SEND_SELECTORS = ${sendSelectorsLiteral};
      const ANSWER_SELECTORS = ${answerSelectorsLiteral};
      const TURN_SELECTOR = ${turnSelectorLiteral};
      const ASSISTANT_ROLE_SELECTOR = ${assistantRoleLiteral};
      const FINISHED_SELECTOR = ${finishedActionsLiteral};
      const MODEL_BUTTON_SELECTOR = ${modelButtonSelectorLiteral};
      ${buildVisibleStopButtonFunction("hasVisibleStopButton")}
      const LOGIN_CTA = ${LOGIN_CTA_PATTERN.toString()};
      const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const normalizeLower = (value) => normalize(value).toLowerCase();
      const isProgressOnlyText = (value) =>
        [
          'finalizing answer',
          'finalising answer',
          'thinking',
          'pro thinking',
          'reasoning',
          'working',
          'reading documents',
          'reading document',
        ].includes(normalizeLower(value));
      const readNodeText = (node) => {
        const inner = typeof node?.innerText === 'string' ? node.innerText : '';
        if (inner.trim().length > 0) return inner;
        return String(node?.textContent ?? '');
      };
      const firstNonEmptyLine = (value) => {
        const lines = String(value ?? '').replace(/\\r\\n?/g, '\\n').split('\\n');
        for (const line of lines) {
          const normalized = normalize(line);
          if (normalized) return normalized;
        }
        return '';
      };
      const isVisible = (node) => {
        if (!(node instanceof Element)) return false;
        const style = window.getComputedStyle(node);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const firstVisible = (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && isVisible(node)) return node;
        }
        return null;
      };
      const loginButtonExists = Array.from(document.querySelectorAll('button,a,[role="button"]')).some((node) => {
        const label = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title'));
        return LOGIN_CTA.test(label);
      });
      const pageText = normalizeLower(document.body?.innerText || '');
      const loginExpired = Boolean(
        document.querySelector('[data-testid*="expired-session"], [id*="expired-session"], [class*="expired-session"]'),
      ) || (
        pageText.includes('your session has expired') &&
        (pageText.includes('log in') || pageText.includes('login') || pageText.includes('sign in'))
      );
      const accountBlocked = pageText.includes('suspicious activity detected') &&
        pageText.includes('secure your account') &&
        pageText.includes('regain access');
      const blocker = loginExpired ? 'login-expired' : accountBlocked ? 'account-blocked' : '';
      const mainStopExists = hasVisibleStopButton();
      const sendButton = firstVisible(SEND_SELECTORS);
      const sendExists = Boolean(sendButton);
      const promptNode = firstVisible(INPUT_SELECTORS);
      const promptReady = Boolean(promptNode);
      const turns = Array.from(document.querySelectorAll(TURN_SELECTOR));
      const assistantTurns = turns.filter((turn) => {
        const role = normalize(turn.getAttribute('data-message-author-role') || turn.getAttribute('data-turn')).toLowerCase();
        if (role === 'assistant') return true;
        return Boolean(turn.querySelector(ASSISTANT_ROLE_SELECTOR));
      });
      const lastAssistantTurn = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null;
      const userTurns = turns.filter((turn) => {
        const role = normalize(turn.getAttribute('data-message-author-role') || turn.getAttribute('data-turn')).toLowerCase();
        return role === 'user';
      });
      const isCompletionActionNearAssistantTurn = (button, turn) => {
        if (!(button instanceof HTMLElement) || !(turn instanceof HTMLElement)) return false;
        if (!isVisible(button)) return false;
        if (button.closest('nav, aside, form, [data-testid*="sidebar"], [data-testid*="composer"]')) {
          return false;
        }
        if (turn.contains(button)) return true;
        const turnRoot = turn.closest('article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"]');
        if (turnRoot?.contains(button)) return true;
        const messageRoot = turn.closest('[data-message-id], [data-testid^="conversation-turn"]');
        if (messageRoot?.contains(button)) return true;
        const relation = turn.compareDocumentPosition(button);
        if ((relation & Node.DOCUMENT_POSITION_FOLLOWING) === 0) return false;
        const turnRect = turn.getBoundingClientRect();
        const actionRect = button.getBoundingClientRect();
        if (!turnRect || !actionRect) return false;
        return actionRect.top >= turnRect.top - 24 && actionRect.top <= turnRect.bottom + 260;
      };
      const hasThinkingIndicator = () => {
        const nodes = Array.from(
          document.querySelectorAll(
            [
              '[data-testid*="thinking"]',
              '[data-testid*="reasoning"]',
              '[role="status"]',
              '[aria-live="polite"]',
              'span.loading-shimmer',
            ].join(','),
          ),
        );
        return nodes.some((node) => {
          if (!isVisible(node)) return false;
          const label = normalizeLower([
            node.textContent,
            node.getAttribute?.('aria-label'),
            node.getAttribute?.('title'),
            node.getAttribute?.('data-testid'),
          ].filter(Boolean).join(' '));
          return (
            label.includes('thinking') ||
            label.includes('reasoning') ||
            label.includes('pro thinking') ||
            label.includes('finalizing answer') ||
            label.includes('finalising answer') ||
            label.includes('reading documents')
          );
        });
      };
      const hasCompletionUi = () => {
        if (!lastAssistantTurn) return false;
        const actionButtons = Array.from(document.querySelectorAll(FINISHED_SELECTOR));
        if (actionButtons.some((button) => isCompletionActionNearAssistantTurn(button, lastAssistantTurn))) {
          return true;
        }
        const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
        return Array.from(markdowns).some((node) => normalize(node.textContent) === 'Done');
      };
      const hasLargeDeepResearchFrame = () =>
        Array.from(document.querySelectorAll('iframe')).some((frame) => {
          if (!isVisible(frame)) return false;
          const rect = frame.getBoundingClientRect();
          const label = normalizeLower([
            frame.getAttribute('src'),
            frame.getAttribute('title'),
            frame.getAttribute('name'),
          ].filter(Boolean).join(' '));
          return (
            rect.width > 200 &&
            rect.height > 160 &&
            (
              label.includes('deep-research') ||
              label.includes('deep research') ||
              label.includes('connector_openai_deep_research') ||
              label.includes('internal://deep-research')
            )
          );
        });
      const answerNode = ANSWER_SELECTORS
        .map((selector) => document.querySelectorAll(selector))
        .find((matches) => matches && matches.length > 0);
      const currentModelButton = document.querySelector(MODEL_BUTTON_SELECTOR);
      const hasProSignal = (value) => {
        const label = normalize(value).toLowerCase();
        return (
          label === 'pro' ||
          label.includes(' pro') ||
          label.startsWith('pro ') ||
          label.includes('extended') ||
          label.includes('专业') ||
          label.includes('进阶')
        );
      };
      const hasProPill = Array.from(
        document.querySelectorAll('button.__composer-pill, button[aria-label="Pro, click to remove"], button[aria-label*="Pro, click"]'),
      ).some((node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
        const label = [
          node.getAttribute('aria-label') || '',
          node.getAttribute('title') || '',
          node.textContent || '',
        ].join(' ');
        if (!hasProSignal(label)) return false;
        if (node.matches(MODEL_BUTTON_SELECTOR)) {
          return hasProSignal(node.textContent || node.getAttribute('aria-label') || '');
        }
        return true;
      });
      let currentModelLabel = normalize(currentModelButton?.textContent || currentModelButton?.getAttribute?.('aria-label') || '');
      if (currentModelLabel === 'ChatGPT' && hasProPill) {
        currentModelLabel = 'ChatGPT + Pro';
      }
      const assistantRawTexts = assistantTurns.map(readNodeText).filter((text) => normalize(text));
      const assistantTexts = assistantRawTexts.map(normalize).filter(Boolean);
      const userTexts = userTurns
        .map((node) => normalize(readNodeText(node)))
        .filter(Boolean);
      const answerRawTexts = Array.from(answerNode || []).map(readNodeText).filter((text) => normalize(text));
      const answerTexts = answerRawTexts.map(normalize).filter(Boolean);
      const assistantCount = assistantTurns.length > 0 ? assistantTurns.length : answerTexts.length;
      const firstAssistantRawText = assistantRawTexts[0] || answerRawTexts[0] || '';
      const firstAssistantText = String(firstAssistantRawText || '').trim();
      const openingLine = firstNonEmptyLine(firstAssistantRawText);
      const lastAssistantText = assistantTexts[assistantTexts.length - 1] || answerTexts[answerTexts.length - 1] || '';
      const lastUserText = userTexts[userTexts.length - 1] || '';
      const completionVisible = hasCompletionUi();
      const deepResearchFrameActive = hasLargeDeepResearchFrame() && !completionVisible;
      const stopExists = mainStopExists || deepResearchFrameActive;
      const thinkingActive =
        stopExists || deepResearchFrameActive || isProgressOnlyText(lastAssistantText) || hasThinkingIndicator();
      const authenticated = !blocker && !loginButtonExists && (promptReady || sendExists || stopExists || assistantCount > 0);
      return {
        title: normalize(document.title),
        url: location.href,
        currentModelLabel,
        stopExists,
        thinkingActive,
        completionVisible,
        sendExists,
        promptReady,
        loginButtonExists,
        authenticated,
        assistantCount,
        firstAssistantText,
        openingLine,
        lastAssistantText,
        lastUserText,
        visibilityState: document.visibilityState,
        focused: Boolean(document.hasFocus?.()),
        blocker,
        deepResearchStopExists: false,
        deepResearchActive: deepResearchFrameActive,
      };
    })()`;
}

export function buildTabInspectionExpressionForTest(): string {
  return buildTabInspectionExpression();
}

interface DeepResearchLiveSignals {
  stopExists: boolean;
  active: boolean;
  completed: boolean;
  textLength: number;
  text?: string;
  html?: string;
}

interface DeepResearchTargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
  title?: string;
  parentFrameId?: string;
  openerId?: string;
}

interface DeepResearchFrameTree {
  frame?: { id?: string; url?: string; name?: string };
  childFrames?: DeepResearchFrameTree[];
}

type RawCdpClient = Awaited<ReturnType<typeof CDP>> & {
  send?: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<unknown>;
};
type RawCdpSendClient = Awaited<ReturnType<typeof CDP>> & {
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<unknown>;
};

function isDeepResearchTargetInfo(target: DeepResearchTargetInfo): boolean {
  const label = `${target.url ?? ""} ${target.title ?? ""}`.toLowerCase();
  return (
    label.includes("connector_openai_deep_research") ||
    label.includes("internal://deep-research") ||
    label.includes("deep-research") ||
    label.includes("deep research")
  );
}

function collectFrameIds(tree: DeepResearchFrameTree | undefined): string[] {
  if (!tree?.frame) {
    return [];
  }
  const ids = tree.frame.id ? [tree.frame.id] : [];
  for (const child of tree.childFrames ?? []) {
    ids.push(...collectFrameIds(child));
  }
  return ids;
}

function collectDeepResearchFrameIds(tree: DeepResearchFrameTree | undefined): string[] {
  if (!tree?.frame) {
    return [];
  }
  const ids: string[] = [];
  const label = `${tree.frame.url ?? ""} ${tree.frame.name ?? ""}`.toLowerCase();
  if (
    label.includes("connector_openai_deep_research") ||
    label.includes("internal://deep-research") ||
    label.includes("deep-research") ||
    label.includes("deep research")
  ) {
    if (tree.frame.id) {
      ids.push(tree.frame.id);
    }
  }
  for (const child of tree.childFrames ?? []) {
    ids.push(...collectDeepResearchFrameIds(child));
  }
  return ids;
}

function mergeDeepResearchSignals(
  left: DeepResearchLiveSignals | null,
  right: DeepResearchLiveSignals | null,
): DeepResearchLiveSignals | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return {
    stopExists: left.stopExists || right.stopExists,
    active: left.active || right.active,
    completed: left.completed || right.completed,
    textLength: Math.max(left.textLength, right.textLength),
    text:
      (right.text?.length ?? 0) > (left.text?.length ?? 0)
        ? right.text
        : left.text,
    html:
      (right.text?.length ?? 0) > (left.text?.length ?? 0)
        ? right.html
        : left.html,
  };
}

async function inspectDeepResearchLiveSignals(
  client: Awaited<ReturnType<typeof CDP>>,
  parentTargetId: string,
): Promise<DeepResearchLiveSignals | null> {
  const maybeRawClient = client as RawCdpClient;
  if (typeof maybeRawClient.send !== "function") {
    return null;
  }
  const rawClient = maybeRawClient as RawCdpSendClient;

  let best = await inspectCurrentPageDeepResearchFrames(rawClient);
  if (best?.stopExists) {
    return best;
  }

  const targets = (await rawClient.send("Target.getTargets", {}).catch(() => null)) as
    | { targetInfos?: DeepResearchTargetInfo[] }
    | null;
  for (const target of targets?.targetInfos ?? []) {
    const scopedToCurrentTab =
      target.parentFrameId === parentTargetId || target.openerId === parentTargetId;
    if (!target.targetId || !scopedToCurrentTab || !isDeepResearchTargetInfo(target)) {
      continue;
    }
    const attached = (await rawClient
      .send("Target.attachToTarget", { targetId: target.targetId, flatten: true })
      .catch(() => null)) as { sessionId?: string } | null;
    if (!attached?.sessionId) {
      continue;
    }
    try {
      const signal = await inspectDeepResearchSession(rawClient, attached.sessionId);
      best = mergeDeepResearchSignals(best, signal);
      if (best?.stopExists) {
        return best;
      }
    } finally {
      await rawClient
        .send("Target.detachFromTarget", { sessionId: attached.sessionId })
        .catch(() => undefined);
    }
  }
  return best;
}

async function inspectCurrentPageDeepResearchFrames(
  rawClient: RawCdpSendClient,
): Promise<DeepResearchLiveSignals | null> {
  await rawClient.send("Page.enable", {}).catch(() => undefined);
  const frameTree = (await rawClient
    .send("Page.getFrameTree", {})
    .catch(() => null)) as { frameTree?: DeepResearchFrameTree } | null;
  let best: DeepResearchLiveSignals | null = null;
  for (const frameId of collectDeepResearchFrameIds(frameTree?.frameTree)) {
    const world = (await rawClient
      .send("Page.createIsolatedWorld", {
        frameId,
        worldName: "oracle-live-deep-research-status",
        grantUniveralAccess: true,
      })
      .catch(() => null)) as { executionContextId?: number } | null;
    if (typeof world?.executionContextId !== "number") {
      continue;
    }
    const signal = await evaluateDeepResearchLiveSignals(rawClient, undefined, world.executionContextId);
    best = mergeDeepResearchSignals(best, signal);
    if (best?.stopExists) {
      return best;
    }
  }
  return best;
}

async function inspectDeepResearchSession(
  rawClient: RawCdpSendClient,
  sessionId: string,
): Promise<DeepResearchLiveSignals | null> {
  await rawClient.send("Runtime.enable", {}, sessionId).catch(() => undefined);
  await rawClient.send("Page.enable", {}, sessionId).catch(() => undefined);

  let best = await evaluateDeepResearchLiveSignals(rawClient, sessionId);
  const frameTree = (await rawClient
    .send("Page.getFrameTree", {}, sessionId)
    .catch(() => null)) as { frameTree?: DeepResearchFrameTree } | null;
  for (const frameId of collectFrameIds(frameTree?.frameTree)) {
    const world = (await rawClient
      .send(
        "Page.createIsolatedWorld",
        {
          frameId,
          worldName: "oracle-live-deep-research-status",
          grantUniveralAccess: true,
        },
        sessionId,
      )
      .catch(() => null)) as { executionContextId?: number } | null;
    if (typeof world?.executionContextId !== "number") {
      continue;
    }
    const signal = await evaluateDeepResearchLiveSignals(rawClient, sessionId, world.executionContextId);
    best = mergeDeepResearchSignals(best, signal);
    if (best?.stopExists) {
      return best;
    }
  }
  return best;
}

async function evaluateDeepResearchLiveSignals(
  rawClient: RawCdpSendClient,
  sessionId?: string,
  contextId?: number,
): Promise<DeepResearchLiveSignals | null> {
  const response = (await rawClient
    .send(
      "Runtime.evaluate",
      {
        expression: buildDeepResearchLiveSignalsExpression(),
        returnByValue: true,
        ...(typeof contextId === "number" ? { contextId } : {}),
      },
      sessionId,
    )
    .catch(() => null)) as { result?: { value?: DeepResearchLiveSignals } } | null;
  return response?.result?.value ?? null;
}

function buildDeepResearchLiveSignalsExpression(): string {
  return `(() => {
    ${buildVisibleStopButtonFunction("hasVisibleStopButton")}
    const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const normalizeLower = (value) => normalize(value).toLowerCase();
    const isVisible = (node) => {
      if (!(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0;
    };
    const rawText = String(document.body?.innerText || '');
    const html = String(document.body?.innerHTML || '');
    const text = normalize(rawText);
    const lowerText = normalizeLower(text);
    const isPlaceholder = (line) => /^(called tool|used tool|użyto narzędzia|narzędzie wywołane)$/i.test(line);
    const isCompletionLine = (line) =>
      /^(research completed|badanie ukończone)\\b/i.test(line);
    const isCounterLine = (line) =>
      /^(\\d+\\s+)?(citation|citations|source|sources|search|searches|cytat|cytaty|cytatów|źródło|źródła|wyszukiwanie|wyszukiwania|wyszukiwań)\\b/i.test(line);
    const normalizeReportText = (value) => {
      let report = String(value || '').replace(/\\r\\n?/g, '\\n').trim();
      report = report.replace(/^\\s*research completed\\b[\\s\\S]{0,2400}?\\bsearches\\b\\s*/i, '');
      const lines = report
        .split(/\\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^\\d+$/.test(line));
      const reportIndex = lines.findIndex((line) => /deep research report/i.test(line));
      const candidates = reportIndex >= 0 ? lines.slice(reportIndex + 1) : lines;
      let started = false;
      const reportLines = candidates.filter((line) => {
        if (!started) {
          if (
            /deep research report/i.test(line) ||
            isCompletionLine(line) ||
            isCounterLine(line) ||
            isPlaceholder(line)
          ) {
            return false;
          }
          started = true;
        }
        return true;
      });
      if (reportLines.length > 1 && reportLines[0] === reportLines[1]) {
        reportLines.shift();
      }
      return reportLines.join('\\n').trim();
    };
    const reportText = normalizeReportText(rawText);
    const completed =
      /\\b(research completed|badanie ukończone)\\b/i.test(rawText) &&
      reportText.length >= 40 &&
      !isPlaceholder(reportText);
    const progressText = !completed && (
      lowerText.includes('researching') ||
      lowerText.includes('searching') ||
      lowerText.includes('searches') ||
      lowerText.includes('looking for') ||
      lowerText.includes('reading') ||
      lowerText.includes('sources') ||
      lowerText.includes('citations') ||
      lowerText.includes('analyzing') ||
      lowerText.includes('analysing')
    );
    const iconOnlyStopExists = progressText && Array.from(document.querySelectorAll('button,[role="button"]')).some((node) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
      const label = normalizeLower([
        node.textContent,
        node.getAttribute('aria-label'),
        node.getAttribute('title'),
        node.getAttribute('data-testid'),
      ].filter(Boolean).join(' '));
      if (/copy|share|close|dismiss|open|menu|download|citation|source/.test(label)) return false;
      if (label && !/\\b(stop|pause|interrupt)\\b|停止|暂停|中止|终止/.test(label)) return false;
      const rect = node.getBoundingClientRect();
      const textOnly = normalize(node.textContent);
      const hasIcon = Boolean(node.querySelector('svg, [class*="icon"]'));
      return textOnly.length === 0 &&
        hasIcon &&
        rect.width >= 16 &&
        rect.width <= 64 &&
        rect.height >= 16 &&
        rect.height <= 64;
    });
    const stopExists = hasVisibleStopButton() || iconOnlyStopExists;
    const active = stopExists || progressText;
    return {
      stopExists,
      active,
      completed,
      textLength: reportText.length || text.length,
      text: completed ? reportText : undefined,
      html: completed ? html : undefined,
    };
  })()`;
}

export async function listChatGptTargets(options: HostPort = {}): Promise<ChromeTarget[]> {
  const { host, port } = normalizeHostPort(options);
  const targets = (await CDP.List({ host, port })) as ChromeTarget[];
  return targets.filter(isChatGptTarget);
}

export async function openChatGptTarget(
  options: HostPort & { url?: string } = {},
): Promise<string> {
  const { host, port } = normalizeHostPort(options);
  const url = options.url ?? "https://chatgpt.com/";
  const target = await CDP.New({ host, port, url });
  return target.id;
}

async function connectToTarget(host: string, port: number, targetId: string) {
  const client = await CDP({ host, port, target: targetId });
  const { Runtime, DOM } = client;
  if (Runtime?.enable) {
    await Runtime.enable();
  }
  if (DOM?.enable) {
    await DOM.enable();
  }
  return client;
}

export async function inspectChatGptTab(
  options: InspectChatGptTabOptions,
): Promise<ChatGptTabSummary> {
  const { host, port } = normalizeHostPort(options);
  const target = options.target;
  const targetId = extractTargetId(target);
  if (!targetId) {
    throw new Error("inspectChatGptTab requires a target with targetId.");
  }

  const client = await connectToTarget(host, port, targetId);
  try {
    const { Runtime } = client;
    const evaluation = await Runtime.evaluate({
      expression: buildTabInspectionExpression(),
      returnByValue: true,
      awaitPromise: true,
    });
    const info = (evaluation.result?.value ?? {}) as {
      title?: string;
      url?: string;
      currentModelLabel?: string;
      stopExists?: boolean;
      thinkingActive?: boolean;
      completionVisible?: boolean;
      sendExists?: boolean;
      promptReady?: boolean;
      loginButtonExists?: boolean;
      authenticated?: boolean;
      assistantCount?: number;
      firstAssistantText?: string;
      openingLine?: string;
      lastAssistantText?: string;
      lastUserText?: string;
      visibilityState?: string;
      focused?: boolean;
      blocker?: string;
      deepResearchStopExists?: boolean;
      deepResearchActive?: boolean;
    };
    const deepResearchSignals = await inspectDeepResearchLiveSignals(client, targetId).catch(
      () => null,
    );
    const snapshot = await readAssistantSnapshot(Runtime).catch(() => null);
    const snapshotText =
      typeof snapshot?.text === "string" && snapshot.text.trim().length > 0
        ? snapshot.text.trim()
        : "";
    const domLastAssistantText = String(info.lastAssistantText ?? "").trim();
    const lastAssistantText =
      snapshotText || domLastAssistantText
        ? resolveAssistantSnippetText(snapshotText, domLastAssistantText)
        : "";
    const firstAssistantText = String(info.firstAssistantText ?? "").trim();
    const openingLine =
      String(info.openingLine ?? "").trim() || firstNonEmptyLine(firstAssistantText);
    const lastUserText = String(info.lastUserText ?? "").trim();
    const blocker = String(info.blocker ?? "").trim() || undefined;
    const deepResearchResultText = String(deepResearchSignals?.text ?? "").trim() || undefined;
    const deepResearchStopExists = Boolean(
      info.deepResearchStopExists || deepResearchSignals?.stopExists,
    );
    const deepResearchActive = Boolean(info.deepResearchActive || deepResearchSignals?.active);
    const stopExists = Boolean(info.stopExists || deepResearchStopExists || deepResearchActive);
    const thinkingActive = Boolean(info.thinkingActive || stopExists || deepResearchActive);
    const effectiveLastAssistantText = shouldPreferDeepResearchResult(
      lastAssistantText,
      deepResearchResultText,
    )
      ? (deepResearchResultText as string)
      : lastAssistantText;
    const summary: ChatGptTabSummary = {
      host,
      port,
      targetId,
      title: normalizeTitle(info.title ?? target.title ?? ""),
      url: normalizeUrl(info.url ?? target.url ?? ""),
      currentModelLabel: normalizeTitle(info.currentModelLabel ?? ""),
      stopExists,
      thinkingActive,
      completionVisible: Boolean(info.completionVisible),
      sendExists: Boolean(info.sendExists),
      promptReady: Boolean(info.promptReady),
      loginButtonExists: Boolean(info.loginButtonExists),
      authenticated: Boolean(!blocker && info.authenticated),
      assistantCount: Number.isFinite(info.assistantCount) ? Number(info.assistantCount) : 0,
      firstAssistantText,
      firstAssistantSnippet: trimToSnippet(firstAssistantText),
      openingLine,
      lastAssistantText: effectiveLastAssistantText,
      lastAssistantSnippet: trimToSnippet(effectiveLastAssistantText),
      lastUserText,
      lastUserSnippet: trimToSnippet(lastUserText),
      focused: Boolean(info.focused),
      visibilityState: typeof info.visibilityState === "string" ? info.visibilityState : "",
      conversationId: extractConversationIdFromUrl(info.url ?? target.url ?? ""),
      fingerprint: "",
      state: "detached",
      blocker,
      deepResearchStopExists,
      deepResearchActive,
      deepResearchResultText,
      lastAssistantMarkdown: null,
      lastAssistantMessageId:
        typeof snapshot?.messageId === "string" ? snapshot.messageId : undefined,
      lastAssistantTurnId: typeof snapshot?.turnId === "string" ? snapshot.turnId : undefined,
    };
    summary.state = classifyTabState(summary);
    summary.fingerprint = buildTargetFingerprint(summary);
    return summary;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function classifyTabState(
  summary: Pick<
    ChatGptTabSummary,
    | "blocker"
    | "authenticated"
    | "stopExists"
    | "thinkingActive"
    | "completionVisible"
    | "sendExists"
    | "promptReady"
    | "assistantCount"
>,
): BrowserHarvestState {
  if (summary?.blocker) {
    return "blocked";
  }
  if (!summary?.authenticated) {
    return "detached";
  }
  if (summary.stopExists || summary.thinkingActive) {
    return "running";
  }
  if (summary.sendExists || summary.promptReady || summary.assistantCount > 0) {
    return "completed";
  }
  return "detached";
}

export async function collectChatGptTabs(options: HostPort = {}): Promise<ChatGptTabSummary[]> {
  const { host, port } = normalizeHostPort(options);
  const targets = await listChatGptTargets({ host, port });
  const summaries: ChatGptTabSummary[] = [];
  for (const target of targets) {
    try {
      const summary = await inspectChatGptTab({ host, port, target });
      summaries.push(summary);
    } catch (error) {
      summaries.push({
        host,
        port,
        targetId: extractTargetId(target) ?? "",
        title: normalizeTitle(target.title ?? ""),
        url: normalizeUrl(target.url ?? ""),
        currentModelLabel: "",
        stopExists: false,
        thinkingActive: false,
        completionVisible: false,
        sendExists: false,
        promptReady: false,
        loginButtonExists: false,
        authenticated: false,
        assistantCount: 0,
        firstAssistantText: "",
        firstAssistantSnippet: "",
        openingLine: "",
        lastAssistantText: "",
        lastAssistantSnippet: "",
        lastUserText: "",
        lastUserSnippet: "",
        focused: false,
        visibilityState: "",
        conversationId: extractConversationIdFromUrl(target.url ?? ""),
        fingerprint: "",
        state: "detached",
        blocker: undefined,
        deepResearchStopExists: false,
        deepResearchActive: false,
        deepResearchResultText: undefined,
        error: error instanceof Error ? error.message : String(error),
        lastAssistantMarkdown: null,
      });
    }
  }
  return summaries.sort((left, right) => {
    const leftScore = (left.focused ? 100 : 0) + (isChatGptConversationUrl(left.url) ? 10 : 0);
    const rightScore = (right.focused ? 100 : 0) + (isChatGptConversationUrl(right.url) ? 10 : 0);
    return rightScore - leftScore;
  });
}

function resolveChatGptTabFromSummaries(
  summaries: ChatGptTabSummary[],
  ref?: string,
): ChatGptTabSummary {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    throw new Error("No live ChatGPT tabs found on the configured Chrome DevTools endpoint.");
  }
  const trimmedRef = String(ref ?? "").trim();
  if (!trimmedRef || trimmedRef.toLowerCase() === "current") {
    return summaries[0] as ChatGptTabSummary;
  }
  const exactId = summaries.find((tab) => tab.targetId === trimmedRef);
  if (exactId) {
    return exactId;
  }
  const exactUrl = summaries.find((tab) => tab.url === trimmedRef);
  if (exactUrl) {
    return exactUrl;
  }
  const lower = trimmedRef.toLowerCase();
  const titleMatches = summaries.filter((tab) => tab.title.toLowerCase().includes(lower));
  if (titleMatches.length === 1) {
    return titleMatches[0] as ChatGptTabSummary;
  }
  if (titleMatches.length > 1) {
    const details = titleMatches
      .map((tab) => `${tab.targetId}: ${tab.title || "(untitled)"} — ${tab.url}`)
      .join("\n");
    throw new Error(`Multiple ChatGPT tabs match "${trimmedRef}":\n${details}`);
  }
  throw new Error(
    `No ChatGPT tab matched "${trimmedRef}". Use "oracle-tabs" or "oracle status --browser-tabs" to inspect live targets.`,
  );
}

export function resolveChatGptTabFromSummariesForTest(
  summaries: ChatGptTabSummary[],
  ref?: string,
): ChatGptTabSummary {
  return resolveChatGptTabFromSummaries(summaries, ref);
}

export async function resolveChatGptTab(
  options: ResolveChatGptTabOptions = {},
): Promise<ChatGptTabSummary> {
  const { host, port } = normalizeHostPort(options);
  const summaries = await collectChatGptTabs({ host, port });
  return resolveChatGptTabFromSummaries(summaries, options.ref);
}

export async function connectToExistingChatGptTab(
  options: ResolveChatGptTabOptions = {},
): Promise<{ client: Awaited<ReturnType<typeof CDP>>; targetId: string; tab: ChatGptTabSummary }> {
  const { host, port } = normalizeHostPort(options);
  const tab = await resolveChatGptTab({ host, port, ref: options.ref });
  const client = await connectToTarget(host, port, tab.targetId);
  return { client, targetId: tab.targetId, tab };
}

export async function harvestChatGptTab(
  options: HarvestChatGptTabOptions = {},
): Promise<ChatGptTabSummary> {
  const { host, port } = normalizeHostPort(options);
  const resolved = options.target
    ? await inspectChatGptTab({ host, port, target: options.target })
    : await resolveChatGptTab({ host, port, ref: options.ref });
  const client = await connectToTarget(host, port, resolved.targetId);
  try {
    const { Runtime } = client;
    const snapshot = await readAssistantSnapshot(Runtime).catch(() => null);
    let assistantMarkdown: string | null = null;
    if (snapshot?.messageId || snapshot?.turnId) {
      assistantMarkdown = await captureAssistantMarkdown(
        Runtime,
        {
          messageId: snapshot.messageId,
          turnId: snapshot.turnId,
        },
        noopLogger,
      ).catch(() => null);
    }
    const latestText =
      typeof snapshot?.text === "string" && snapshot.text.trim().length > 0
        ? snapshot.text.trim()
        : resolved.lastAssistantText;
    const nowSummary = await inspectChatGptTab({
      host,
      port,
      target: {
        targetId: resolved.targetId,
        title: resolved.title,
        url: resolved.url,
        type: "page",
      },
    });
    const deepResearchResultText = nowSummary.deepResearchResultText ?? "";
    const lastAssistantText = shouldPreferDeepResearchResult(latestText, deepResearchResultText)
      ? deepResearchResultText
      : (latestText ?? "");
    const assistantOutput = shouldPreferDeepResearchResult(assistantMarkdown, deepResearchResultText)
      ? deepResearchResultText
      : assistantMarkdown;
    const harvested: ChatGptTabSummary = {
      ...nowSummary,
      completionVisible:
        nowSummary.completionVisible || Boolean(assistantOutput) || Boolean(deepResearchResultText),
      lastAssistantText,
      lastAssistantSnippet: trimToSnippet(
        resolveAssistantSnippetText(lastAssistantText, assistantOutput),
      ),
      lastAssistantMarkdown: assistantOutput ?? (lastAssistantText || null),
      lastAssistantMessageId:
        typeof snapshot?.messageId === "string"
          ? snapshot.messageId
          : nowSummary.lastAssistantMessageId,
      lastAssistantTurnId:
        typeof snapshot?.turnId === "string" ? snapshot.turnId : nowSummary.lastAssistantTurnId,
    };
    if (
      (harvested.stopExists || harvested.thinkingActive) &&
      options.stallWindowMs &&
      options.stallWindowMs > 0
    ) {
      const firstFingerprint = harvested.fingerprint;
      await delay(options.stallWindowMs);
      const followup = await inspectChatGptTab({
        host,
        port,
        target: {
          targetId: harvested.targetId,
          title: harvested.title,
          url: harvested.url,
          type: "page",
        },
      });
      harvested.stopExists = followup.stopExists;
      harvested.thinkingActive = followup.thinkingActive;
      harvested.completionVisible = followup.completionVisible;
      harvested.sendExists = followup.sendExists;
      harvested.promptReady = followup.promptReady;
      harvested.currentModelLabel = followup.currentModelLabel;
      harvested.focused = followup.focused;
      harvested.visibilityState = followup.visibilityState;
      harvested.assistantCount = followup.assistantCount;
      harvested.authenticated = followup.authenticated;
      harvested.loginButtonExists = followup.loginButtonExists;
      harvested.blocker = followup.blocker;
      harvested.deepResearchStopExists = followup.deepResearchStopExists;
      harvested.deepResearchActive = followup.deepResearchActive;
      harvested.lastUserText = followup.lastUserText;
      harvested.lastUserSnippet = followup.lastUserSnippet;
      harvested.fingerprint = followup.fingerprint;
      harvested.state =
        (harvested.stopExists || harvested.thinkingActive) &&
        firstFingerprint === followup.fingerprint
          ? "stalled"
          : classifyTabState(harvested);
    } else {
      harvested.state = classifyTabState(harvested);
    }
    return harvested;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function extractConversationIdFromUrl(url: string): string | undefined {
  const match = normalizeUrl(url).match(/\/c\/([^/?#]+)/);
  return match?.[1] ?? undefined;
}

export function formatBrowserTabState(
  tab: Pick<
    ChatGptTabSummary,
    | "state"
    | "blocker"
    | "authenticated"
    | "stopExists"
    | "thinkingActive"
    | "completionVisible"
    | "sendExists"
    | "promptReady"
    | "assistantCount"
  >,
): BrowserHarvestState {
  return tab.state ?? classifyTabState(tab);
}

export function sessionMatchesTab(meta: SessionMetadata, tab: Partial<ChatGptTabSummary>): boolean {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  const conversationId = tab.conversationId ?? extractConversationIdFromUrl(tab.url ?? "");
  const portMatches = [runtime.chromePort, meta?.browser?.config?.remoteChrome?.port]
    .filter(Boolean)
    .some(
      (port) =>
        Number(port) === Number(DEFAULT_REMOTE_CHROME_PORT) ||
        Number(port) === Number(tab.port ?? port),
    );
  const hostMatches = [runtime.chromeHost, meta?.browser?.config?.remoteChrome?.host]
    .filter(Boolean)
    .every((host) => !host || host === (tab.host ?? host));
  if (!hostMatches) {
    return false;
  }
  const matches = [
    runtime.chromeTargetId && runtime.chromeTargetId === tab.targetId,
    harvest.targetId && harvest.targetId === tab.targetId,
    runtime.tabUrl && runtime.tabUrl === tab.url,
    harvest.url && harvest.url === tab.url,
    conversationId && runtime.conversationId && runtime.conversationId === conversationId,
    conversationId && harvest.conversationId && harvest.conversationId === conversationId,
  ].some(Boolean);
  return Boolean(
    matches ||
    (portMatches &&
      conversationId &&
      (runtime.conversationId === conversationId || harvest.conversationId === conversationId)),
  );
}
