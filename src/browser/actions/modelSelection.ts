import type { ChromeClient, BrowserLogger, BrowserModelStrategy } from "../types.js";
import {
  COMPOSER_MODEL_SIGNAL_SELECTOR,
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

type ModelSelectionInterruptionKind =
  | "cloudflare-challenge"
  | "manual-verification-required"
  | "chatgpt-login-required";

interface ModelSelectionInterruption {
  kind?: ModelSelectionInterruptionKind;
  title?: string;
  url?: string;
  evidence?: string[];
}

export async function ensureModelSelection(
  Runtime: ChromeClient["Runtime"],
  desiredModel: string,
  logger: BrowserLogger,
  strategy: BrowserModelStrategy = "select",
  options: ModelSelectionWaitOptions = {},
) {
  const waitTimeoutMs = options.interruptionTimeoutMs ?? MODEL_SELECTION_INTERRUPTION_TIMEOUT_MS;
  const pollMs = options.interruptionPollMs ?? MODEL_SELECTION_INTERRUPTION_POLL_MS;
  const logEveryMs = options.interruptionLogEveryMs ?? MODEL_SELECTION_INTERRUPTION_LOG_EVERY_MS;
  let waitStartedAt: number | null = null;
  let nextLogAt = 0;
  let lastInterruption: ModelSelectionInterruption | undefined;

  while (true) {
    const outcome = await Runtime.evaluate({
      expression: buildModelSelectionExpression(desiredModel, strategy),
      awaitPromise: true,
      returnByValue: true,
    });

    const result = outcome.result?.value as ModelSelectionResult | undefined;
    const interruption = getRetryableModelSelectionInterruption(result);
    if (interruption) {
      lastInterruption = interruption;
      const now = Date.now();
      if (waitStartedAt === null) {
        waitStartedAt = now;
        nextLogAt = now + logEveryMs;
        logger(
          "Cloudflare or manual verification appeared during model selection; waiting for the page to clear...",
        );
      } else if (now >= nextLogAt) {
        const remainingSeconds = Math.max(
          0,
          Math.ceil((waitStartedAt + waitTimeoutMs - now) / 1000),
        );
        logger(
          `Still waiting for model-selection verification clearance (${remainingSeconds}s remaining)...`,
        );
        nextLogAt = now + logEveryMs;
      }

      if (now - waitStartedAt < waitTimeoutMs) {
        await delay(pollMs);
        continue;
      }

      throwModelSelectionInterruption(lastInterruption);
    }

    if (waitStartedAt !== null) {
      logger("Model-selection verification cleared; continuing browser run.");
      waitStartedAt = null;
      nextLogAt = 0;
      lastInterruption = undefined;
    }

    switch (result?.status) {
      case "already-selected":
      case "switched":
      case "switched-best-effort": {
        const label = result.label ?? desiredModel;
        if (strategy !== "current") {
          assertResolvedModelSelection(desiredModel, label);
        }
        logger(`Model picker: ${label}`);
        return;
      }
      case "option-not-found": {
        await logDomFailure(Runtime, logger, "model-switcher-option");
        const isTemporary = result.hint?.temporaryChat ?? false;
        const available = (result.hint?.availableOptions ?? []).filter(Boolean);
        const availableHint = available.length > 0 ? ` Available: ${available.join(", ")}.` : "";
        const tempHint =
          isTemporary && /\bpro\b/i.test(desiredModel)
            ? ' You are in Temporary Chat mode; Pro models are not available there. Remove "temporary-chat=true" from --chatgpt-url or use a non-Pro model (e.g. gpt-5.2).'
            : "";
        throw new Error(
          `Unable to find model option matching "${desiredModel}" in the model switcher.${availableHint}${tempHint}`,
        );
      }
      case "model-menu-not-opened": {
        const interruption = result.hint?.interruption;
        if (interruption?.kind) {
          throwModelSelectionInterruption(interruption);
        }
        await logDomFailure(Runtime, logger, "model-switcher-menu");
        const controls = (result.hint?.visibleControls ?? []).filter(Boolean);
        const controlsHint =
          controls.length > 0 ? ` Visible controls: ${controls.join(", ")}.` : "";
        throw new BrowserAutomationError(
          `ChatGPT model selector did not open after clicking the model button. The page may be blocked by a verification/login overlay or ChatGPT changed the picker UI.${controlsHint}`,
          { stage: "model-selection-menu-unavailable", visibleControls: controls },
        );
      }
      case "interrupted":
        throwModelSelectionInterruption(result.interruption);
      default: {
        const interruption = result && "hint" in result ? result.hint?.interruption : undefined;
        if (interruption?.kind) {
          throwModelSelectionInterruption(interruption);
        }
        await logDomFailure(Runtime, logger, "model-switcher-button");
        throw new Error("Unable to locate the ChatGPT model selector button.");
      }
    }
  }
}

type ModelSelectionWaitOptions = {
  interruptionTimeoutMs?: number;
  interruptionPollMs?: number;
  interruptionLogEveryMs?: number;
};

type ModelSelectionResult =
  | { status: "already-selected"; label?: string | null }
  | { status: "switched"; label?: string | null }
  | { status: "switched-best-effort"; label?: string | null }
  | {
      status: "option-not-found";
      hint?: { temporaryChat?: boolean; availableOptions?: string[] };
    }
  | {
      status: "model-menu-not-opened";
      hint?: { visibleControls?: string[]; interruption?: ModelSelectionInterruption };
    }
  | { status: "button-missing"; hint?: { interruption?: ModelSelectionInterruption } }
  | { status: "interrupted"; interruption?: ModelSelectionInterruption };

const MODEL_SELECTION_INTERRUPTION_TIMEOUT_MS = 10 * 60_000;
const MODEL_SELECTION_INTERRUPTION_POLL_MS = 1_000;
const MODEL_SELECTION_INTERRUPTION_LOG_EVERY_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function getRetryableModelSelectionInterruption(
  result: ModelSelectionResult | undefined,
): ModelSelectionInterruption | undefined {
  const interruption =
    result?.status === "interrupted"
      ? result.interruption
      : result?.status === "model-menu-not-opened" || result?.status === "button-missing"
        ? result.hint?.interruption
        : undefined;
  const kind = interruption?.kind;
  return kind === "cloudflare-challenge" || kind === "manual-verification-required"
    ? interruption
    : undefined;
}

function throwModelSelectionInterruption(interruption?: ModelSelectionInterruption): never {
  const kind = interruption?.kind ?? "manual-verification-required";
  const evidence = interruption?.evidence?.filter(Boolean) ?? [];
  const evidenceHint = evidence.length > 0 ? ` Detected: ${evidence.join(", ")}.` : "";
  if (kind === "cloudflare-challenge" || kind === "manual-verification-required") {
    throw new BrowserAutomationError(
      `Cloudflare or manual verification is blocking ChatGPT model selection.${evidenceHint} Complete the verification in the open browser, then rerun Oracle.`,
      { stage: "cloudflare-challenge", reason: kind, interruption },
    );
  }
  throw new BrowserAutomationError(
    `ChatGPT login is required before Oracle can select a browser model.${evidenceHint} Log in to ChatGPT in the open Chrome profile, then rerun Oracle.`,
    { stage: "chatgpt-login-required", reason: kind, interruption },
  );
}

function assertResolvedModelSelection(desiredModel: string, resolvedLabel: string): void {
  const desired = desiredModel.toLowerCase();
  const resolved = resolvedLabel.toLowerCase();
  const wantsGpt55Pro =
    desired === "gpt-5.5-pro" ||
    desired.includes("5.5 pro") ||
    desired.includes("5-5 pro") ||
    (desired.includes("pro") && desired.includes("extended"));
  if (!wantsGpt55Pro || !resolved) {
    return;
  }
  const hasProSignal =
    resolved.includes(" pro") ||
    resolved.endsWith("pro") ||
    resolved.includes("pro ") ||
    resolved.includes("专业") ||
    resolved.includes("extended") ||
    resolved.includes("进阶") ||
    resolved.includes("gpt-5.5-pro") ||
    resolved.includes("gpt 5 5 pro");
  const hasThinkingSignal = resolved.includes("thinking") || resolved.includes("思考");
  const hasInstantSignal = resolved.includes("instant");
  const resolvedHasProSignal =
    resolved.includes("pro") || resolved.includes("专业") || resolved.includes("进阶");
  if (!hasProSignal || hasInstantSignal || (hasThinkingSignal && !resolvedHasProSignal)) {
    throw new Error(
      `Model picker selected "${resolvedLabel}" while "${desiredModel}" requires GPT-5.5 Pro Extended. Use model "gpt-5.5" with browser response effort "heavy" only when Thinking Heavy is explicitly requested.`,
    );
  }
}

export function assertResolvedModelSelectionForTest(
  desiredModel: string,
  resolvedLabel: string,
): void {
  assertResolvedModelSelection(desiredModel, resolvedLabel);
}

/**
 * Builds the DOM expression that runs inside the ChatGPT tab to select a model.
 * The string is evaluated inside Chrome, so keep it self-contained and well-commented.
 */
function buildModelSelectionExpression(
  targetModel: string,
  strategy: BrowserModelStrategy,
): string {
  const matchers = buildModelMatchersLiteral(targetModel);
  const composerSignalMatchers = buildComposerSignalMatchers(targetModel);
  const labelLiteral = JSON.stringify(matchers.labelTokens);
  const idLiteral = JSON.stringify(matchers.testIdTokens);
  const primaryLabelLiteral = JSON.stringify(targetModel);
  const strategyLiteral = JSON.stringify(strategy);
  const composerSignalSelectorLiteral = JSON.stringify(COMPOSER_MODEL_SIGNAL_SELECTOR);
  const composerIncludesLiteral = JSON.stringify(composerSignalMatchers.includesAny);
  const composerExcludesLiteral = JSON.stringify(composerSignalMatchers.excludesAny);
  const composerAllowBlankLiteral = JSON.stringify(composerSignalMatchers.allowBlank);
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  return `(() => {
    ${buildClickDispatcher()}
    // Capture the selectors and matcher literals up front so the browser expression stays pure.
    const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
    const COMPOSER_MODEL_SIGNAL_SELECTOR = ${composerSignalSelectorLiteral};
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const PRIMARY_LABEL = ${primaryLabelLiteral};
    const MODEL_STRATEGY = ${strategyLiteral};
    const COMPOSER_SIGNAL_INCLUDES = ${composerIncludesLiteral};
    const COMPOSER_SIGNAL_EXCLUDES = ${composerExcludesLiteral};
    const COMPOSER_SIGNAL_ALLOW_BLANK = ${composerAllowBlankLiteral};
    const INITIAL_WAIT_MS = 150;
    const REOPEN_INTERVAL_MS = 400;
    const MENU_OPEN_GRACE_MS = 4000;
    const MAX_WAIT_MS = 20000;
    const SETTLE_WAIT_MS = 1500;
    const normalizeText = (value) => {
      if (!value) {
        return '';
      }
      return value
        .toLowerCase()
        .replace(/[^a-z0-9\\u4e00-\\u9fff]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
    };
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      return true;
    };
    const readableLabelFor = (node) =>
      (node?.textContent || node?.getAttribute?.('aria-label') || node?.getAttribute?.('title') || '').trim();
    const getMenuRoots = () =>
      Array.from(document.querySelectorAll(${menuContainerLiteral})).filter((node) => isVisible(node));
    const collectVisibleControls = () => {
      const controls = Array.from(document.querySelectorAll('button,a,[role="button"],[role="menuitem"],[role="menuitemradio"]'))
        .filter((node) => isVisible(node))
        .map(readableLabelFor)
        .filter(Boolean);
      return Array.from(new Set(controls)).slice(0, 12);
    };
    const detectPageInterruption = () => {
      const title = document.title || '';
      const url = window.location.href || '';
      const rawBody = document.body?.innerText || '';
      const text = normalizeText([title, url, rawBody.slice(0, 20000)].join(' '));
      const evidence = [];
      const pushEvidence = (label) => {
        if (label && !evidence.includes(label)) evidence.push(label);
      };
      const hasCloudflareDom = Boolean(
        document.querySelector(
          'script[src*="challenge-platform"], iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"], [data-cf-beacon], [id^="cf-"], [class*="cf-turnstile"]',
        )
      );
      const hasCloudflareUrl =
        url.includes('/cdn-cgi/') || url.includes('challenges.cloudflare.com');
      const hasCloudflareChallengeText =
        text.includes('just a moment') ||
        text.includes('checking your browser') ||
        text.includes('review the security');
      if (hasCloudflareDom) pushEvidence('cloudflare challenge markup');
      if (text.includes('just a moment')) pushEvidence('Just a moment');
      if (text.includes('checking your browser')) pushEvidence('checking your browser');
      if (text.includes('review the security')) pushEvidence('security review');
      if (text.includes('cloudflare') && (hasCloudflareDom || hasCloudflareUrl || hasCloudflareChallengeText)) {
        pushEvidence('Cloudflare');
      }
      if (hasCloudflareUrl) {
        pushEvidence('Cloudflare challenge URL');
      }
      if (hasCloudflareDom || hasCloudflareUrl || hasCloudflareChallengeText) {
        return { kind: 'cloudflare-challenge', title, url, evidence };
      }
      if (
        text.includes('verify you are human') ||
        text.includes('human verification') ||
        text.includes('captcha') ||
        text.includes('confirm you are human') ||
        text.includes('请验证') ||
        text.includes('人机验证')
      ) {
        pushEvidence('manual verification');
        return { kind: 'manual-verification-required', title, url, evidence };
      }
      const loginCta = Array.from(document.querySelectorAll('a,button')).some((node) => {
        if (!isVisible(node)) return false;
        const label = normalizeText(readableLabelFor(node));
        const href = node.getAttribute?.('href') || '';
        return (
          label === 'log in' ||
          label === 'login' ||
          label === 'sign in' ||
          label.includes('continue with google') ||
          href.includes('/auth/login') ||
          href.includes('/login')
        );
      });
      if (loginCta && !document.querySelector(BUTTON_SELECTOR)) {
        return { kind: 'chatgpt-login-required', title, url, evidence: ['login prompt'] };
      }
      return null;
    };
    // Normalize every candidate token to keep fuzzy matching deterministic.
    const normalizedTarget = normalizeText(PRIMARY_LABEL);
    const normalizedTokens = Array.from(new Set([normalizedTarget, ...LABEL_TOKENS]))
      .map((token) => normalizeText(token))
      .filter(Boolean);
    const targetWords = normalizedTarget.split(' ').filter(Boolean);
    const desiredVersionMatch = normalizedTarget.match(/\\b([0-9]+)\\s+([0-9]+)\\b/);
    const desiredVersion = desiredVersionMatch
      ? desiredVersionMatch[1] + '-' + desiredVersionMatch[2]
      : null;
    const hasProText = (value) =>
      value.includes(' pro') ||
      value.startsWith('pro ') ||
      value.endsWith(' pro') ||
      value === 'pro' ||
      value.includes('proresearch') ||
      value.includes('专业');
    const hasExtendedText = (value) =>
      value.includes('extended') ||
      value.includes('进阶') ||
      value.includes('advanced');
    const hasThinkingText = (value) => value.includes('thinking') || value.includes('思考');
    const wantsPro = hasProText(normalizedTarget) || normalizedTokens.some((token) => hasProText(token));
    const wantsInstant = normalizedTarget.includes('instant');
    const wantsThinking = hasThinkingText(normalizedTarget);
    const wantsExtended = hasExtendedText(normalizedTarget);
    const isTargetGpt55VisibleAlias = (value) => {
      if (!(wantsPro && (wantsExtended || desiredVersion === '5-5'))) return false;
      const label = normalizeText(value);
      const labelVersion = label.match(/\\b([0-9]+)\\s+([0-9]+)\\b/);
      const candidateVersion = labelVersion ? labelVersion[1] + '-' + labelVersion[2] : null;
      if (desiredVersion && candidateVersion && candidateVersion !== desiredVersion) {
        return false;
      }
      if (hasProText(label) && hasExtendedText(label) && !hasThinkingText(label)) {
        return true;
      }
      return false;
    };
    const hasProComposerPill = () =>
      Array.from(
        document.querySelectorAll(
          'button.__composer-pill, button[aria-label="Pro, click to remove"], button[aria-label*="Pro, click"]',
        ),
      ).some((node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
        const value = normalizeText(
          [
            node.getAttribute('aria-label') || '',
            node.getAttribute('title') || '',
            node.textContent || '',
          ].join(' '),
        );
        if (!value || hasThinkingText(value)) return false;
        if (!hasProText(value) && !hasExtendedText(value)) return false;
        // The current model button is also a composer pill in ChatGPT's newer UI.
        // Only count it as a Pro signal when its own label says Pro/Extended.
        if (node.matches(BUTTON_SELECTOR)) {
          const buttonValue = normalizeText(readableLabelFor(node));
          return (
            isTargetGpt55VisibleAlias(buttonValue) ||
            ((hasProText(buttonValue) || hasExtendedText(buttonValue)) &&
              !hasThinkingText(buttonValue))
          );
        }
        return true;
      });
    const compactVersion = (version) => version.replace(/-/g, '');
    const spacedVersion = (version) => version.replace(/-/g, ' ');
    const dottedVersion = (version) => version.replace(/-/g, '.');
    const versionFromTestId = (testid) => {
      const value = (testid ?? '').toLowerCase();
      const dottedOrDashed = value.match(/(?:^|[^0-9])([0-9]+)[-.]([0-9]+)(?:[^0-9]|$)/);
      if (dottedOrDashed) {
        return dottedOrDashed[1] + '-' + dottedOrDashed[2];
      }
      const compact = value.match(/gpt[-_]?([0-9])([0-9])(?:[^0-9]|$)/);
      if (compact) {
        return compact[1] + '-' + compact[2];
      }
      return null;
    };

    const initialInterruption = detectPageInterruption();
    const button = document.querySelector(BUTTON_SELECTOR);
    if (!button) {
      if (initialInterruption) {
        return { status: 'interrupted', interruption: initialInterruption };
      }
      return { status: 'button-missing' };
    }

    const menuIsOpen = () => getMenuRoots().length > 0;
    const closeMenu = () => {
      if (!menuIsOpen()) {
        return;
      }
      try {
        if (dispatchClickSequence(button)) {
          lastPointerClick = performance.now();
          return;
        }
      } catch {}
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
          }),
        );
      } catch {}
    };

    const getButtonLabel = () => (button.textContent ?? '').trim();
    const getComposerModelLabel = () =>
      (document.querySelector(COMPOSER_MODEL_SIGNAL_SELECTOR)?.textContent ?? '').trim();
    const readComposerModelSignal = () => normalizeText(getComposerModelLabel());
    const withProPillSignal = (label) => {
      const resolved = label || '';
      if (!wantsPro || !hasProComposerPill()) return resolved;
      const normalized = normalizeText(resolved);
      if (!normalized) return 'Pro';
      if (hasProText(normalized) || hasExtendedText(normalized)) return resolved;
      if (normalized !== 'chatgpt') return resolved;
      return resolved + ' + Pro';
    };
    const getResolvedLabel = (fallback) =>
      withProPillSignal(getComposerModelLabel() || getButtonLabel() || fallback);
    if (MODEL_STRATEGY === 'current') {
      const currentLabel = getResolvedLabel(PRIMARY_LABEL);
      return {
        status: 'already-selected',
        label: currentLabel,
      };
    }
    const buttonMatchesTarget = () => {
      const normalizedLabel = normalizeText(getButtonLabel());
      if (!normalizedLabel) return false;
      if (isTargetGpt55VisibleAlias(normalizedLabel)) return true;
      if (wantsPro && normalizedLabel === 'chatgpt' && hasProComposerPill()) {
        return true;
      }
      if (desiredVersion) {
        if (!normalizedLabel.includes(spacedVersion(desiredVersion))) return false;
      }
      if (wantsPro && !hasProText(normalizedLabel) && !hasExtendedText(normalizedLabel)) return false;
      if (wantsInstant && !normalizedLabel.includes('instant')) return false;
      if (wantsThinking && !normalizedLabel.includes('thinking')) return false;
      // Also reject if button has variants we DON'T want
      if (!wantsPro && hasProText(normalizedLabel)) return false;
      if (!wantsInstant && normalizedLabel.includes('instant')) return false;
      if (!wantsThinking && normalizedLabel.includes('thinking')) return false;
      return true;
    };
    const buttonHasGenericLabel = () => {
      const normalizedLabel = normalizeText(getButtonLabel());
      return !normalizedLabel || normalizedLabel === 'chatgpt';
    };
    const composerSignalMatchesTarget = () => {
      const signal = readComposerModelSignal();
      if (!signal) {
        return COMPOSER_SIGNAL_ALLOW_BLANK;
      }
      if (COMPOSER_SIGNAL_EXCLUDES.some((token) => token && signal.includes(token))) {
        return false;
      }
      if (COMPOSER_SIGNAL_INCLUDES.length === 0) {
        return true;
      }
      return COMPOSER_SIGNAL_INCLUDES.some((token) => token && signal.includes(token));
    };
    const activeSelectionMatchesTarget = () => {
      if (buttonMatchesTarget()) {
        return true;
      }
      if (!buttonHasGenericLabel()) {
        return false;
      }
      return composerSignalMatchesTarget();
    };
    const selectionStateChanged = (previousButtonLabel, previousComposerSignal) => {
      const currentButtonLabel = normalizeText(getButtonLabel());
      const currentComposerSignal = readComposerModelSignal();
      if (
        currentButtonLabel &&
        currentButtonLabel !== previousButtonLabel &&
        !buttonHasGenericLabel()
      ) {
        return true;
      }
      return currentComposerSignal !== previousComposerSignal;
    };

    if (activeSelectionMatchesTarget()) {
      return { status: 'already-selected', label: getResolvedLabel(PRIMARY_LABEL) };
    }

    let lastPointerClick = 0;
    const pointerClick = () => {
      if (dispatchClickSequence(button)) {
        lastPointerClick = performance.now();
      }
    };

    const getOptionLabel = (node) => node?.textContent?.trim() ?? '';
    const isThinkingEffortControl = (node) =>
      node instanceof HTMLElement &&
      (node.getAttribute('data-model-picker-thinking-effort-action') === 'true' ||
        Boolean(node.closest('[data-model-picker-thinking-effort-action="true"]')));
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataSelected = node.getAttribute('data-selected');
      const dataState = (node.getAttribute('data-state') ?? '').toLowerCase();
      const selectedStates = ['checked', 'selected', 'on', 'true'];
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') {
        return true;
      }
      if (dataSelected === 'true' || selectedStates.includes(dataState)) {
        return true;
      }
      if (node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"], .trailing svg')) {
        return true;
      }
      return false;
    };

    const scoreOption = (normalizedText, testid) => {
      // Assign a score to every node so we can pick the most likely match without brittle equality checks.
      if (!normalizedText && !testid) {
        return 0;
      }
      let score = 0;
      const normalizedTestId = (testid ?? '').toLowerCase();
      if (normalizedTestId) {
        if (desiredVersion) {
          // data-testid strings have been observed with dotted, dashed, and compact versions.
          const candidateVersion = versionFromTestId(normalizedTestId);
          // If a candidate advertises a different version, ignore it entirely.
          if (candidateVersion && candidateVersion !== desiredVersion) {
            return 0;
          }
          // When targeting an explicit version, avoid selecting submenu wrappers that can contain legacy models.
          if (normalizedTestId.includes('submenu') && candidateVersion === null) {
            return 0;
          }
        }
        // Exact testid matches take priority over substring matches
        const exactMatch = TEST_IDS.find((id) => id && normalizedTestId === id);
        if (exactMatch) {
          score += 1500;
          if (exactMatch.startsWith('model-switcher-')) score += 200;
        } else {
          const matches = TEST_IDS.filter((id) => id && normalizedTestId.includes(id));
          if (matches.length > 0) {
            // Prefer the most specific match (longest token) instead of treating any hit as equal.
            // This prevents generic tokens (e.g. "pro") from outweighing version-specific targets.
            const best = matches.reduce((acc, token) => (token.length > acc.length ? token : acc), '');
            score += 200 + Math.min(900, best.length * 25);
            if (best.startsWith('model-switcher-')) score += 120;
            if (best.includes('gpt-')) score += 60;
          }
        }
      }
      const candidateGpt55VisibleAlias = isTargetGpt55VisibleAlias(normalizedText);
      const candidateHasThinking =
        hasThinkingText(normalizedText) || normalizedTestId.includes('thinking');
      const candidateHasPro =
        candidateGpt55VisibleAlias ||
        hasProText(normalizedText) ||
        normalizedTestId.includes('pro');
      if (wantsPro && candidateHasThinking) return 0;
      if (wantsPro && !candidateHasPro) return 0;
      if (wantsThinking && candidateHasPro) return 0;
      if (desiredVersion === '5-5' && normalizedText && !candidateGpt55VisibleAlias) {
        const candidateHasVersion =
          normalizedText.includes('5 5') ||
          normalizedText.includes('gpt55') ||
          normalizedText.includes('gpt 5 5');
        const versionLikeLabel = /(?:^|\\s)5\\s+[0-9](?:\\s|$)/.test(normalizedText) || normalizedText.includes('gpt');
        if (versionLikeLabel && !candidateHasVersion) {
          return 0;
        }
      }
      if (candidateGpt55VisibleAlias) {
        score += 900;
      }
      if (normalizedText && normalizedTarget) {
        if (normalizedText === normalizedTarget) {
          score += 500;
        } else if (normalizedText.startsWith(normalizedTarget)) {
          score += 420;
        } else if (normalizedText.includes(normalizedTarget)) {
          score += 380;
        }
      }
      for (const token of normalizedTokens) {
        // Reward partial matches to the expanded label/token set.
        if (token && normalizedText.includes(token)) {
          const tokenWeight = Math.min(120, Math.max(10, token.length * 4));
          score += tokenWeight;
        }
      }
      if (targetWords.length > 1) {
        let missing = 0;
        for (const word of targetWords) {
          if (!normalizedText.includes(word)) {
            missing += 1;
          }
        }
        score -= missing * 12;
      }
      // If the caller didn't explicitly ask for Pro, prefer non-Pro options when both exist.
      if (wantsPro) {
        if (!hasProText(normalizedText)) {
          score -= 80;
        }
      } else if (hasProText(normalizedText)) {
        score -= 40;
      }
      // Similarly for Thinking variant
      if (wantsThinking) {
        if (!normalizedText.includes('thinking') && !normalizedTestId.includes('thinking')) {
          score -= 80;
        }
      } else if (hasThinkingText(normalizedText) || normalizedTestId.includes('thinking')) {
        score -= 40;
      }
      // Similarly for Instant variant
      if (wantsInstant) {
        if (!normalizedText.includes('instant') && !normalizedTestId.includes('instant')) {
          score -= 80;
        }
      } else if (normalizedText.includes('instant') || normalizedTestId.includes('instant')) {
        score -= 40;
      }
      return Math.max(score, 0);
    };

    const findBestOption = () => {
      // Walk through every menu item and keep whichever earns the highest score.
      let bestMatch = null;
      const menus = getMenuRoots();
      for (const menu of menus) {
        const buttons = Array.from(menu.querySelectorAll(${menuItemLiteral}));
        for (const option of buttons) {
          if (isThinkingEffortControl(option)) {
            continue;
          }
          const text = option.textContent ?? '';
          const normalizedText = normalizeText(text);
          const testid = option.getAttribute('data-testid') ?? '';
          const score = scoreOption(normalizedText, testid);
          if (score <= 0) {
            continue;
          }
          const label = getOptionLabel(option);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { node: option, label, score, testid, normalizedText };
          }
        }
      }
      return bestMatch;
    };
    const waitForTargetSelection = (clickedNode, previousButtonLabel, previousComposerSignal) => new Promise((resolve) => {
      const waitStart = performance.now();
      const check = () => {
        if (optionIsSelected(clickedNode)) {
          resolve('target');
          return;
        }
        if (activeSelectionMatchesTarget()) {
          resolve('target');
          return;
        }
        if (selectionStateChanged(previousButtonLabel, previousComposerSignal)) {
          resolve('changed');
          return;
        }
        if (performance.now() - waitStart > SETTLE_WAIT_MS) {
          resolve('timeout');
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    return new Promise((resolve) => {
      const start = performance.now();
      const detectTemporaryChat = () => {
        try {
          const url = new URL(window.location.href);
          const flag = (url.searchParams.get('temporary-chat') ?? '').toLowerCase();
          if (flag === 'true' || flag === '1' || flag === 'yes') return true;
        } catch {}
        const title = (document.title || '').toLowerCase();
        if (title.includes('temporary chat')) return true;
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes('temporary chat');
      };
      const collectAvailableOptions = () => {
        const menuRoots = getMenuRoots();
        const nodes = menuRoots.flatMap((root) => Array.from(root.querySelectorAll(${menuItemLiteral})));
        const labels = nodes
          .map((node) => (node?.textContent ?? '').trim())
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index);
        return labels.slice(0, 12);
      };
      let menuEverOpened = false;
      const ensureMenuOpen = () => {
        const menuOpen = menuIsOpen();
        if (menuOpen) {
          menuEverOpened = true;
          return;
        }
        if (!menuOpen && performance.now() - lastPointerClick > REOPEN_INTERVAL_MS) {
          pointerClick();
        }
      };

      // Open once and wait a tick before first scan, unless the picker is already open.
      if (menuIsOpen()) {
        menuEverOpened = true;
      } else {
        pointerClick();
      }
      const openDelay = () => new Promise((r) => setTimeout(r, INITIAL_WAIT_MS));
      let initialized = false;
      const attempt = async () => {
        if (!initialized) {
          initialized = true;
          await openDelay();
        }
        ensureMenuOpen();
        const interruption = detectPageInterruption();
        if (interruption && performance.now() - start > INITIAL_WAIT_MS) {
          resolve({ status: 'interrupted', interruption });
          return;
        }
        if (performance.now() - start > MAX_WAIT_MS) {
          resolve({
            status: 'option-not-found',
            hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
          });
          return;
        }
        if (!menuEverOpened && performance.now() - start > MENU_OPEN_GRACE_MS) {
          resolve({
            status: 'model-menu-not-opened',
            hint: { visibleControls: collectVisibleControls(), interruption: detectPageInterruption() },
          });
          return;
        }
        const match = findBestOption();
        if (match) {
          if (optionIsSelected(match.node)) {
            closeMenu();
            resolve({ status: 'already-selected', label: getResolvedLabel(match.label) });
            return;
          }
          if (activeSelectionMatchesTarget()) {
            closeMenu();
            resolve({ status: 'already-selected', label: getResolvedLabel(match.label) });
            return;
          }
          const previousButtonLabel = normalizeText(getButtonLabel());
          const previousComposerSignal = readComposerModelSignal();
          dispatchClickSequence(match.node);
          // Submenus (e.g. "Legacy models") need a second pass to pick the actual model option.
          // Keep scanning once the submenu opens instead of treating the submenu click as a final switch.
          const isSubmenu = (match.testid ?? '').toLowerCase().includes('submenu');
          if (isSubmenu) {
            setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
            return;
          }
          // Wait for the selected model signal to settle before reopening the picker.
          waitForTargetSelection(match.node, previousButtonLabel, previousComposerSignal).then((selectionSettled) => {
            if (selectionSettled === 'target') {
              closeMenu();
              resolve({ status: 'switched', label: getResolvedLabel(match.label) });
              return;
            }
            attempt();
          });
          return;
        }
        setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
      };
      attempt();
    });
  })()`;
}

export function buildModelMatchersLiteralForTest(targetModel: string) {
  return buildModelMatchersLiteral(targetModel);
}

type ComposerSignalMatchers = {
  includesAny: string[];
  excludesAny: string[];
  allowBlank: boolean;
};

function buildComposerSignalMatchers(targetModel: string): ComposerSignalMatchers {
  const normalized = targetModel
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.includes("pro")) {
    return {
      includesAny: ["pro", "专业", "进阶"],
      excludesAny: ["thinking", "思考"],
      allowBlank: false,
    };
  }
  if (normalized.includes("thinking")) {
    return { includesAny: ["thinking", "思考"], excludesAny: ["pro", "专业"], allowBlank: false };
  }
  if (normalized.includes("instant")) {
    return { includesAny: [], excludesAny: ["thinking", "思考", "pro", "专业"], allowBlank: true };
  }
  return { includesAny: [], excludesAny: ["thinking", "思考", "pro", "专业"], allowBlank: true };
}

