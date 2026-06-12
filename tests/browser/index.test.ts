import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  __test__,
  classifyPreservedBrowserErrorForTest,
  formatBrowserTurnTranscript,
  maybeArchiveCompletedConversationForTest,
  redactBrowserConfigForDebugLogForTest,
  resolveRemoteTabLeaseProfileDirForTest,
  runBrowserMode,
  runSubmissionWithRecoveryForTest,
  shouldRequireProExtendedEvidenceForTest,
  shouldSkipThinkingTimeSelectionForTest,
  shouldPreferSystemTmpDirForTest,
  shouldPreserveBrowserOnErrorForTest,
} from "../../src/browser/index.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

describe("shouldPreserveBrowserOnErrorForTest", () => {
  test("preserves the browser for headful cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("does not preserve the browser for headless cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
  });

  test("preserves the browser for headful assistant capture errors", () => {
    const timeout = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });
    const recheck = new BrowserAutomationError("assistant recheck failed", {
      stage: "assistant-recheck",
    });

    expect(shouldPreserveBrowserOnErrorForTest(timeout, false)).toBe(true);
    expect(shouldPreserveBrowserOnErrorForTest(recheck, false)).toBe(true);
    expect(classifyPreservedBrowserErrorForTest(timeout, false)).toBe("reattachable-capture");
    expect(classifyPreservedBrowserErrorForTest(recheck, false)).toBe("reattachable-capture");
  });

  test("does not preserve assistant capture errors in headless mode", () => {
    const error = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });

    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, true)).toBeNull();
  });

  test("preserves incomplete assistant responses for reattach", () => {
    const error = new BrowserAutomationError("assistant incomplete", {
      stage: "assistant-response",
    });

    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
    expect(classifyPreservedBrowserErrorForTest(error, false)).toBe("reattachable-capture");
  });

  test("preserves missing Pro Extended evidence for reattach", () => {
    const error = new BrowserAutomationError("missing Pro Extended evidence", {
      stage: "chatgpt-pro-extended-evidence-missing",
    });

    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
    expect(classifyPreservedBrowserErrorForTest(error, false)).toBe("reattachable-capture");
  });

  test("does not preserve the browser for unrelated browser errors", () => {
    const error = new BrowserAutomationError("other browser error", {
      stage: "execute-browser",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, false)).toBeNull();
  });

  test("classifies Cloudflare preservation separately from assistant capture preservation", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });

    expect(classifyPreservedBrowserErrorForTest(error, false)).toBe("cloudflare-challenge");
  });
});

