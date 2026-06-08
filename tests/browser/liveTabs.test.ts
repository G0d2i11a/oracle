import { beforeEach, describe, expect, test, vi } from "vitest";

const cdpMocks = vi.hoisted(() => {
  const runtime = {
    enable: vi.fn(async () => undefined),
    evaluate: vi.fn(),
  };
  const dom = {
    enable: vi.fn(async () => undefined),
  };
  const client = {
    Runtime: runtime,
    DOM: dom,
    close: vi.fn(async () => undefined),
  };
  const connect = vi.fn(async () => client);
  return {
    runtime,
    dom,
    client,
    connect,
    list: vi.fn(),
    newTarget: vi.fn(),
  };
});

vi.mock("chrome-remote-interface", () => {
  const connect = cdpMocks.connect;
  return {
    default: Object.assign(connect, {
      List: cdpMocks.list,
      New: cdpMocks.newTarget,
    }),
  };
});

import {
  buildTabInspectionExpressionForTest,
  classifyTabState,
  formatBrowserTabState,
  inspectChatGptTab,
  isReasoningBrowserModelLabelForTest,
  resolveChatGptTabFromSummariesForTest,
  resolveAssistantSnippetTextForTest,
  sessionMatchesTab,
  shouldSuspectReasoningDowngradeForTest,
  shouldPreferDeepResearchResultForTest,
  type ChatGptTabSummary,
} from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

function makeTab(overrides: Partial<ChatGptTabSummary> = {}): ChatGptTabSummary {
  return {
    targetId: "target-1",
    title: "ChatGPT",
    url: "https://chatgpt.com/c/abc",
    currentModelLabel: "ChatGPT + Pro",
    stopExists: false,
    thinkingActive: false,
    completionVisible: true,
    sendExists: true,
    promptReady: true,
    loginButtonExists: false,
    authenticated: true,
    assistantCount: 1,
    firstAssistantText: "Answer",
    firstAssistantSnippet: "Answer",
    openingLine: "Answer",
    lastAssistantText: "Answer",
    lastAssistantSnippet: "Answer",
    lastUserText: "Question",
    lastUserSnippet: "Question",
    focused: true,
    visibilityState: "visible",
    conversationId: "abc",
    fingerprint: "fp",
    state: "completed",
    lastAssistantMarkdown: "Answer",
    ...overrides,
  };
}