export function buildComposerSignalMatchersForTest(targetModel: string): ComposerSignalMatchers {
  return buildComposerSignalMatchers(targetModel);
}

function buildModelMatchersLiteral(targetModel: string): {
  labelTokens: string[];
  testIdTokens: string[];
} {
  const base = targetModel.trim().toLowerCase();
  const labelTokens = new Set<string>();
  const testIdTokens = new Set<string>();

  const push = (value: string | null | undefined, set: Set<string>) => {
    const normalized = value?.trim();
    if (normalized) {
      set.add(normalized);
    }
  };

  push(base, labelTokens);
  push(base.replace(/\s+/g, " "), labelTokens);
  const collapsed = base.replace(/\s+/g, "");
  push(collapsed, labelTokens);
  const dotless = base.replace(/[.]/g, "");
  push(dotless, labelTokens);
  push(`chatgpt ${base}`, labelTokens);
  push(`chatgpt ${dotless}`, labelTokens);
  push(`gpt ${base}`, labelTokens);
  push(`gpt ${dotless}`, labelTokens);
  const genericVersion =
    base.match(/(?:^|[^0-9])([0-9]+)[._-]([0-9]+)(?:[^0-9]|$)/) ??
    base.match(/gpt[-_]?([0-9])([0-9])(?:[^0-9]|$)/);
  const genericVersionParts = genericVersion
    ? { major: genericVersion[1], minor: genericVersion[2] }
    : null;
  if (genericVersionParts) {
    const { major, minor } = genericVersionParts;
    const dotted = `${major}.${minor}`;
    const dashed = `${major}-${minor}`;
    const compactVersion = `${major}${minor}`;
    push(dotted, labelTokens);
    push(`gpt-${dotted}`, labelTokens);
    push(`gpt${dotted}`, labelTokens);
    push(`gpt-${dashed}`, labelTokens);
    push(`gpt${dashed}`, labelTokens);
    push(`gpt${compactVersion}`, labelTokens);
    push(`chatgpt ${dotted}`, labelTokens);
    if (base.includes("thinking")) {
      push("thinking", labelTokens);
      testIdTokens.add(`model-switcher-gpt-${dashed}-thinking`);
      testIdTokens.add(`gpt-${dashed}-thinking`);
      testIdTokens.add(`gpt-${dotted}-thinking`);
    }
    if (base.includes("instant")) {
      push("instant", labelTokens);
      testIdTokens.add(`model-switcher-gpt-${dashed}`);
      testIdTokens.add(`gpt-${dashed}`);
      testIdTokens.add(`gpt-${dotted}`);
    }
    if (!base.includes("pro") && !base.includes("thinking") && !base.includes("instant")) {
      testIdTokens.add(`model-switcher-gpt-${dashed}`);
    }
    testIdTokens.add(`gpt-${dashed}`);
    testIdTokens.add(`gpt${dashed}`);
    testIdTokens.add(`gpt${compactVersion}`);
  }
  // Numeric variations (5.5 <-> 55 <-> gpt-5-5)
  if (base.includes("5.5") || base.includes("5-5") || base.includes("55")) {
    push("5.5", labelTokens);
    push("gpt-5.5", labelTokens);
    push("gpt5.5", labelTokens);
    push("gpt-5-5", labelTokens);
    push("gpt5-5", labelTokens);
    push("gpt55", labelTokens);
    push("chatgpt 5.5", labelTokens);
    if (base.includes("thinking")) {
      push("thinking heavy", labelTokens);
      push("heavy thinking", labelTokens);
      testIdTokens.add("model-switcher-gpt-5-5-thinking");
      testIdTokens.add("gpt-5-5-thinking");
      testIdTokens.add("gpt-5.5-thinking");
    }
    if (!base.includes("pro") && !base.includes("thinking")) {
      testIdTokens.add("model-switcher-gpt-5-5");
    }
    testIdTokens.add("gpt-5-5");
    testIdTokens.add("gpt5-5");
    testIdTokens.add("gpt55");
  }
  // Numeric variations (5.4 ↔ 54 ↔ gpt-5-4)
  if (base.includes("5.4") || base.includes("5-4") || base.includes("54")) {
    push("5.4", labelTokens);
    push("gpt-5.4", labelTokens);
    push("gpt5.4", labelTokens);
    push("gpt-5-4", labelTokens);
    push("gpt5-4", labelTokens);
    push("gpt54", labelTokens);
    push("chatgpt 5.4", labelTokens);
    if (!base.includes("pro")) {
      testIdTokens.add("model-switcher-gpt-5-4");
    }
    testIdTokens.add("gpt-5-4");
    testIdTokens.add("gpt5-4");
    testIdTokens.add("gpt54");
  }
  // Numeric variations (5.1 ↔ 51 ↔ gpt-5-1)
  if (base.includes("5.1") || base.includes("5-1") || base.includes("51")) {
    push("5.1", labelTokens);
    push("gpt-5.1", labelTokens);
    push("gpt5.1", labelTokens);
    push("gpt-5-1", labelTokens);
    push("gpt5-1", labelTokens);
    push("gpt51", labelTokens);
    push("chatgpt 5.1", labelTokens);
    testIdTokens.add("gpt-5-1");
    testIdTokens.add("gpt5-1");
    testIdTokens.add("gpt51");
  }
  // Numeric variations (5.0 ↔ 50 ↔ gpt-5-0)
  if (base.includes("5.0") || base.includes("5-0") || base.includes("50")) {
    push("5.0", labelTokens);
    push("gpt-5.0", labelTokens);
    push("gpt5.0", labelTokens);
    push("gpt-5-0", labelTokens);
    push("gpt5-0", labelTokens);
    push("gpt50", labelTokens);
    push("chatgpt 5.0", labelTokens);
    testIdTokens.add("gpt-5-0");
    testIdTokens.add("gpt5-0");
    testIdTokens.add("gpt50");
  }
  // Numeric variations (5.2 ↔ 52 ↔ gpt-5-2)
  if (base.includes("5.2") || base.includes("5-2") || base.includes("52")) {
    push("5.2", labelTokens);
    push("gpt-5.2", labelTokens);
    push("gpt5.2", labelTokens);
    push("gpt-5-2", labelTokens);
    push("gpt5-2", labelTokens);
    push("gpt52", labelTokens);
    push("chatgpt 5.2", labelTokens);
    // Thinking variant: explicit testid for "Thinking" picker option
    if (base.includes("thinking")) {
      push("thinking", labelTokens);
      testIdTokens.add("model-switcher-gpt-5-2-thinking");
      testIdTokens.add("gpt-5-2-thinking");
      testIdTokens.add("gpt-5.2-thinking");
    }
    // Instant variant: explicit testid for "Instant" picker option
    if (base.includes("instant")) {
      push("instant", labelTokens);
      testIdTokens.add("model-switcher-gpt-5-2-instant");
      testIdTokens.add("gpt-5-2-instant");
      testIdTokens.add("gpt-5.2-instant");
    }
    // Base 5.2 testids (for "Auto" mode when no suffix specified)
    if (!base.includes("thinking") && !base.includes("instant") && !base.includes("pro")) {
      testIdTokens.add("model-switcher-gpt-5-2");
    }
    testIdTokens.add("gpt-5-2");
    testIdTokens.add("gpt5-2");
    testIdTokens.add("gpt52");
  }
  // Pro / research variants
  if (base.includes("pro")) {
    push("proresearch", labelTokens);
    push("research grade", labelTokens);
    push("advanced reasoning", labelTokens);
    push("进阶", labelTokens);
    push("专业", labelTokens);
    push("进阶专业", labelTokens);
    push("专业进阶", labelTokens);
    if (base.includes("extended")) {
      push("extended", labelTokens);
      push("extended pro", labelTokens);
      push("pro extended", labelTokens);
    }
    if (genericVersionParts) {
      const { major, minor } = genericVersionParts;
      const dotted = `${major}.${minor}`;
      const dashed = `${major}-${minor}`;
      const compactVersion = `${major}${minor}`;
      testIdTokens.add(`model-switcher-gpt-${dashed}-pro`);
      testIdTokens.add(`gpt-${dotted}-pro`);
      testIdTokens.add(`gpt-${dashed}-pro`);
      testIdTokens.add(`gpt${compactVersion}pro`);
    }
    if (base.includes("5.5") || base.includes("5-5") || base.includes("55")) {
      push("pro extended", labelTokens);
      push("extended pro", labelTokens);
      testIdTokens.add("gpt-5.5-pro");
      testIdTokens.add("gpt-5-5-pro");
      testIdTokens.add("gpt55pro");
    }
    if (base.includes("5.4") || base.includes("5-4") || base.includes("54")) {
      testIdTokens.add("gpt-5.4-pro");
      testIdTokens.add("gpt-5-4-pro");
      testIdTokens.add("gpt54pro");
    }
    if (base.includes("5.1") || base.includes("5-1") || base.includes("51")) {
      testIdTokens.add("gpt-5.1-pro");
      testIdTokens.add("gpt-5-1-pro");
      testIdTokens.add("gpt51pro");
    }
    if (base.includes("5.0") || base.includes("5-0") || base.includes("50")) {
      testIdTokens.add("gpt-5.0-pro");
      testIdTokens.add("gpt-5-0-pro");
      testIdTokens.add("gpt50pro");
    }
    if (base.includes("5.2") || base.includes("5-2") || base.includes("52")) {
      testIdTokens.add("gpt-5.2-pro");
      testIdTokens.add("gpt-5-2-pro");
      testIdTokens.add("gpt52pro");
    }
    testIdTokens.add("pro");
    testIdTokens.add("proresearch");
  }
  base
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      push(token, labelTokens);
    });

  const hyphenated = base.replace(/\s+/g, "-");
  push(hyphenated, testIdTokens);
  push(collapsed, testIdTokens);
  push(dotless, testIdTokens);
  // data-testid values observed in the ChatGPT picker (e.g., model-switcher-gpt-5.1-pro)
  push(`model-switcher-${hyphenated}`, testIdTokens);
  push(`model-switcher-${collapsed}`, testIdTokens);
  push(`model-switcher-${dotless}`, testIdTokens);

  if (!labelTokens.size) {
    labelTokens.add(base);
  }
  if (!testIdTokens.size) {
    testIdTokens.add(base.replace(/\s+/g, "-"));
  }

  return {
    labelTokens: Array.from(labelTokens).filter(Boolean),
    testIdTokens: Array.from(testIdTokens).filter(Boolean),
  };
}

export function buildModelSelectionExpressionForTest(
  targetModel: string,
  strategy: BrowserModelStrategy = "select",
): string {
  return buildModelSelectionExpression(targetModel, strategy);
}