describe("visible ChatGPT error retry policy", () => {
  test("retries a visible ChatGPT error with a fresh attempt", async () => {
    const logger = vi.fn();
    const result = {
      answerText: "ok",
      answerMarkdown: "ok",
      tookMs: 1,
      answerTokens: 1,
      answerChars: 2,
    };
    let attempts = 0;

    await expect(
      __test__.runBrowserModeWithVisibleErrorRetry({ prompt: "hello", log: logger }, async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new BrowserAutomationError("visible error", {
            stage: "chatgpt-visible-error",
            code: "visible-chatgpt-error",
            message: "Something went wrong.",
          });
        }
        return result;
      }),
    ).resolves.toBe(result);

    expect(attempts).toBe(2);
    expect(logger).toHaveBeenCalledWith(
      "[browser] ChatGPT visible error detected (Something went wrong.); retrying in a fresh tab (attempt 2/2).",
    );
  });

  test("uses one fresh retry by default", () => {
    const previous = process.env.ORACLE_BROWSER_VISIBLE_ERROR_RETRIES;
    delete process.env.ORACLE_BROWSER_VISIBLE_ERROR_RETRIES;
    try {
      expect(__test__.resolveVisibleChatGptErrorMaxAttempts()).toBe(2);
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_BROWSER_VISIBLE_ERROR_RETRIES;
      } else {
        process.env.ORACLE_BROWSER_VISIBLE_ERROR_RETRIES = previous;
      }
    }
  });

  test("does not retry when pinned to an existing browser tab", () => {
    expect(
      __test__.shouldRetryVisibleChatGptError({
        prompt: "hello",
        config: { browserTabRef: "target-1" },
      }),
    ).toBe(false);
    expect(__test__.shouldRetryVisibleChatGptError({ prompt: "hello" })).toBe(true);
  });

  test("retries an unsaved root-tab stall with a fresh attempt", async () => {
    const logger = vi.fn();
    const result = {
      answerText: "ok",
      answerMarkdown: "ok",
      tookMs: 1,
      answerTokens: 1,
      answerChars: 2,
    };
    let attempts = 0;

    await expect(
      __test__.runBrowserModeWithVisibleErrorRetry({ prompt: "hello", log: logger }, async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new BrowserAutomationError("root stall", {
            stage: "chatgpt-root-conversation-stall",
            code: "chatgpt-root-conversation-stall",
            reason: "chatgpt-root-conversation-stall",
            conversationUrl: "https://chatgpt.com/",
          });
        }
        return result;
      }),
    ).resolves.toBe(result);

    expect(attempts).toBe(2);
    expect(logger).toHaveBeenCalledWith(
      "[browser] ChatGPT stayed on an unsaved root tab after submit (https://chatgpt.com/); retrying in a fresh tab (attempt 2/2).",
    );
  });

  test("detects ChatGPT non-conversation URLs without flagging saved conversations", () => {
    expect(__test__.isChatGptNonConversationUrl("https://chatgpt.com/")).toBe(true);
    expect(__test__.isChatGptNonConversationUrl("https://chatgpt.com/g/demo/project")).toBe(true);
    expect(__test__.isChatGptNonConversationUrl("https://chatgpt.com/c/abc-123")).toBe(false);
    expect(__test__.isChatGptNonConversationUrl("https://example.com/")).toBe(false);
  });

  test("uses one root-stall retry by default", () => {
    const previous = process.env.ORACLE_BROWSER_ROOT_STALL_RETRIES;
    delete process.env.ORACLE_BROWSER_ROOT_STALL_RETRIES;
    try {
      expect(__test__.resolveRootConversationStallMaxAttempts()).toBe(2);
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_BROWSER_ROOT_STALL_RETRIES;
      } else {
        process.env.ORACLE_BROWSER_ROOT_STALL_RETRIES = previous;
      }
    }
  });
});

