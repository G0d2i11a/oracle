import type { ChromeClient } from "../types.js";
import { ASSISTANT_ROLE_SELECTOR, CONVERSATION_TURN_SELECTOR } from "../constants.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

export interface ChatGptVisibleErrorSnapshot {
  message: string;
  source: "alert" | "toast" | "assistant-turn" | "page";
  retryAvailable: boolean;
}

interface VisibleChatGptErrorOptions {
  minTurnIndex?: number;
  expectedConversationId?: string;
}

export async function readVisibleChatGptError(
  Runtime: ChromeClient["Runtime"],
  options: VisibleChatGptErrorOptions = {},
): Promise<ChatGptVisibleErrorSnapshot | null> {
  const { result } = await Runtime.evaluate({
    expression: buildVisibleChatGptErrorExpression(options),
    returnByValue: true,
  });
  const value = result?.value;
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Partial<ChatGptVisibleErrorSnapshot>;
  const message = sanitizeVisibleChatGptErrorMessage(raw.message);
  if (!message) {
    return null;
  }
  const source =
    raw.source === "alert" ||
    raw.source === "toast" ||
    raw.source === "assistant-turn" ||
    raw.source === "page"
      ? raw.source
      : "page";
  return {
    message,
    source,
    retryAvailable: raw.retryAvailable === true,
  };
}

export async function throwIfVisibleChatGptError(
  Runtime: ChromeClient["Runtime"],
  options: VisibleChatGptErrorOptions = {},
): Promise<void> {
  const snapshot = await readVisibleChatGptError(Runtime, options);
  if (!snapshot) {
    return;
  }
  throw createVisibleChatGptError(snapshot);
}

export function createVisibleChatGptError(
  snapshot: ChatGptVisibleErrorSnapshot,
): BrowserAutomationError {
  return new BrowserAutomationError(`ChatGPT showed a visible error: ${snapshot.message}`, {
    stage: "chatgpt-visible-error",
    code: "visible-chatgpt-error",
    reason: "visible-chatgpt-error",
    message: snapshot.message,
    source: snapshot.source,
    retryAvailable: snapshot.retryAvailable,
  });
}

export function isVisibleChatGptError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) {
    return false;
  }
  const details = error.details as
    | { code?: unknown; reason?: unknown; stage?: unknown }
    | undefined;
  return (
    details?.code === "visible-chatgpt-error" ||
    details?.reason === "visible-chatgpt-error" ||
    details?.stage === "chatgpt-visible-error"
  );
}

export function formatVisibleChatGptErrorLog(snapshot: ChatGptVisibleErrorSnapshot): string {
  const retrySuffix = snapshot.retryAvailable ? "; retry available" : "";
  return `[browser] ChatGPT visible error - ${snapshot.message}; source=${snapshot.source}${retrySuffix}`;
}

function sanitizeVisibleChatGptErrorMessage(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, 240);
}

