import type { ChromeClient, BrowserLogger } from "../types.js";
import { CLOUDFLARE_SCRIPT_SELECTOR, CLOUDFLARE_TITLE, INPUT_SELECTORS } from "../constants.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

export function installJavaScriptDialogAutoDismissal(
  Page: ChromeClient["Page"],
  logger: BrowserLogger,
): () => void {
  type DialogEvent = { type?: string; message?: string };
  const pageAny = Page as unknown as {
    on?: (event: string, listener: (params: DialogEvent) => void) => void;
    off?: (event: string, listener: (params: DialogEvent) => void) => void;
    removeListener?: (event: string, listener: (params: DialogEvent) => void) => void;
    handleJavaScriptDialog?: (params: { accept: boolean; promptText?: string }) => Promise<void>;
  };

  if (typeof pageAny.on !== "function" || typeof pageAny.handleJavaScriptDialog !== "function") {
    return () => {};
  }

  const handler = async (params: DialogEvent) => {
    const type = typeof params?.type === "string" ? params.type : "unknown";
    const message = typeof params?.message === "string" ? params.message : "";
    logger(`[nav] dismissing JS dialog (${type})${message ? `: ${message.slice(0, 140)}` : ""}`);
    try {
      await pageAny.handleJavaScriptDialog?.({ accept: true, promptText: "" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger(`[nav] failed to dismiss JS dialog: ${msg}`);
    }
  };

  pageAny.on("javascriptDialogOpening", handler);
  return () => {
    try {
      pageAny.off?.("javascriptDialogOpening", handler);
    } catch {
      try {
        pageAny.removeListener?.("javascriptDialogOpening", handler);
      } catch {
        // ignore
      }
    }
  };
}

export async function navigateToChatGPT(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
  url: string,
  logger: BrowserLogger,
) {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

export interface PromptReadyNavigationOptions {
  url: string;
  fallbackUrl?: string;
  timeoutMs: number;
  fallbackTimeoutMs?: number;
  headless: boolean;
  logger: BrowserLogger;
}

export interface PromptReadyNavigationDeps {
  navigateToChatGPT?: typeof navigateToChatGPT;
  ensureNotBlocked?: typeof ensureNotBlocked;
  ensurePromptReady?: typeof ensurePromptReady;
}

export interface ChatGptSubscriptionIssueSnapshot {
  message: string;
  source: "alert" | "dialog" | "toast" | "page";
}

export interface SubscriptionIssueRecoveryOptions {
  maxRefreshes?: number;
  settleMs?: number;
}

async function dismissBlockingUi(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<boolean> {
  const outcome = await Runtime.evaluate({
    expression: `(() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      };
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const labelFor = (el) => normalize(el?.textContent || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title'));
      const buttonCandidates = (root) =>
        Array.from(root.querySelectorAll('button,[role="button"],a')).filter((el) => isVisible(el));

      const roots = [
        ...Array.from(document.querySelectorAll('[role="dialog"],dialog')),
        document.body,
      ].filter(Boolean);
      for (const root of roots) {
        const buttons = buttonCandidates(root);
        const close = buttons.find((el) => labelFor(el).includes('close'));
        if (close) {
          (close).click();
          return { dismissed: true, action: 'close' };
        }
        const okLike = buttons.find((el) => {
          const label = labelFor(el);
          return (
            label === 'ok' ||
            label === 'got it' ||
            label === 'dismiss' ||
            label === 'continue' ||
            label === 'back' ||
            label.includes('back to chatgpt') ||
            label.includes('go to chatgpt') ||
            label.includes('return') ||
            label.includes('take me')
          );
        });
        if (okLike) {
          (okLike).click();
          return { dismissed: true, action: 'confirm' };
        }
      }
      return { dismissed: false };
    })()`,
    returnByValue: true,
  }).catch(() => null);
  const value = outcome?.result?.value as { dismissed?: boolean; action?: string } | undefined;
  if (value?.dismissed) {
    logger(`[nav] dismissed blocking UI (${value.action ?? "unknown"})`);
    return true;
  }
  return false;
}

export async function navigateToPromptReadyWithFallback(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
  options: PromptReadyNavigationOptions,
  deps: PromptReadyNavigationDeps = {},
): Promise<{ usedFallback: boolean }> {
  const { url, fallbackUrl, timeoutMs, fallbackTimeoutMs, headless, logger } = options;
  const navigate = deps.navigateToChatGPT ?? navigateToChatGPT;
  const ensureBlocked = deps.ensureNotBlocked ?? ensureNotBlocked;
  const ensureReady = deps.ensurePromptReady ?? ensurePromptReady;

  await navigate(Page, Runtime, url, logger);
  await ensureBlocked(Runtime, headless, logger);
  await dismissBlockingUi(Runtime, logger).catch(() => false);
  await ensureNoChatGptSubscriptionIssue(Page, Runtime, logger);
  try {
    await ensureReady(Runtime, timeoutMs, logger);
    return { usedFallback: false };
  } catch (error) {
    if (!fallbackUrl || fallbackUrl === url) {
      throw error;
    }
    const fallbackTimeout = fallbackTimeoutMs ?? Math.max(timeoutMs * 2, 120_000);
    logger(
      `Prompt not ready after ${Math.round(timeoutMs / 1000)}s on ${url}; retrying ${fallbackUrl} with ${Math.round(fallbackTimeout / 1000)}s timeout.`,
    );
    await navigate(Page, Runtime, "about:blank", logger);
    await delay(250);
    await navigate(Page, Runtime, fallbackUrl, logger);
    await ensureBlocked(Runtime, headless, logger);
    await dismissBlockingUi(Runtime, logger).catch(() => false);
    await ensureNoChatGptSubscriptionIssue(Page, Runtime, logger);
    await ensureReady(Runtime, fallbackTimeout, logger);
    return { usedFallback: true };
  }
}

export async function ensureNoChatGptSubscriptionIssue(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  options: SubscriptionIssueRecoveryOptions = {},
): Promise<number> {
  const maxRefreshes = options.maxRefreshes ?? resolveSubscriptionIssueRefreshes();
  const settleMs = Math.max(0, options.settleMs ?? 1_500);

  for (let refreshCount = 0; refreshCount <= maxRefreshes; refreshCount += 1) {
    const issue = await readChatGptSubscriptionIssue(Runtime);
    if (!issue) {
      if (refreshCount > 0) {
        logger(
          `[browser] ChatGPT subscription warning cleared after ${refreshCount} refresh${refreshCount === 1 ? "" : "es"}.`,
        );
      }
      return refreshCount;
    }

    if (refreshCount >= maxRefreshes) {
      throw new BrowserAutomationError(
        `ChatGPT subscription warning did not clear after ${maxRefreshes} refresh${maxRefreshes === 1 ? "" : "es"}: ${issue.message}`,
        {
          stage: "chatgpt-subscription-issue",
          reason: "subscription-issue-visible",
          message: issue.message,
          source: issue.source,
          refreshes: refreshCount,
        },
      );
    }

    logger(
      `[browser] ChatGPT subscription warning detected (${issue.message}); refreshing before continuing (${refreshCount + 1}/${maxRefreshes}).`,
    );
    await Page.reload({ ignoreCache: true });
    await waitForDocumentReady(Runtime, 45_000);
    await dismissBlockingUi(Runtime, logger).catch(() => false);
    await delay(settleMs);
  }

  return maxRefreshes;
}

export function createChatGptSubscriptionIssueError(
  issue: ChatGptSubscriptionIssueSnapshot,
  refreshes = 0,
): BrowserAutomationError {
  return new BrowserAutomationError(`ChatGPT subscription warning is visible: ${issue.message}`, {
    stage: "chatgpt-subscription-issue",
    code: "chatgpt-subscription-issue",
    reason: "subscription-issue-visible",
    message: issue.message,
    source: issue.source,
    refreshes,
  });
}

export async function throwIfChatGptSubscriptionIssue(
  Runtime: ChromeClient["Runtime"],
): Promise<void> {
  const issue = await readChatGptSubscriptionIssue(Runtime);
  if (!issue) {
    return;
  }
  throw createChatGptSubscriptionIssueError(issue);
}

export async function readChatGptSubscriptionIssue(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatGptSubscriptionIssueSnapshot | null> {
  if (typeof Runtime.evaluate !== "function") {
    return null;
  }
  const outcome = await Runtime.evaluate({
    expression: buildChatGptSubscriptionIssueExpression(),
    returnByValue: true,
  }).catch(() => null);
  const value = outcome?.result?.value as Partial<ChatGptSubscriptionIssueSnapshot> | undefined;
  const message = sanitizeSubscriptionIssueMessage(value?.message);
  if (!message) {
    return null;
  }
  const source =
    value?.source === "alert" ||
    value?.source === "dialog" ||
    value?.source === "toast" ||
    value?.source === "page"
      ? value.source
      : "page";
  return { message, source };
}

function sanitizeSubscriptionIssueMessage(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, 240);
}

function resolveSubscriptionIssueRefreshes(): number {
  const raw = process.env.ORACLE_BROWSER_SUBSCRIPTION_REFRESHES;
  if (raw === undefined || raw.trim() === "") {
    return 8;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(25, Math.floor(parsed)));
}

function buildChatGptSubscriptionIssueExpression(): string {
  return `(() => {
    const normalize = (value) =>
      String(value || '')
        .normalize('NFD')
        .replace(/[\\u0300-\\u036f]/g, '')
        .toLowerCase()
        .replace(/\\s+/g, ' ')
        .trim();
    const visibleText = (node) =>
      String(node?.innerText || node?.textContent || '').replace(/\\s+/g, ' ').trim();
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
    const sourceFor = (node) => {
      const role = String(node.getAttribute?.('role') || '').toLowerCase();
      const tag = String(node.tagName || '').toLowerCase();
      const marker = normalize([
        node.getAttribute?.('data-testid'),
        node.getAttribute?.('class'),
        node.getAttribute?.('aria-live'),
      ].filter(Boolean).join(' '));
      if (role === 'alert' || marker.includes('alert')) return 'alert';
      if (role === 'dialog' || tag === 'dialog' || marker.includes('modal')) return 'dialog';
      if (marker.includes('toast') || marker.includes('sonner')) return 'toast';
      return 'page';
    };
    const isConversationOrComposerChrome = (node) =>
      Boolean(
        node.closest?.(
          [
            'nav',
            'aside',
            'form',
            '[contenteditable="true"]',
            'textarea',
            '[data-testid*="composer"]',
            '[id*="composer"]',
            '[data-testid^="conversation-turn"]',
            '[data-message-author-role]',
          ].join(','),
        ),
      );
    const subscriptionSignals = [
      'subscription',
      'subscribed',
      'billing',
      'current plan',
      'your plan',
      'paid plan',
      'chatgpt plus',
      'chatgpt pro',
      'pro subscription',
      'plus subscription',
      '订阅',
      '套餐',
      '会员',
      '付费计划',
    ];
    const problemSignals = [
      'error',
      'problem',
      'issue',
      'failed',
      'failure',
      'unable',
      'unavailable',
      'could not',
      "couldn't",
      'try again',
      'retry',
      'refresh',
      'reload',
      'temporarily',
      'access',
      'not available',
      'upgrade',
      '出了点问题',
      '错误',
      '失败',
      '无法',
      '不可用',
      '稍后',
      '重试',
      '刷新',
      '权限',
    ];
    const isSubscriptionIssueText = (raw) => {
      const text = normalize(raw);
      if (!text) return false;
      const hasSubscription = subscriptionSignals.some((signal) => text.includes(signal));
      const hasProblem = problemSignals.some((signal) => text.includes(signal));
      if (hasSubscription && hasProblem) return true;
      return (
        text.includes('something went wrong') &&
        (text.includes('subscription') || text.includes('plan') || text.includes('billing'))
      );
    };
    const selectors = [
      '[role="alert"]',
      '[aria-live="assertive"]',
      '[aria-live="polite"]',
      '[role="dialog"]',
      'dialog',
      '[data-testid*="toast"]',
      '[class*="toast"]',
      '[class*="Toast"]',
      '[class*="sonner"]',
      '[class*="modal"]',
      '[data-testid*="modal"]',
      '[class*="banner"]',
      'body > div',
    ].join(',');
    const nodes = Array.from(document.querySelectorAll(selectors));
    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
      if (isConversationOrComposerChrome(node)) continue;
      const text = visibleText(node);
      if (!text || text.length > 1400) continue;
      if (isSubscriptionIssueText(text)) {
        return { message: text.slice(0, 240), source: sourceFor(node) };
      }
    }
    return null;
  })()`;
}

export async function ensureNotBlocked(
  Runtime: ChromeClient["Runtime"],
  headless: boolean,
  logger: BrowserLogger,
) {
  if (await isCloudflareInterstitial(Runtime)) {
    logger("Cloudflare anti-bot page detected");
    if (!headless) {
      logger("Cloudflare challenge detected; waiting for manual clearance in the open browser...");
      const cleared = await waitForCloudflareClearance(Runtime, logger);
      if (cleared) {
        logger("Cloudflare challenge cleared; continuing browser run.");
        return;
      }
    }

    const message = headless
      ? "Cloudflare challenge detected in headless mode. Re-run with --headful so you can solve the challenge."
      : "Cloudflare challenge still present after waiting. Complete the “Just a moment…” check in the open browser, then rerun.";
    throw new BrowserAutomationError(message, { stage: "cloudflare-challenge", headless });
  }
  if (await isChatGptAccountSecurityBlock(Runtime)) {
    const message =
      "ChatGPT account security block detected. Open chatgpt.com in Chrome, secure the account, then rerun Oracle.";
    logger("ChatGPT account security block detected");
    throw new BrowserAutomationError(message, { stage: "chatgpt-account-blocked" });
  }
}

const CLOUDFLARE_MANUAL_CLEARANCE_TIMEOUT_MS = 10 * 60_000;
const CLOUDFLARE_MANUAL_CLEARANCE_POLL_MS = 1_000;
const CLOUDFLARE_MANUAL_CLEARANCE_LOG_EVERY_MS = 30_000;

async function waitForCloudflareClearance(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  timeoutMs = CLOUDFLARE_MANUAL_CLEARANCE_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let nextLogAt = Date.now() + CLOUDFLARE_MANUAL_CLEARANCE_LOG_EVERY_MS;

  while (Date.now() < deadline) {
    if (!(await isCloudflareInterstitial(Runtime))) {
      return true;
    }

    const now = Date.now();
    if (now >= nextLogAt) {
      const remainingSeconds = Math.max(0, Math.ceil((deadline - now) / 1000));
      logger(`Still waiting for manual Cloudflare clearance (${remainingSeconds}s remaining)...`);
      nextLogAt = now + CLOUDFLARE_MANUAL_CLEARANCE_LOG_EVERY_MS;
    }

    await delay(CLOUDFLARE_MANUAL_CLEARANCE_POLL_MS);
  }

  return !(await isCloudflareInterstitial(Runtime));
}

const LOGIN_CHECK_TIMEOUT_MS = 5_000;

export async function ensureLoggedIn(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  options: { appliedCookies?: number | null; remoteSession?: boolean } = {},
) {
  // Learned: ChatGPT can render the UI (project view) while auth silently failed.
  // A backend-api probe plus DOM login CTA check catches both cases.
  const outcome = await Runtime.evaluate({
    expression: buildLoginProbeExpression(LOGIN_CHECK_TIMEOUT_MS),
    awaitPromise: true,
    returnByValue: true,
  });
  const probe = normalizeLoginProbe(outcome.result?.value);
  if (probe.ok) {
    logger(
      `Login check passed (status=${probe.status}, domLoginCta=${Boolean(probe.domLoginCta)})`,
    );
    return;
  }

  const accepted = await attemptWelcomeBackLogin(Runtime, logger);
  if (accepted) {
    // Learned: "Welcome back" account picker needs a click even when cookies are valid,
    // and the redirect can lag, so re-probe before failing hard.
    await delay(1500);
    const retryOutcome = await Runtime.evaluate({
      expression: buildLoginProbeExpression(LOGIN_CHECK_TIMEOUT_MS),
      awaitPromise: true,
      returnByValue: true,
    });
    const retryProbe = normalizeLoginProbe(retryOutcome.result?.value);
    if (retryProbe.ok) {
      logger("Login restored via Welcome back account picker");
      return;
    }
    logger(
      `Login retry after Welcome back failed (status=${retryProbe.status}, domLoginCta=${Boolean(
        retryProbe.domLoginCta,
      )})`,
    );
  }

  logger(
    `Login probe failed (status=${probe.status}, domLoginCta=${Boolean(probe.domLoginCta)}, onAuthPage=${Boolean(
      probe.onAuthPage,
    )}, url=${probe.pageUrl ?? "n/a"}, error=${probe.error ?? "none"})`,
  );

  const domLabel = probe.domLoginCta ? " Login button detected on page." : "";
  const cookieHint = options.remoteSession
    ? "The remote Chrome session is not signed into ChatGPT. Sign in there, then rerun."
    : (options.appliedCookies ?? 0) === 0
      ? "No ChatGPT cookies were applied; sign in to chatgpt.com in Chrome or pass inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON)."
      : "ChatGPT login appears missing; open chatgpt.com in Chrome to refresh the session or provide inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON).";

  throw new Error(`ChatGPT session not detected.${domLabel} ${cookieHint}`);
}

async function attemptWelcomeBackLogin(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let outcome;
    try {
      outcome = await Runtime.evaluate({
        expression: `(() => {
          // Learned: "Welcome back" shows as a modal with account chips; click the email chip.
          const getLabel = (node) =>
            (node?.textContent || node?.getAttribute?.('aria-label') || '').trim();
          const isAccount = (label) =>
            Boolean(label) &&
            label.includes('@') &&
            !/log in|sign up|create account|another account/i.test(label);
          const candidates = Array.from(document.querySelectorAll('[role="button"],button,a'));
          const account = candidates.find((node) => isAccount(getLabel(node))) || null;
          if (!account) {
            return { clicked: false, reason: 'not-found' };
          }
          const label = getLabel(account);
          setTimeout(() => {
            try {
              account.click();
            } catch {
              // ignore; caller will re-probe login state
            }
          }, 0);
          return { clicked: true, label };
        })()`,
        awaitPromise: false,
        returnByValue: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/navigated or closed|context was destroyed|target closed/i.test(message)) {
        logger("Welcome back account click triggered navigation.");
        return true;
      }
      logger(`Welcome back auto-select probe failed: ${message}`);
      return false;
    }
    if (outcome.exceptionDetails) {
      const details = outcome.exceptionDetails;
      const description =
        (details.exception &&
          typeof details.exception.description === "string" &&
          details.exception.description) ||
        details.text ||
        "unknown error";
      logger(`Welcome back auto-select probe failed: ${description}`);
      return false;
    }
    const result = outcome.result?.value as
      | { clicked?: boolean; reason?: string; label?: string }
      | undefined;
    if (!result) {
      logger("Welcome back auto-select probe returned no result.");
      return false;
    }
    if (!("clicked" in result) && !("reason" in result)) {
      logger("Welcome back auto-select probe returned an unexpected result.");
      return false;
    }
    if (result.clicked) {
      logger(`Welcome back modal detected; selected account ${result.label ?? "(unknown)"}`);
      return true;
    }
    if (result.reason && result.reason !== "not-found") {
      logger(`Welcome back modal present but auto-select failed (${result.reason}).`);
      return false;
    }
    await delay(500);
  }
  logger("Welcome back modal not detected after login probe failure.");
  return false;
}

export async function ensurePromptReady(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
) {
  const ready = await waitForPrompt(Runtime, timeoutMs, logger);
  if (!ready) {
    const authUrl = await currentUrl(Runtime);
    if (authUrl && isAuthLoginUrl(authUrl)) {
      // Learned: auth.openai.com/login can appear after cookies are copied; allow manual login window.
      logger("Auth login page detected; waiting for manual login to complete...");
      const extended = Math.min(Math.max(timeoutMs, 60_000), 20 * 60_000);
      const loggedIn = await waitForPrompt(Runtime, extended, logger);
      if (loggedIn) {
        return;
      }
    }
    await logDomFailure(Runtime, logger, "prompt-textarea");
    throw new Error("Prompt textarea did not appear before timeout");
  }
}

async function waitForDocumentReady(Runtime: ChromeClient["Runtime"], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `document.readyState`,
      returnByValue: true,
    });
    if (result?.value === "complete" || result?.value === "interactive") {
      return;
    }
    await delay(100);
  }
  throw new Error("Page did not reach ready state in time");
}

async function currentUrl(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: 'typeof location === "object" && location.href ? location.href : null',
    returnByValue: true,
  });
  return typeof result?.value === "string" ? result.value : null;
}

function isAuthLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("auth.openai.com")) {
      return true;
    }
    return /^\/log-?in/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function buildUnarchiveConversationExpressionForTest(): string {
  return buildUnarchiveConversationExpression();
}

export const readChatGptSubscriptionIssueForTest = readChatGptSubscriptionIssue;
export const ensureNoChatGptSubscriptionIssueForTest = ensureNoChatGptSubscriptionIssue;

function buildUnarchiveConversationExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const bodyText = normalize(document.body?.innerText || document.body?.textContent || '');
    const archivedNotice =
      bodyText.includes('conversation is archived') ||
      bodyText.includes('this conversation is archived') ||
      bodyText.includes('chat is archived');
    if (!archivedNotice) {
      return { clicked: false, reason: 'not-archived' };
    }
    const controls = Array.from(document.querySelectorAll('button,[role="button"]'));
    const target = controls.find((node) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
      const label = normalize([
        node.innerText,
        node.textContent,
        node.getAttribute('aria-label'),
        node.getAttribute('title'),
      ].filter(Boolean).join(' '));
      return label.includes('unarchive') || label.includes('restore conversation');
    });
    if (!target) {
      return { clicked: false, reason: 'unarchive-control-not-found' };
    }
    target.click();
    return { clicked: true };
  })()`;
}

async function clickUnarchiveConversationIfNeeded(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<boolean> {
  const { result } = await Runtime.evaluate({
    expression: buildUnarchiveConversationExpression(),
    returnByValue: true,
  });
  const value = result?.value as { clicked?: boolean } | undefined;
  if (value?.clicked) {
    logger?.("[browser] Archived ChatGPT conversation detected; clicked Unarchive.");
    return true;
  }
  return false;
}

async function waitForPrompt(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger?: BrowserLogger,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let unarchiveClicked = false;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const selectors = ${JSON.stringify(INPUT_SELECTORS)};
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && !node.hasAttribute('disabled')) {
            return true;
          }
        }
        return false;
      })()`,
      returnByValue: true,
    });
    if (result?.value) {
      return true;
    }
    if (!unarchiveClicked && (await clickUnarchiveConversationIfNeeded(Runtime, logger))) {
      unarchiveClicked = true;
      await delay(1000);
      continue;
    }
    await delay(200);
  }
  return false;
}