describe("browser answer finalization guard", () => {
  test("rejects stop-visible completion even with answer text", () => {
    const verdict = __test__.validateBrowserAnswerFinalization({
      prompt: "Return sections: Root Cause, Patch Plan, Proposed Code, Tests.",
      answerText: "## Patch Plan\n\nUse a stronger completion gate.",
      answerMarkdown: "## Patch Plan\n\nUse a stronger completion gate.",
      stopVisible: true,
      thinkingActive: false,
      completionUiVisible: true,
      completionUiScopedToMessage: true,
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons).toContain("stop-visible");
  });

  test("rejects large concrete-deliverable prompts with tiny preambles", () => {
    const verdict = __test__.validateBrowserAnswerFinalization({
      prompt:
        "This is an actual complete deliverable request. Return the patch bundle / complete file-level edits and tests now.",
      answerText:
        "I’m focusing on the browser capture/completion path: tiny plan-like assistant turns are being accepted as completed output.",
      answerMarkdown:
        "I’m focusing on the browser capture/completion path: tiny plan-like assistant turns are being accepted as completed output.",
      attachmentCount: 23,
      stopVisible: false,
      thinkingActive: false,
      completionUiVisible: true,
      completionUiScopedToMessage: true,
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons).toContain("promise-or-preamble-only");
    expect(verdict.reasons).toContain("large-input-small-output-ratio");
  });

  test("rejects completion UI that is not scoped to the candidate turn", () => {
    const verdict = __test__.validateBrowserAnswerFinalization({
      prompt: "Provide TypeScript diffs and regression tests.",
      answerText: "## Patch\n\nA short structured patch plan.",
      answerMarkdown: "## Patch\n\nA short structured patch plan.",
      stopVisible: false,
      thinkingActive: false,
      completionUiVisible: true,
      completionUiScopedToMessage: false,
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons).toContain("completion-ui-not-scoped-to-candidate");
  });

  test("accepts short but structured deliverables when browser is idle", () => {
    const verdict = __test__.validateBrowserAnswerFinalization({
      prompt: "Provide TypeScript diffs and regression tests.",
      answerText: "## Patch\n\n```ts\nconst ok = true;\n```\n\n## Tests\n\nRun vitest.",
      answerMarkdown: "## Patch\n\n```ts\nconst ok = true;\n```\n\n## Tests\n\nRun vitest.",
      stopVisible: false,
      thinkingActive: false,
      completionUiVisible: true,
      completionUiScopedToMessage: true,
    });

    expect(verdict.accepted).toBe(true);
  });

  test("rejects Pro Extended runs without completion evidence", () => {
    const verdict = __test__.validateBrowserAnswerFinalization({
      prompt: "Provide TypeScript diffs and regression tests.",
      answerText: "## Patch\n\n```ts\nconst ok = true;\n```\n\n## Tests\n\nRun vitest.",
      answerMarkdown: "## Patch\n\n```ts\nconst ok = true;\n```\n\n## Tests\n\nRun vitest.",
      stopVisible: false,
      thinkingActive: false,
      completionUiVisible: true,
      completionUiScopedToMessage: true,
      requireProExtendedEvidence: true,
      proExtendedEvidence: { state: "missing", text: "", evidence: [] },
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons).toContain("pro-extended-evidence-missing");
  });

  test("accepts Pro Extended runs with completed reasoning evidence", () => {
    const verdict = __test__.validateBrowserAnswerFinalization({
      prompt: "Provide TypeScript diffs and regression tests.",
      answerText: "## Patch\n\n```ts\nconst ok = true;\n```\n\n## Tests\n\nRun vitest.",
      answerMarkdown: "## Patch\n\n```ts\nconst ok = true;\n```\n\n## Tests\n\nRun vitest.",
      stopVisible: false,
      thinkingActive: false,
      completionUiVisible: true,
      completionUiScopedToMessage: true,
      requireProExtendedEvidence: true,
      proExtendedEvidence: {
        state: "complete",
        text: "Thought for 7m 53s",
        evidence: ["reasoning-duration"],
      },
    });

    expect(verdict.accepted).toBe(true);
  });

  test("does not require Pro Extended evidence for ordinary browser runs", () => {
    const verdict = __test__.validateBrowserAnswerFinalization({
      prompt: "Provide TypeScript diffs and regression tests.",
      answerText: "## Patch\n\n```ts\nconst ok = true;\n```\n\n## Tests\n\nRun vitest.",
      answerMarkdown: "## Patch\n\n```ts\nconst ok = true;\n```\n\n## Tests\n\nRun vitest.",
      stopVisible: false,
      thinkingActive: false,
      completionUiVisible: true,
      completionUiScopedToMessage: true,
      requireProExtendedEvidence: false,
      proExtendedEvidence: { state: "missing", text: "", evidence: [] },
    });

    expect(verdict.accepted).toBe(true);
  });
});

describe("browser run target cleanup", () => {
  test("keeps the completed conversation tab when keepBrowser is enabled", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: true,
      }),
    ).toBe(false);
  });

  test("closes owned completed tabs by default", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(true);
  });

  test("does not close attached or incomplete targets", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: false,
        keepBrowser: false,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(false);
  });
});

describe("shouldSkipThinkingTimeSelectionForTest", () => {
  test("treats GPT-5.5 Pro Extended as resolved by model selection", () => {
    expect(shouldSkipThinkingTimeSelectionForTest("GPT-5.5 Pro", "extended")).toBe(true);
    expect(shouldSkipThinkingTimeSelectionForTest("gpt-5.5-pro", "extended")).toBe(true);
    expect(shouldSkipThinkingTimeSelectionForTest("Pro Extended", "extended")).toBe(true);
    expect(shouldSkipThinkingTimeSelectionForTest("Extended Pro", "extended")).toBe(true);
    expect(shouldSkipThinkingTimeSelectionForTest("5.5 Extended Pro", "extended")).toBe(true);
    expect(shouldSkipThinkingTimeSelectionForTest("5.6 Pro Extended", "extended")).toBe(true);
  });

  test("keeps explicit effort selection for non-Pro or non-extended requests", () => {
    expect(shouldSkipThinkingTimeSelectionForTest("gpt-5.5", "heavy")).toBe(false);
    expect(shouldSkipThinkingTimeSelectionForTest("GPT-5.5 Pro", "heavy")).toBe(false);
    expect(shouldSkipThinkingTimeSelectionForTest("GPT-5.2", "extended")).toBe(false);
  });
});