function buildVisibleChatGptErrorExpression(options: VisibleChatGptErrorOptions = {}): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const minTurnLiteral =
    typeof options.minTurnIndex === "number" &&
    Number.isFinite(options.minTurnIndex) &&
    options.minTurnIndex >= 0
      ? Math.floor(options.minTurnIndex)
      : -1;
  const expectedConversationLiteral =
    typeof options.expectedConversationId === "string" &&
    options.expectedConversationId.trim().length > 0
      ? JSON.stringify(options.expectedConversationId.trim())
      : "null";
  return `(() => {
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const EXPECTED_CONVERSATION_ID = ${expectedConversationLiteral};
    const currentHref = typeof location === 'object' && location.href ? location.href : '';
    const currentConversationId = currentHref.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] ?? null;
    if (
      EXPECTED_CONVERSATION_ID &&
      currentConversationId &&
      currentConversationId !== EXPECTED_CONVERSATION_ID
    ) {
      return null;
    }
    const normalize = (value) =>
      String(value || '')
        .normalize('NFD')
        .replace(/[\\u0300-\\u036f]/g, '')
        .toLowerCase()
        .replace(/\\s+/g, ' ')
        .trim();
    const visibleText = (node) => String(node?.innerText || node?.textContent || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (style.opacity !== '' && Number(style.opacity) === 0)
      ) {
        return false;
      }
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const isComposerOrNavigation = (node) =>
      Boolean(node.closest?.('nav, form, [contenteditable="true"], textarea, [data-testid*="composer"], [id*="composer"], [data-testid*="chat-history"]'));
    const errorPhrases = [
      'something went wrong',
      'there was an error generating a response',
      'error generating a response',
      'an error occurred',
      'encountered an error',
      'network error',
      'failed to generate',
      'failed to get response',
      'could not generate',
      "couldn't generate",
      'unable to generate',
      'request timed out',
      'message stream interrupted',
      'unable to load conversation',
      'conversation not found',
      'we ran into an issue',
      'please try again',
      '出了点问题',
      '出错了',
      '发生错误',
      '出现错误',
      '生成回复时出错',
      '网络错误',
      '请求超时',
      '请重试'
    ];
    const retryPhrases = ['retry', 'try again', 'regenerate', '重试', '再试一次', '重新生成'];
    const hasRetryPhrase = (text) => retryPhrases.some((phrase) => text.includes(phrase));
    const hasErrorPhrase = (text) => {
      if (!text) return false;
      if (errorPhrases.some((phrase) => text.includes(phrase))) return true;
      return /\\berror\\b/.test(text) && hasRetryPhrase(text);
    };
    const hasRetryAction = (scope) => {
      const nodes = Array.from(scope.querySelectorAll?.('button, [role="button"], a, [data-testid*="retry"], [aria-label*="Retry"], [aria-label*="Try again"]') ?? []);
      return nodes.some((node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
        const label = normalize([
          node.textContent,
          node.getAttribute?.('aria-label'),
          node.getAttribute?.('title'),
          node.getAttribute?.('data-testid'),
        ].filter(Boolean).join(' '));
        return hasRetryPhrase(label);
      });
    };
    const snapshotFor = (node, source) => ({
      message: visibleText(node).slice(0, 240),
      source,
      retryAvailable: hasRetryAction(node),
    });
    const globalCandidates = Array.from(
      document.querySelectorAll(
        [
          '[role="alert"]',
          '[aria-live="assertive"]',
          '[data-testid*="toast"]',
          '[data-testid*="notification"]',
          '[data-testid*="error"]',
          '[class*="toast"]',
          '[class*="error"]'
        ].join(','),
      ),
    );
    for (const node of globalCandidates) {
      if (!(node instanceof HTMLElement) || !isVisible(node) || isComposerOrNavigation(node)) continue;
      const text = normalize(visibleText(node));
      if (!hasErrorPhrase(text)) continue;
      const inTurn = node.closest?.(CONVERSATION_SELECTOR);
      if (inTurn) continue;
      const source =
        node.getAttribute('role') === 'alert' || node.getAttribute('aria-live') === 'assertive'
          ? 'alert'
          : 'toast';
      return snapshotFor(node, source);
    }
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const role = String(node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = String(node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (MIN_TURN_INDEX >= 0 && index < MIN_TURN_INDEX) continue;
      if (!isAssistantTurn(turn) || !isVisible(turn)) continue;
      const text = normalize(visibleText(turn));
      if (!hasErrorPhrase(text)) return null;
      const hasMarkdownContent = Boolean(turn.querySelector('.markdown, [data-message-content], .prose, pre, code'));
      if (!hasRetryAction(turn) && hasMarkdownContent) return null;
      return snapshotFor(turn, 'assistant-turn');
    }
    return null;
  })()`;
}

export const readVisibleChatGptErrorForTest = readVisibleChatGptError;
export const buildVisibleChatGptErrorExpressionForTest = buildVisibleChatGptErrorExpression;