async function isCloudflareInterstitial(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  const { result: titleResult } = await Runtime.evaluate({
    expression: "document.title",
    returnByValue: true,
  });
  const title = typeof titleResult.value === "string" ? titleResult.value : "";
  const challengeTitle = CLOUDFLARE_TITLE.toLowerCase();
  if (title.toLowerCase().includes(challengeTitle)) {
    return true;
  }

  const { result } = await Runtime.evaluate({
    expression: `Boolean(document.querySelector('${CLOUDFLARE_SCRIPT_SELECTOR}'))`,
    returnByValue: true,
  });
  return Boolean(result.value);
}

async function isChatGptAccountSecurityBlock(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  try {
    const outcome = await Runtime.evaluate({
      expression: `(() => {
        const text = String(document.body?.innerText || '').toLowerCase().replace(/\\s+/g, ' ');
        return text.includes('suspicious activity detected') &&
          text.includes('secure your account') &&
          text.includes('regain access');
      })()`,
      returnByValue: true,
    });
    return Boolean(outcome?.result?.value);
  } catch {
    return false;
  }
}

type LoginProbeResult = {
  ok: boolean;
  status: number;
  url?: string | null;
  redirected?: boolean;
  error?: string | null;
  pageUrl?: string | null;
  domLoginCta?: boolean;
  onAuthPage?: boolean;
};