describe("shouldRequireProExtendedEvidenceForTest", () => {
  test("requires final evidence for GPT-5.5 Pro Extended browser runs", () => {
    expect(
      shouldRequireProExtendedEvidenceForTest({
        desiredModel: "gpt-5.5-pro",
        thinkingTime: "extended",
        modelStrategy: "select",
        researchMode: "off",
      }),
    ).toBe(true);
    expect(
      shouldRequireProExtendedEvidenceForTest({
        desiredModel: "5.5 Extended Pro",
        modelStrategy: "select",
        researchMode: "off",
      }),
    ).toBe(true);
  });

  test("does not require final evidence when model selection is ignored or deep research owns flow", () => {
    expect(
      shouldRequireProExtendedEvidenceForTest({
        desiredModel: "gpt-5.5-pro",
        thinkingTime: "extended",
        modelStrategy: "ignore",
        researchMode: "off",
      }),
    ).toBe(false);
    expect(
      shouldRequireProExtendedEvidenceForTest({
        desiredModel: "gpt-5.5-pro",
        thinkingTime: "extended",
        modelStrategy: "select",
        researchMode: "deep",
      }),
    ).toBe(false);
  });
});

describe("formatBrowserTurnTranscript", () => {
  test("keeps single-turn browser output unchanged", () => {
    expect(
      formatBrowserTurnTranscript([
        {
          label: "Initial response",
          answerText: "plain answer",
          answerMarkdown: "**plain answer**",
        },
      ]),
    ).toEqual({
      answerText: "plain answer",
      answerMarkdown: "**plain answer**",
    });
  });

  test("formats multi-turn consult output with follow-up prompts", () => {
    const result = formatBrowserTurnTranscript([
      {
        label: "Initial response",
        answerText: "initial answer",
        answerMarkdown: "initial answer",
      },
      {
        label: "Follow-up 1",
        prompt: "Challenge your previous recommendation.",
        answerText: "revised answer",
        answerMarkdown: "revised answer",
      },
    ]);

    expect(result.answerMarkdown).toContain("## Initial response");
    expect(result.answerMarkdown).toContain("## Follow-up 1");
    expect(result.answerMarkdown).toContain(
      "### Prompt\n\nChallenge your previous recommendation.",
    );
    expect(result.answerMarkdown).toContain("### Answer\n\nrevised answer");
    expect(result.answerText).toBe(result.answerMarkdown);
  });
});

describe("promise-only browser answer guard", () => {
  test("continues when a deliverable prompt only receives a promise preamble", () => {
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "Return JSON only with a Ralph-compatible PRD and referenceImplementation. Do not say what you will do.",
        "I’ll produce an implementable PRD and patch bundle covering metadata schema and tests.",
      ),
    ).toBe(true);
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "Produce a Ralph-compatible PRD plus referenceImplementation for this repo.",
        "I’ll turn the repo snapshot into a concrete PRD plus a patch-ready bundle, keeping metadata additive.",
      ),
    ).toBe(true);
  });

  test("continues when a JSON-only deliverable receives meta commentary", () => {
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        'Return JSON only. The first character of your next message must be "{".',
        "The user wants the deliverable returned now as JSON only, beginning with the character `{`, s",
      ),
    ).toBe(true);
  });

  test("continues when a Ralph bundle response omits the required PRD/code sections", () => {
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "Start with architecture, then provide a Ralph-compatible PRD with referenceImplementation, userStories, acceptanceCriteria, and touchedFiles.",
        "Architecture recommendation: make ownership a derived, persisted browser-session concern.",
      ),
    ).toBe(true);
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "Produce a Ralph-compatible PRD plus referenceImplementation with touchedFiles.",
        "The user demands the actual requested deliverable immediately without any preamble or stat",
      ),
    ).toBe(true);
  });

  test("continues when a patch review receives only a preamble", () => {
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "Provide TypeScript diffs and regression tests. Return sections: Root Cause Hypothesis, Patch Plan, Proposed Code, Tests, Operational Checks, Residual Risk.",
        "I’ll treat this as an Oracle browser-capture failure and trace the TypeScript paths where an early assistant DOM snapshot can be persisted as completed.",
      ),
    ).toBe(true);
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "We need a patch-level diagnosis and repair plan with exact TypeScript patches.",
        "Initial assessment: the browser harvest probably accepted a stable DOM snapshot before the requested patch sections were produced.",
      ),
    ).toBe(true);
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "This is an actual complete deliverable request. Return the patch bundle / complete file-level edits and tests now.",
        "I’m focusing on the browser capture/completion path: tiny plan-like assistant turns are being accepted as completed output.",
      ),
    ).toBe(true);
  });

  test("continuation prompt restates required Ralph bundle sections", () => {
    const continuation = __test__.buildPromiseOnlyContinuationPromptForTest(
      "Produce a Ralph-compatible PRD plus referenceImplementation with userStories, acceptanceCriteria, and touchedFiles.",
    );

    expect(continuation).toContain("Ralph handoff");
    expect(continuation).toContain("Section C: Ralph-compatible PRD");
    expect(continuation).toContain("Section D: referenceImplementation");
    expect(continuation).toContain("Do not answer with a one-sentence gap statement");
  });

  test("does not continue normal short answers or substantive deliverables", () => {
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "Can you handle this later?",
        "I’ll take care of that after the current run finishes.",
      ),
    ).toBe(false);
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "Return JSON only with referenceImplementation.",
        '{"prd":{"id":"x","userStories":[],"referenceImplementation":{"touchedFiles":[]}}}',
      ),
    ).toBe(false);
    expect(
      __test__.shouldAutoContinuePromiseOnlyResponse(
        "Provide TypeScript diffs and regression tests.",
        "## Patch\n\n```ts\nconst ok = true;\n```\n\n## Tests\n\nRun the targeted browser tests.",
      ),
    ).toBe(false);
  });
});