describe("liveTabs helpers", () => {
  beforeEach(() => {
    cdpMocks.runtime.enable.mockClear();
    cdpMocks.runtime.evaluate.mockReset();
    cdpMocks.dom.enable.mockClear();
    cdpMocks.client.close.mockClear();
    cdpMocks.connect.mockClear();
    cdpMocks.connect.mockResolvedValue(cdpMocks.client);
    cdpMocks.list.mockReset();
    cdpMocks.newTarget.mockReset();
  });

  test("classifies running/completed/detached states", () => {
    expect(
      classifyTabState({
        blocker: undefined,
        authenticated: true,
        stopExists: true,
        thinkingActive: true,
        completionVisible: false,
        sendExists: false,
        promptReady: false,
        assistantCount: 0,
      }),
    ).toBe("running");
    expect(
      classifyTabState({
        blocker: undefined,
        authenticated: true,
        stopExists: false,
        thinkingActive: true,
        completionVisible: true,
        sendExists: true,
        promptReady: true,
        assistantCount: 2,
      }),
    ).toBe("completed");
    expect(
      classifyTabState({
        blocker: undefined,
        authenticated: true,
        stopExists: false,
        thinkingActive: true,
        completionVisible: false,
        sendExists: false,
        promptReady: true,
        assistantCount: 0,
      }),
    ).toBe("completed");
    expect(
      classifyTabState({
        blocker: undefined,
        authenticated: true,
        stopExists: false,
        thinkingActive: false,
        completionVisible: true,
        sendExists: true,
        promptReady: true,
        assistantCount: 1,
      }),
    ).toBe("completed");
    expect(
      classifyTabState({
        blocker: undefined,
        authenticated: false,
        stopExists: false,
        thinkingActive: false,
        completionVisible: false,
        sendExists: false,
        promptReady: false,
        assistantCount: 0,
      }),
    ).toBe("detached");
    expect(
      classifyTabState({
        blocker: "login-expired",
        authenticated: false,
        stopExists: true,
        thinkingActive: true,
        completionVisible: false,
        sendExists: false,
        promptReady: false,
        assistantCount: 1,
      }),
    ).toBe("blocked");
  });

  test("status completion UI accepts finished actions near the latest assistant turn", () => {
    const expression = buildTabInspectionExpressionForTest();
    expect(expression).toContain("isCompletionActionNearAssistantTurn");
    expect(expression).toContain("document.querySelectorAll(FINISHED_SELECTOR)");
    expect(expression).toContain("turnRoot?.contains(button)");
    expect(expression).toContain("Node.DOCUMENT_POSITION_FOLLOWING");
    expect(expression).toContain("completionVisible");
  });

  test("status inspection captures completed ChatGPT reasoning UI markers", () => {
    const expression = buildTabInspectionExpressionForTest();
    expect(expression).toContain("readReasoningUi");
    expect(expression).toContain("reasoning-duration");
    expect(expression).toContain("Thought");
    expect(expression).toContain("reasoningUiState");
    expect(expression).toContain("reasoningUiEvidence");
  });

  test("treats an active Deep Research iframe as running even after a preamble", () => {
    const expression = buildTabInspectionExpressionForTest();
    expect(expression).toContain("hasLargeDeepResearchFrame");
    expect(expression).toContain("internal://deep-research");
    expect(expression).toContain("deepResearchFrameActive");
    expect(expression).toContain("hasLargeDeepResearchFrame() && !completionVisible");
    expect(expression).toContain("const stopExists = mainStopExists");
    expect(expression).toContain("deepResearchActive: deepResearchFrameActive");
  });

  test("surfaces expired ChatGPT sessions as blockers", () => {
    const expression = buildTabInspectionExpressionForTest();
    expect(expression).toContain("expired-session");
    expect(expression).toContain("your session has expired");
    expect(expression).toContain("const blocker = loginExpired ? 'login-expired'");
    expect(expression).toContain("authenticated = !blocker");
  });

  test("prefers completed Deep Research card text over placeholder assistant text", () => {
    expect(
      shouldPreferDeepResearchResultForTest(
        "ChatGPT said:",
        "trq212 Live Social Reference Update Bundle\n\nCrawl result summary with enough detail.",
      ),
    ).toBe(true);
    expect(shouldPreferDeepResearchResultForTest("Complete assistant answer", "")).toBe(false);
  });

  test("inspects first/opening and last assistant snippets", async () => {
    cdpMocks.runtime.evaluate
      .mockResolvedValueOnce({
        result: {
          value: {
            title: "ChatGPT",
            url: "https://chatgpt.com/c/abc",
            currentModelLabel: "ChatGPT",
            stopExists: false,
            thinkingActive: false,
            completionVisible: true,
            sendExists: true,
            promptReady: true,
            loginButtonExists: false,
            authenticated: true,
            assistantCount: 2,
            firstAssistantText: "Opening assistant line.\nMore detail follows.",
            openingLine: "Opening assistant line.",
            lastAssistantText: "Latest assistant text.",
            lastUserText: "Latest user prompt.",
            visibilityState: "visible",
            focused: true,
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          value: {
            text: "Latest assistant text.\nSecond line.",
            messageId: "message-2",
            turnId: "turn-2",
          },
        },
      });

    const summary = await inspectChatGptTab({
      target: {
        targetId: "target-1",
        type: "page",
        title: "ChatGPT",
        url: "https://chatgpt.com/c/abc",
      },
    });

    expect(summary.firstAssistantText).toBe("Opening assistant line.\nMore detail follows.");
    expect(summary.firstAssistantSnippet).toBe("Opening assistant line. More detail follows.");
    expect(summary.openingLine).toBe("Opening assistant line.");
    expect(summary.lastAssistantText).toBe("Latest assistant text.\nSecond line.");
    expect(summary.lastAssistantSnippet).toBe("Latest assistant text. Second line.");
    expect(summary.lastAssistantMessageId).toBe("message-2");
    expect(summary.lastAssistantTurnId).toBe("turn-2");
    expect(summary.state).toBe("completed");
  });

  test("falls back to DOM text when assistant snapshot is only a tiny partial", async () => {
    cdpMocks.runtime.evaluate
      .mockResolvedValueOnce({
        result: {
          value: {
            title: "ChatGPT",
            url: "https://chatgpt.com/c/abc",
            currentModelLabel: "ChatGPT",
            stopExists: false,
            thinkingActive: false,
            completionVisible: true,
            sendExists: true,
            promptReady: true,
            loginButtonExists: false,
            authenticated: true,
            assistantCount: 2,
            firstAssistantText: "Opening assistant line.",
            openingLine: "Opening assistant line.",
            lastAssistantText:
              "According to the uploaded context, this is the complete assistant answer.",
            lastUserText: "Latest user prompt.",
            visibilityState: "visible",
            focused: true,
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          value: {
            text: "I",
            messageId: "message-2",
            turnId: "turn-2",
          },
        },
      });

    const summary = await inspectChatGptTab({
      target: {
        targetId: "target-1",
        type: "page",
        title: "ChatGPT",
        url: "https://chatgpt.com/c/abc",
      },
    });

    expect(summary.lastAssistantText).toBe(
      "According to the uploaded context, this is the complete assistant answer.",
    );
    expect(summary.lastAssistantSnippet).toBe(
      "According to the uploaded context, this is the complete assistant answer.",
    );
    expect(summary.lastAssistantMessageId).toBe("message-2");
  });

  test("inspects zero assistant turns with empty assistant fields", async () => {
    cdpMocks.runtime.evaluate
      .mockResolvedValueOnce({
        result: {
          value: {
            title: "ChatGPT",
            url: "https://chatgpt.com/",
            currentModelLabel: "",
            stopExists: false,
            thinkingActive: false,
            completionVisible: false,
            sendExists: false,
            promptReady: false,
            loginButtonExists: true,
            authenticated: false,
            assistantCount: 0,
            visibilityState: "visible",
            focused: false,
          },
        },
      })
      .mockResolvedValueOnce({ result: { value: null } });

    const summary = await inspectChatGptTab({
      target: {
        targetId: "target-empty",
        type: "page",
        title: "ChatGPT",
        url: "https://chatgpt.com/",
      },
    });

    expect(summary.assistantCount).toBe(0);
    expect(summary.firstAssistantText).toBe("");
    expect(summary.firstAssistantSnippet).toBe("");
    expect(summary.openingLine).toBe("");
    expect(summary.lastAssistantText).toBe("");
    expect(summary.lastAssistantSnippet).toBe("");
    expect(summary.state).toBe("detached");
  });

  test("does not treat thinking-only empty ChatGPT home as a running conversation", async () => {
    cdpMocks.runtime.evaluate
      .mockResolvedValueOnce({
        result: {
          value: {
            title: "ChatGPT",
            url: "https://chatgpt.com/",
            currentModelLabel: "Instant",
            stopExists: false,
            thinkingActive: true,
            completionVisible: false,
            sendExists: false,
            promptReady: true,
            loginButtonExists: false,
            authenticated: true,
            assistantCount: 0,
            firstAssistantText: "",
            openingLine: "",
            lastAssistantText: "",
            lastUserText: "",
            visibilityState: "visible",
            focused: false,
          },
        },
      })
      .mockResolvedValueOnce({ result: { value: null } });

    const summary = await inspectChatGptTab({
      target: {
        targetId: "target-home",
        type: "page",
        title: "ChatGPT",
        url: "https://chatgpt.com/",
      },
    });

    expect(summary.thinkingActive).toBe(false);
    expect(summary.assistantCount).toBe(0);
    expect(summary.state).toBe("completed");
  });

  test("does not treat completed UI plus stale thinking as a running conversation", async () => {
    cdpMocks.runtime.evaluate
      .mockResolvedValueOnce({
        result: {
          value: {
            title: "ChatGPT",
            url: "https://chatgpt.com/c/completed",
            currentModelLabel: "Pro",
            stopExists: false,
            thinkingActive: true,
            completionVisible: true,
            sendExists: true,
            promptReady: true,
            loginButtonExists: false,
            authenticated: true,
            assistantCount: 2,
            firstAssistantText: "Opening assistant line.",
            openingLine: "Opening assistant line.",
            lastAssistantText: "Final answer body.",
            lastUserText: "Question",
            visibilityState: "visible",
            focused: false,
          },
        },
      })
      .mockResolvedValueOnce({ result: { value: null } });

    const summary = await inspectChatGptTab({
      target: {
        targetId: "target-completed",
        type: "page",
        title: "ChatGPT",
        url: "https://chatgpt.com/c/completed",
      },
    });

    expect(summary.stopExists).toBe(false);
    expect(summary.thinkingActive).toBe(false);
    expect(summary.completionVisible).toBe(true);
    expect(summary.state).toBe("completed");
  });

  test("marks completed Pro runs without reasoning UI as downgrade suspects", async () => {
    cdpMocks.runtime.evaluate
      .mockResolvedValueOnce({
        result: {
          value: {
            title: "ChatGPT",
            url: "https://chatgpt.com/c/pro-missing-reasoning",
            currentModelLabel: "Pro",
            stopExists: false,
            thinkingActive: false,
            reasoningUiState: "unknown",
            reasoningUiText: "",
            reasoningUiEvidence: [],
            completionVisible: true,
            sendExists: true,
            promptReady: true,
            loginButtonExists: false,
            authenticated: true,
            assistantCount: 1,
            firstAssistantText: "Answer body.",
            openingLine: "Answer body.",
            lastAssistantText: "Answer body.",
            lastUserText: "Question",
            visibilityState: "visible",
            focused: false,
          },
        },
      })
      .mockResolvedValueOnce({ result: { value: null } });

    const summary = await inspectChatGptTab({
      target: {
        targetId: "target-pro-missing",
        type: "page",
        title: "ChatGPT",
        url: "https://chatgpt.com/c/pro-missing-reasoning",
      },
    });

    expect(summary.reasoningUiState).toBe("missing");
    expect(summary.reasoningDowngradeSuspected).toBe(true);
    expect(summary.state).toBe("completed");
  });

  test("does not flag completed Pro runs with Thought duration UI", async () => {
    cdpMocks.runtime.evaluate
      .mockResolvedValueOnce({
        result: {
          value: {
            title: "ChatGPT",
            url: "https://chatgpt.com/c/pro-reasoned",
            currentModelLabel: "Pro",
            stopExists: false,
            thinkingActive: false,
            reasoningUiState: "complete",
            reasoningUiText: "Thought for 8s",
            reasoningUiEvidence: ["reasoning-duration"],
            completionVisible: true,
            sendExists: true,
            promptReady: true,
            loginButtonExists: false,
            authenticated: true,
            assistantCount: 1,
            firstAssistantText: "Answer body.",
            openingLine: "Answer body.",
            lastAssistantText: "Answer body.",
            lastUserText: "Question",
            visibilityState: "visible",
            focused: false,
          },
        },
      })
      .mockResolvedValueOnce({ result: { value: null } });

    const summary = await inspectChatGptTab({
      target: {
        targetId: "target-pro-reasoned",
        type: "page",
        title: "ChatGPT",
        url: "https://chatgpt.com/c/pro-reasoned",
      },
    });

    expect(summary.reasoningUiState).toBe("complete");
    expect(summary.reasoningUiText).toBe("Thought for 8s");
    expect(summary.reasoningUiEvidence).toEqual(["reasoning-duration"]);
    expect(summary.reasoningDowngradeSuspected).toBe(false);
  });

  test("does not expose Deep Research iframe activity as a Stop button", async () => {
    cdpMocks.runtime.evaluate
      .mockResolvedValueOnce({
        result: {
          value: {
            title: "ChatGPT",
            url: "https://chatgpt.com/c/deep",
            currentModelLabel: "Pro",
            stopExists: false,
            thinkingActive: true,
            deepResearchActive: true,
            completionVisible: false,
            sendExists: false,
            promptReady: true,
            loginButtonExists: false,
            authenticated: true,
            assistantCount: 1,
            firstAssistantText: "Reading documents",
            openingLine: "Reading documents",
            lastAssistantText: "Reading documents",
            lastUserText: "Investigate the attached files.",
            visibilityState: "visible",
            focused: false,
          },
        },
      })
      .mockResolvedValueOnce({ result: { value: null } });

    const summary = await inspectChatGptTab({
      target: {
        targetId: "target-deep",
        type: "page",
        title: "ChatGPT",
        url: "https://chatgpt.com/c/deep",
      },
    });

    expect(summary.stopExists).toBe(false);
    expect(summary.thinkingActive).toBe(true);
    expect(summary.deepResearchActive).toBe(true);
    expect(summary.state).toBe("running");
  });

  test("formats the stored state when present", () => {
    expect(formatBrowserTabState(makeTab({ state: "stalled" }))).toBe("stalled");
  });

  test("recognizes Pro and Thinking labels as reasoning browser models", () => {
    expect(isReasoningBrowserModelLabelForTest("Pro")).toBe(true);
    expect(isReasoningBrowserModelLabelForTest("ChatGPT + Pro")).toBe(true);
    expect(isReasoningBrowserModelLabelForTest("GPT-5.2 Thinking")).toBe(true);
    expect(isReasoningBrowserModelLabelForTest("Instant")).toBe(false);
  });

  test("suspects downgrade only after a completed reasoning-model answer without reasoning UI", () => {
    expect(
      shouldSuspectReasoningDowngradeForTest({
        modelLabel: "Pro",
        stopExists: false,
        thinkingActive: false,
        completionVisible: true,
        assistantCount: 1,
        reasoningUiState: "unknown",
      }),
    ).toBe(true);
    expect(
      shouldSuspectReasoningDowngradeForTest({
        modelLabel: "Pro",
        stopExists: true,
        thinkingActive: true,
        completionVisible: false,
        assistantCount: 1,
        reasoningUiState: "active",
      }),
    ).toBe(false);
    expect(
      shouldSuspectReasoningDowngradeForTest({
        modelLabel: "Pro",
        stopExists: false,
        thinkingActive: false,
        completionVisible: true,
        assistantCount: 1,
        reasoningUiState: "complete",
      }),
    ).toBe(false);
  });

  test("prefers complete markdown over tiny snapshot snippets", () => {
    expect(
      resolveAssistantSnippetTextForTest(
        "I",
        "I will give the complete implementation notes here with enough detail to be useful.",
      ),
    ).toBe("I will give the complete implementation notes here with enough detail to be useful.");
    expect(resolveAssistantSnippetTextForTest("Complete answer", "Complete answer")).toBe(
      "Complete answer",
    );
  });

  test("resolves current/id/url/title refs against live tabs", () => {
    const tabs = [
      makeTab({ targetId: "target-1", title: "Review A", url: "https://chatgpt.com/c/a" }),
      makeTab({ targetId: "target-2", title: "Review B", url: "https://chatgpt.com/c/b" }),
    ];
    expect(resolveChatGptTabFromSummariesForTest(tabs, "current").targetId).toBe("target-1");
    expect(resolveChatGptTabFromSummariesForTest(tabs, "target-2").url).toBe(
      "https://chatgpt.com/c/b",
    );
    expect(resolveChatGptTabFromSummariesForTest(tabs, "https://chatgpt.com/c/a").targetId).toBe(
      "target-1",
    );
    expect(resolveChatGptTabFromSummariesForTest(tabs, "Review B").targetId).toBe("target-2");
  });

  test("throws on ambiguous title matches", () => {
    const tabs = [
      makeTab({ targetId: "target-1", title: "Routing Review", url: "https://chatgpt.com/c/a" }),
      makeTab({
        targetId: "target-2",
        title: "Routing Review Followup",
        url: "https://chatgpt.com/c/b",
      }),
    ];
    expect(() => resolveChatGptTabFromSummariesForTest(tabs, "Routing Review")).toThrow(
      /Multiple ChatGPT tabs match/i,
    );
  });

  test("matches sessions by target id, url, and conversation id", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        ownerLabel: "agent-a",
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "target-1",
          tabUrl: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        },
      },
    } as SessionMetadata;
    expect(
      sessionMatchesTab(meta, {
        host: "127.0.0.1",
        port: 9222,
        targetId: "target-1",
        url: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      }),
    ).toBe(true);
    expect(
      sessionMatchesTab(
        {
          ...meta,
          browser: {
            ...meta.browser,
            ownerLabel: "different-agent",
          },
        },
        {
          host: "127.0.0.1",
          port: 9222,
          targetId: "target-1",
          url: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        },
      ),
    ).toBe(true);
    expect(
      sessionMatchesTab(meta, {
        host: "127.0.0.1",
        port: 9222,
        targetId: "target-2",
        url: "https://chatgpt.com/c/def",
        conversationId: "def",
      }),
    ).toBe(false);
    expect(
      sessionMatchesTab(
        {
          ...meta,
          status: "completed",
          browser: {
            ...meta.browser,
            runtime: {
              ...meta.browser?.runtime,
              tabUrl: "https://chatgpt.com/",
              conversationId: undefined,
            },
          },
        },
        {
          host: "127.0.0.1",
          port: 9222,
          targetId: "target-1",
          url: "https://chatgpt.com/c/new-owner",
          conversationId: "new-owner",
        },
      ),
    ).toBe(false);
    expect(
      sessionMatchesTab(
        {
          ...meta,
          status: "running",
        },
        {
          host: "127.0.0.1",
          port: 9222,
          targetId: "target-1",
          url: "https://chatgpt.com/",
          conversationId: undefined,
        },
      ),
    ).toBe(false);
    expect(
      sessionMatchesTab(
        {
          ...meta,
          status: "completed",
          browser: {
            ...meta.browser,
            harvest: {
              targetId: "target-1",
              url: "https://chatgpt.com/",
            },
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              chromeTargetId: "target-1",
              tabUrl: "https://chatgpt.com/",
              conversationId: undefined,
            },
          },
        },
        {
          host: "127.0.0.1",
          port: 9222,
          targetId: "target-1",
          url: "https://chatgpt.com/",
          conversationId: undefined,
        },
      ),
    ).toBe(false);
    expect(
      sessionMatchesTab(
        {
          ...meta,
          status: "completed",
          browser: {
            ...meta.browser,
            harvest: {
              targetId: "target-1",
              url: "https://chatgpt.com/",
              state: "running",
              stopExists: true,
              thinkingActive: true,
            },
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              chromeTargetId: "target-1",
              tabUrl: "https://chatgpt.com/",
              conversationId: undefined,
            },
          },
        },
        {
          host: "127.0.0.1",
          port: 9222,
          targetId: "target-1",
          url: "https://chatgpt.com/",
          conversationId: undefined,
        },
      ),
    ).toBe(true);
    expect(
      sessionMatchesTab(
        {
          ...meta,
          status: "running",
          browser: {
            runtime: {
              chromeHost: "127.0.0.1",
              chromePort: 9222,
              chromeTargetId: "target-1",
              tabUrl: "https://chatgpt.com/",
              conversationId: undefined,
            },
          },
        } as SessionMetadata,
        {
          host: "127.0.0.1",
          port: 9222,
          targetId: "target-1",
          url: "https://chatgpt.com/",
          conversationId: undefined,
        },
      ),
    ).toBe(true);
    expect(
      sessionMatchesTab(
        {
          ...meta,
          status: "error",
          browser: {
            ...meta.browser,
            runtime: {
              ...meta.browser?.runtime,
              chromeTargetId: "target-1",
              tabUrl: "https://chatgpt.com/",
              conversationId: undefined,
            },
          },
        },
        {
          host: "127.0.0.1",
          port: 9222,
          targetId: "target-2",
          url: "https://chatgpt.com/",
          conversationId: undefined,
        },
      ),
    ).toBe(false);
  });
});
