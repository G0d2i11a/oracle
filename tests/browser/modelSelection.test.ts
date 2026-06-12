import { describe, expect, it, vi } from "vitest";
import {
  assertResolvedModelSelectionForTest,
  buildComposerSignalMatchersForTest,
  buildModelMatchersLiteralForTest,
  buildModelSelectionExpressionForTest,
  ensureModelSelection,
} from "../../src/browser/actions/modelSelection.js";

const expectContains = (arr: string[], value: string) => {
  expect(arr).toContain(value);
};

describe("browser model selection matchers", () => {
  it("includes pro + 5.5 tokens for gpt-5.5-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.5-pro");
    expect(labelTokens).toContain("pro extended");
    expect(labelTokens.some((t) => t.includes("5.5") || t.includes("5-5"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.5-pro") || t.includes("gpt-5-5-pro"))).toBe(
      true,
    );
  });

  it("includes pro + 5.4 tokens for gpt-5.4-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.4-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.4") || t.includes("5-4"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.4-pro") || t.includes("gpt-5-4-pro"))).toBe(
      true,
    );
  });

  it("includes extended pro + 5.5 tokens for ChatGPT 5.5 Extended Pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("5.5 Extended Pro");
    expect(labelTokens).toContain("extended pro");
    expect(labelTokens).toContain("进阶");
    expect(labelTokens).toContain("进阶专业");
    expect(testIdTokens).toContain("model-switcher-gpt-5-5-pro");
  });

  it("builds future GPT version tokens without version-specific hardcoding", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("5.7 Extended Pro");
    expect(labelTokens).toContain("gpt-5.7");
    expect(labelTokens).toContain("extended pro");
    expect(testIdTokens).toContain("model-switcher-gpt-5-7-pro");
    expect(testIdTokens).toContain("gpt-5.7-pro");
  });

  it("includes rich tokens for gpt-5.1", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.1");
    expectContains(labelTokens, "gpt-5.1");
    expectContains(labelTokens, "gpt-5-1");
    expectContains(labelTokens, "gpt51");
    expectContains(labelTokens, "chatgpt 5.1");
    expectContains(testIdTokens, "gpt-5-1");
    expect(
      testIdTokens.some(
        (t) => t.includes("gpt-5.1") || t.includes("gpt-5-1") || t.includes("gpt51"),
      ),
    ).toBe(true);
  });

  it("includes pro/research tokens for gpt-5.2-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-pro");
    expect(labelTokens.some((t) => t.includes("pro") || t.includes("research"))).toBe(true);
    expectContains(testIdTokens, "gpt-5.2-pro");
    expect(testIdTokens.some((t) => t.includes("model-switcher-gpt-5.2-pro"))).toBe(true);
  });

  it("includes pro + 5.2 tokens for gpt-5.2-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.2-pro") || t.includes("gpt-5-2-pro"))).toBe(
      true,
    );
  });

  it("includes thinking tokens for gpt-5.2-thinking", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-thinking");
    expect(labelTokens.some((t) => t.includes("thinking"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-2-thinking");
    expect(testIdTokens).toContain("gpt-5.2-thinking");
  });

  it("includes instant tokens for gpt-5.2-instant", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-instant");
    expect(labelTokens.some((t) => t.includes("instant"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-2-instant");
    expect(testIdTokens).toContain("gpt-5.2-instant");
  });

  it("closes the menu after a successful selection path", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4");
    expect(expression).toContain("const closeMenu = () =>");
    expect(expression).toContain("const menuIsOpen = () =>");
    expect(expression).toContain("if (!menuIsOpen()) {");
    expect(expression).toContain("key: 'Escape'");
    expect(expression).toContain("closeMenu();");
    expect(expression).toContain("COMPOSER_MODEL_SIGNAL_SELECTOR");
    expect(expression).toContain("activeSelectionMatchesTarget");
    expect(expression).toContain("isThinkingEffortControl");
    expect(expression).toContain("wantsExtended");
    expect(expression).toContain("desiredVersionMatch");
    expect(expression).toContain("versionFromTestId");
  });

  it("treats Pro/Thinking/Instant as hard variant requirements", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4-pro");
    expect(expression).toContain("const candidateHasPro =");
    expect(expression).toContain("const candidateHasThinking =");
    expect(expression).toContain("if (wantsPro && candidateHasThinking) return 0;");
    expect(expression).toContain("if (wantsPro && !candidateHasPro) return 0;");
  });

  it("recognizes current GPT-5.5 visible aliases in the picker expression", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("isTargetGpt55VisibleAlias");
    expect(expression).toContain("const hasProText =");
    expect(expression).toContain("value.includes('专业')");
    expect(expression).toContain("const hasExtendedText =");
    expect(expression).toContain("desiredVersion === '5-5'");
  });

  it("accepts the current Extended Pro page label when targeting GPT-5.5 Pro", () => {
    const expression = buildModelSelectionExpressionForTest("5.5 Pro");
    expect(expression).toContain("wantsPro && (wantsExtended || desiredVersion === '5-5')");
    expect(() => assertResolvedModelSelectionForTest("Pro Extended", "Extended Pro")).not.toThrow();
    expect(() => assertResolvedModelSelectionForTest("5.6 Pro Extended", "5.6 Pro Extended")).not.toThrow();
  });

  it("detects verification pages and missing model menus before retrying indefinitely", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const detectPageInterruption = () =>");
    expect(expression).toContain("MENU_OPEN_GRACE_MS");
    expect(expression).toContain("model-menu-not-opened");
    expect(expression).toContain("verify you are human");
    expect(expression).toContain("const hasCloudflareChallengeText =");
    expect(expression).not.toContain(
      "if (text.includes('cloudflare')) pushEvidence('Cloudflare');",
    );
  });

  it("recognizes ChatGPT plus the Pro composer pill as the current Pro model", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const hasProComposerPill = () =>");
    expect(expression).toContain("const withProPillSignal = (label) =>");
    expect(expression).toContain("return resolved + ' + Pro'");
    expect(expression).toContain("normalizedLabel === 'chatgpt' && hasProComposerPill()");
    expect(expression).toContain("if (wantsGpt55ExtendedPro) {");
    expect(expression).toContain("return isTargetGpt55VisibleAlias(signal);");
    expect(expression).toContain("node.matches(BUTTON_SELECTOR)");
    expect(expression).toContain("if (normalized !== 'chatgpt') return resolved;");
  });

  it("does not treat every composer pill as a Pro pill", () => {
    const expression = buildModelSelectionExpressionForTest("Pro");
    expect(expression).not.toContain(
      "Boolean(\\n      document.querySelector('button.__composer-pill, button[aria-label=\"Pro, click to remove\"]')",
    );
    expect(expression).toContain("if (!value || hasThinkingText(value)) return false;");
    expect(expression).toContain(
      "if (!hasProText(value) && !hasExtendedText(value)) return false;",
    );
    expect(expression).toContain(
      "if (wantsPro && !hasProText(normalizedLabel) && !hasExtendedText(normalizedLabel)) return false;",
    );
  });

  it("hard-rejects Thinking candidates when targeting Pro", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const candidateHasThinking =");
    expect(expression).toContain("if (wantsPro && candidateHasThinking) return 0;");
    expect(expression).toContain("if (wantsPro && !candidateHasPro) return 0;");
  });

  it("only uses per-row thinking effort controls for Pro Extended setup", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const isThinkingEffortControl = (node) =>");
    expect(expression).toContain("data-model-picker-thinking-effort-action");
    expect(expression).toContain("const isProExtendedEffortOption = (node) =>");
    expect(expression).toContain("const isProEffortContext = (node) =>");
    expect(expression).toContain("if (isThinkingEffortControl(option) && setupScore <= 0)");
    expect(expression).toContain("const selectProExtendedEffortIfAvailable = async () =>");
    expect(expression).toContain("let option = null;");
    expect(expression).toContain("const trailing = findCurrentModelEffortTrailing();");
    expect(expression).not.toContain("let option = findExtendedEffortMenuOption(null);");
    expect(expression).toContain("label: 'Pro Extended'");
    expect(expression).toContain("const hasAnswerNowText = (value) =>");
    expect(expression).toContain("isAnswerNowControl(option)");
  });

  it("can use the Configure or plain Pro row as a setup step for Pro Extended", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const isConfigureControl = (node) =>");
    expect(expression).toContain("PICKER_CONFIGURATION_ROOT_SELECTOR");
    expect(expression).toContain("const optionLooksLikeProSetup =");
    expect(expression).toContain("const scoreProExtendedSetupOption =");
    expect(expression).toContain("if (match.kind === 'setup')");
    expect(expression).toContain("const matchIsConfigure =");
    expect(expression).toContain("if (matchIsConfigure) {");
    expect(expression).toContain("dispatchClickSequence(match.node)");
    expect(expression).toContain("selectProExtendedEffortIfAvailable()");
  });

  it("does not accept a changed but wrong model selection as success", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("resolve('target')");
    expect(expression).toContain("resolve('changed')");
    expect(expression).toContain("if (selectionSettled === 'target')");
    expect(expression).not.toContain(
      "optionIsSelected(match.node) || activeSelectionMatchesTarget()",
    );
  });

  it("accepts the clicked target option when ChatGPT marks it selected", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("optionIsSelected(clickedNode)");
  });

  it("does not reopen an already-open model picker before scanning", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("if (menuIsOpen()) {");
    expect(expression).toContain("unless the picker is already open");
  });

  it("bounds repeated model-option clicks when ChatGPT does not settle selection", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("performance.now() - start > MAX_WAIT_MS");
    expect(expression).toContain("availableOptions: collectAvailableOptions()");
  });

  it("fails loudly if post-selection state resolves to Thinking instead of Pro Extended", () => {
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Thinking 5.5 Heavy")).toThrow(
      /requires Pro Extended/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Instant + Pro")).toThrow(
      /requires Pro Extended/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "GPT-5.5")).toThrow(
      /requires Pro Extended/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Extended")).toThrow(
      /requires Pro Extended/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Pro")).toThrow(
      /requires Pro Extended/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "ChatGPT + Pro")).toThrow(
      /requires Pro Extended/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "ChatGPT")).toThrow(
      /requires Pro Extended/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "GPT-5.5 Pro")).toThrow(
      /requires Pro Extended/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Pro Extended")).not.toThrow();
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "进阶专业")).not.toThrow();
  });

  it("does not validate the active picker label when strategy keeps current selection", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "already-selected", label: "Thinking 5.5 Heavy" } },
      }),
    };
    const logger = vi.fn();

    await expect(
      ensureModelSelection(runtime as never, "gpt-5.5-pro", logger as never, "current"),
    ).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith("Model picker: Thinking 5.5 Heavy");
  });

  it("builds composer footer matchers for generic ChatGPT header states", () => {
    expect(buildComposerSignalMatchersForTest("GPT-5.5 Pro")).toEqual({
      includesAny: ["pro", "专业", "进阶"],
      excludesAny: ["thinking", "思考"],
      allowBlank: false,
    });
    expect(buildComposerSignalMatchersForTest("Thinking 5.5")).toEqual({
      includesAny: ["thinking", "思考"],
      excludesAny: ["pro", "专业"],
      allowBlank: false,
    });
    expect(buildComposerSignalMatchersForTest("GPT-5.2 Instant")).toEqual({
      includesAny: [],
      excludesAny: ["thinking", "思考", "pro", "专业"],
      allowBlank: true,
    });
  });

  it("waits for composer footer state when the header button stays generic", () => {
    const expression = buildModelSelectionExpressionForTest("GPT-5.5 Pro");
    expect(expression).toContain("const readComposerModelSignal = () =>");
    expect(expression).toContain("const activeSelectionMatchesTarget = () =>");
    expect(expression).toContain(
      "const waitForTargetSelection = (clickedNode, previousButtonLabel, previousComposerSignal) =>",
    );
  });

  it("accepts a post-click state change even when the footer text is localized", () => {
    const expression = buildModelSelectionExpressionForTest("Thinking 5.5");
    expect(expression).toContain(
      "const selectionStateChanged = (previousButtonLabel, previousComposerSignal) =>",
    );
    expect(expression).toContain("const previousComposerSignal = readComposerModelSignal();");
    expect(expression).toContain("const previousButtonLabel = normalizeText(getButtonLabel());");
    expect(expression).toContain(".trailing svg");
  });

  it("finds the rewritten ChatGPT composer pill model button", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain('data-testid="model-switcher-dropdown-button"');
    expect(expression).toContain("button.__composer-pill[aria-haspopup=");
    expect(expression).toContain("button.__composer-pill");
  });

  it("waits for the rewritten model picker button before failing", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("async () =>");
    expect(expression).toContain("const BUTTON_WAIT_MS = 20000;");
    expect(expression).toContain("const findModelButton = () =>");
    expect(expression).toContain("const waitForModelButton = () =>");
    expect(expression).toContain("const button = await waitForModelButton();");
  });
});