describe("browser completion guard coverage", () => {
  test("keeps stop-button finalization guards on both browser capture paths", () => {
    const source = readFileSync(path.join(process.cwd(), "src/browser/index.ts"), "utf8");

    expect(
      source.match(
        /Assistant response is extremely short; waiting for Stop to disappear before finalizing\./g,
      )?.length,
    ).toBe(2);
    expect(
      source.match(
        /Stop button still visible after assistant capture; waiting for final response\./g,
      )?.length,
    ).toBe(2);
  });
});

describe("browser follow-ups", () => {
  test("rejects Deep Research follow-ups before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "research this",
        followUpPrompts: ["now challenge the report"],
        config: { researchMode: "deep" },
      }),
    ).rejects.toThrow(/follow-ups are not supported with Deep Research/i);
  });
});

describe("browser conversation archiving", () => {
  test("does not attempt archive when required local artifacts were not saved", async () => {
    const runtime = {
      evaluate: vi.fn(),
    };
    const log = vi.fn();

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: log as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 0,
        requiredArtifactsSaved: false,
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: false,
      archived: false,
      reason: "artifact-save-failed",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });
});

describe("remote Chrome option warnings", () => {
  test("does not mark browser-chrome-path as ignored for attach-running", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: true,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).not.toContain("--browser-chrome-path");
  });

  test("marks browser-chrome-path as ignored for classic remote-chrome", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: false,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).toContain("--browser-chrome-path");
  });
});

describe("remote Chrome cleanup", () => {
  test("unrefs a kept browser so the CLI can exit after preserving Chrome", () => {
    const unref = vi.fn();

    __test__.detachKeptChromeProcess({
      process: { unref } as never,
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("closes the dedicated target after a completed run", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "complete",
    });

    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(closeClient).not.toHaveBeenCalled();
  });

  test("only detaches from the target after an incomplete run", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "attempted",
    });

    expect(closeConnection).not.toHaveBeenCalled();
    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  test("detaches raw target clients when a run attaches to an existing remote tab", async () => {
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: null,
      client: { close: closeClient },
      runStatus: "complete",
    });

    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  test("does not close an already-lost connection", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: true,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "attempted",
    });

    expect(closeConnection).not.toHaveBeenCalled();
    expect(closeClient).not.toHaveBeenCalled();
  });
});

