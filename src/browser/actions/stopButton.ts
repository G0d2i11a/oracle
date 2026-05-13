import { STOP_BUTTON_LABEL_PATTERN, STOP_BUTTON_SELECTORS } from "../constants.js";

export function buildVisibleStopButtonFunction(functionName = "hasVisibleStopButton"): string {
  const selectorsLiteral = JSON.stringify(STOP_BUTTON_SELECTORS);
  const labelPatternLiteral = JSON.stringify(STOP_BUTTON_LABEL_PATTERN);
  return `
    const ${functionName} = () => {
      const stopSelectors = ${selectorsLiteral};
      const stopLabelPattern = new RegExp(${labelPatternLiteral}, 'i');
      const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const isVisibleStopCandidate = (node) => {
        if (!node || (typeof HTMLElement !== 'undefined' && !(node instanceof HTMLElement))) return false;
        if (typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const style =
          typeof getComputedStyle === 'function'
            ? getComputedStyle(node)
            : typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
              ? window.getComputedStyle(node)
              : { display: 'block', visibility: 'visible', opacity: '1' };
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0;
      };
      const isNavigationOrMenuLabel = (label) =>
        /open conversation options|history-item|chat history|open profile menu|accounts-profile-button|share|copy|archive|unarchive|model|dictation|voice|add files|new chat|search chats/i.test(label);
      const isOperationalStopLabel = (node) => {
        const aria = normalize(node.getAttribute?.('aria-label'));
        const title = normalize(node.getAttribute?.('title'));
        const testId = normalize(node.getAttribute?.('data-testid'));
        const text = normalize(node.textContent);
        const label = normalize([
          aria,
          title,
          testId,
          text.length > 0 && text.length <= 48 ? text : '',
        ].filter(Boolean).join(' '));
        if (!label || isNavigationOrMenuLabel(label)) return false;
        return stopLabelPattern.test(label);
      };
      const candidates = new Set();
      for (const selector of stopSelectors) {
        document.querySelectorAll(selector).forEach((node) => candidates.add(node));
      }
      document.querySelectorAll('button,[role="button"]').forEach((node) => {
        if (isOperationalStopLabel(node)) candidates.add(node);
      });
      return Array.from(candidates).some(isVisibleStopCandidate);
    };
  `;
}

export function buildVisibleStopButtonExpressionForTest(
  functionName = "hasVisibleStopButton",
): string {
  return buildVisibleStopButtonFunction(functionName);
}