function buildLoginProbeExpression(timeoutMs: number): string {
  return `(async () => {
    // Learned: /backend-api/me is the most reliable "am I logged in" signal.
    // Some UIs render without a session; use DOM + network for a robust answer.
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    const hasLoginCta = () => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return (
          ['log in', 'login', 'sign in', 'signin', 'continue with', 'sign up for free'].some(
            (needle) => normalized.startsWith(needle),
          ) ||
          normalized.includes('get responses tailored to you') ||
          normalized.includes('log in to get answers')
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        ) {
          continue;
        }
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    };

    const hasAuthenticatedUiSignals = () => {
      const hasPromptInput = Boolean(
        document.querySelector('textarea,[contenteditable="true"],[data-testid="composer-plus-btn"]'),
      );
      const hasProfileMenu = Boolean(document.querySelector('[data-testid="accounts-profile-button"]'));
      const hasNewChat = Boolean(document.querySelector('[data-testid="create-new-chat-button"]'));
      const hasUserScopedStorage = (() => {
        try {
          return Object.keys(localStorage || {}).some((key) => /user-[a-z0-9]/i.test(key));
        } catch {
          return false;
        }
      })();
      const hasAuthCookie = (() => {
        try {
          return /(?:^|;\\s*)(?:_puid|oai-last-model-config|oai-did)=/.test(document.cookie || '');
        } catch {
          return false;
        }
      })();
      return hasPromptInput && hasNewChat && (hasProfileMenu || hasUserScopedStorage || hasAuthCookie);
    };

    const readBackendStatus = async () => {
      try {
        if (typeof fetch === 'function') {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
          try {
            // Credentials included so we see a 200 only when cookies are valid.
            const response = await fetch('/backend-api/me', {
              cache: 'no-store',
              credentials: 'include',
              signal: controller.signal,
            });
            return { status: response.status || 0, error: null };
          } finally {
            clearTimeout(timeout);
          }
        }
      } catch (err) {
        return { status: 0, error: err ? String(err) : 'unknown' };
      }
      return { status: 0, error: null };
    };

    let { status, error } = await readBackendStatus();
    let domLoginCta = hasLoginCta();
    const settleDeadline = Date.now() + Math.min(${timeoutMs}, 2500);
    while (!domLoginCta && Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      domLoginCta = hasLoginCta();
      if (status === 0 || status === 401 || status === 403) {
        const next = await readBackendStatus();
        status = next.status;
        error = next.error;
      }
    }

    const loginSignals = domLoginCta || onAuthPage;
    const authenticatedUiSignals = hasAuthenticatedUiSignals();
    return {
      ok: !loginSignals && (status === 200 || authenticatedUiSignals),
      status,
      redirected: false,
      url: pageUrl,
      pageUrl,
      domLoginCta,
      onAuthPage,
      authenticatedUiSignals,
      error,
    };
  })()`;
}

function normalizeLoginProbe(raw: unknown): LoginProbeResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, status: 0 };
  }
  const value = raw as Record<string, unknown>;
  const statusRaw = value.status;
  const status =
    typeof statusRaw === "number"
      ? statusRaw
      : typeof statusRaw === "string" && !Number.isNaN(Number(statusRaw))
        ? Number(statusRaw)
        : 0;

  return {
    ok: Boolean(value.ok),
    status: Number.isFinite(status) ? (status as number) : 0,
    url: typeof value.url === "string" ? value.url : null,
    redirected: Boolean(value.redirected),
    error: typeof value.error === "string" ? value.error : null,
    pageUrl: typeof value.pageUrl === "string" ? value.pageUrl : null,
    domLoginCta: Boolean(value.domLoginCta),
    onAuthPage: Boolean(value.onAuthPage),
  };
}