describe("image-only assistant turn detection", () => {
  test("treats ChatGPT image-only chrome text as non-answer UI", () => {
    expect(__test__.isImageOnlyUiChromeText("Stopped thinking\nEdit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("PR169_IMAGE_OK")).toBe(false);
  });
});

describe("redactBrowserConfigForDebugLogForTest", () => {
  test("redacts inline cookie values while preserving count context", () => {
    const redacted = redactBrowserConfigForDebugLogForTest({
      inlineCookies: [
        { name: "__Secure-next-auth.session-token", value: "secret-token" },
        { name: "_account", value: "secret-account" },
      ],
      inlineCookiesSource: "inline-file",
      debug: true,
    });

    expect(redacted).toMatchObject({
      inlineCookies: "[redacted:2 cookies]",
      inlineCookieCount: 2,
      inlineCookiesSource: "inline-file",
      debug: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("secret-account");
  });

  test("leaves missing inline cookies unchanged", () => {
    expect(redactBrowserConfigForDebugLogForTest({ debug: true })).toEqual({ debug: true });
  });
});

describe("shouldPreferSystemTmpDirForTest", () => {
  test("prefers /tmp for Linux tmpdirs under a hidden home segment", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.tmp", "/home/openclaw")).toBe(
      true,
    );
    expect(
      shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.cache/tmp", "/home/openclaw"),
    ).toBe(true);
  });

  test("keeps normal Linux tmpdirs and non-Linux platforms unchanged", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/tmp", "/home/openclaw")).toBe(false);
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/tmp", "/home/openclaw")).toBe(
      false,
    );
    expect(shouldPreferSystemTmpDirForTest("darwin", "/Users/me/.tmp", "/Users/me")).toBe(false);
  });

  test("does not treat sibling home paths as inside the home directory", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw2/.tmp", "/home/openclaw")).toBe(
      false,
    );
  });
});

describe("runSubmissionWithRecoveryForTest", () => {
  test("preserves prompt-too-large fallback after a dead-composer retry", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new BrowserAutomationError("dead composer", { code: "dead-composer" }))
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockResolvedValueOnce({
        baselineTurns: 7,
        baselineAssistantText: "done",
      });
    const reloadPromptComposer = vi.fn().mockResolvedValue(undefined);
    const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
    const logger = vi.fn<(message: string) => void>();

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [{ path: "/tmp/fallback.txt", displayPath: "fallback.txt", sizeBytes: 12 }],
        },
        submit,
        reloadPromptComposer,
        prepareFallbackSubmission,
        logger,
      }),
    ).resolves.toEqual({
      baselineTurns: 7,
      baselineAssistantText: "done",
    });

    expect(reloadPromptComposer).toHaveBeenCalledTimes(1);
    expect(prepareFallbackSubmission).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "[browser] Inline prompt too large; retrying with file uploads.",
    );
    expect(submit).toHaveBeenNthCalledWith(1, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(2, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(3, "fallback prompt", [
      expect.objectContaining({ displayPath: "fallback.txt" }),
    ]);
  });

  test("throws when prompt-too-large happens again after fallback", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large again", { code: "prompt-too-large" }),
      );

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [],
        },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission: vi.fn().mockResolvedValue(undefined),
        logger: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toThrow(/prompt too large again/i);
  });

  test("uses bundled fallback after attachment upload verification failure", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Attachment did not appear in ChatGPT composer."))
      .mockResolvedValueOnce({
        baselineTurns: 3,
        baselineAssistantText: "done",
      });
    const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
    const logger = vi.fn<(message: string) => void>();

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "full prompt",
        attachments: [
          { path: "/repo/a.txt", displayPath: "a.txt", sizeBytes: 12 },
          { path: "/repo/b.txt", displayPath: "b.txt", sizeBytes: 12 },
        ],
        fallbackSubmission: {
          prompt: "full prompt",
          attachments: [
            {
              path: "/tmp/oracle-browser-bundle/attachments-bundle.txt",
              displayPath: "attachments-bundle.txt",
              sizeBytes: 24,
            },
          ],
        },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission,
        logger,
      }),
    ).resolves.toEqual({
      baselineTurns: 3,
      baselineAssistantText: "done",
    });

    expect(prepareFallbackSubmission).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "[browser] Attachment upload verification failed; retrying with bundled file upload.",
    );
    expect(submit).toHaveBeenNthCalledWith(1, "full prompt", [
      expect.objectContaining({ displayPath: "a.txt" }),
      expect.objectContaining({ displayPath: "b.txt" }),
    ]);
    expect(submit).toHaveBeenNthCalledWith(2, "full prompt", [
      expect.objectContaining({ displayPath: "attachments-bundle.txt" }),
    ]);
  });
});

describe("resolveRemoteTabLeaseProfileDirForTest", () => {
  test("coordinates remote Chrome only when a manual-login profile is configured", () => {
    const coordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(coordinated)).toBe(
      path.resolve("/tmp/oracle-profile"),
    );

    const uncoordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: false,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(uncoordinated)).toBeNull();
  });
});
