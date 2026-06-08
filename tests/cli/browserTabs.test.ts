import { describe, expect, test } from "vitest";
import {
  buildHarvestBrowserMetadataForTest,
  deriveLiveTailStateForTest,
  formatBrowserTabStatusLinesForTest,
  formatHarvestSummaryLinesForTest,
  formatBrowserSignalsForTest,
  formatLiveTailStatusLineForTest,
  isBrowserTabActiveForTest,
  resolveBrowserOwnerLabelForTest,
  resolveBrowserProfileLabelForTest,
  resolveBrowserRuntimeLabelForTest,
  resolveSessionTabRefForTest,
} from "../../src/cli/browserTabs.js";
import type { ChatGptTabSummary } from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

describe("browser tab CLI helpers", () => {
  test("prefers stable conversation URLs over stale Chrome target ids", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeTargetId: "stale-target",
          tabUrl: "https://chatgpt.com/c/runtime-conversation",
          conversationId: "runtime-conversation",
        },
      },
    } as SessionMetadata;

    expect(resolveSessionTabRefForTest(meta)).toBe("https://chatgpt.com/c/runtime-conversation");
  });

  test("prefers runtime target over conflicting harvested root tab for running browser sessions", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "running",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeTargetId: "runtime-target",
          tabUrl: "https://chatgpt.com/",
        },
        harvest: {
          targetId: "wrong-target",
          url: "https://chatgpt.com/",
        },
      },
    } as SessionMetadata;

    expect(resolveSessionTabRefForTest(meta)).toBe("runtime-target");
  });

  test("keeps live tail running while Stop remains visible", () => {
    const unchangedSince = Date.now() - 120_000;
    expect(
      deriveLiveTailStateForTest(
        {
          stopExists: true,
          thinkingActive: false,
          completionVisible: false,
          authenticated: true,
        },
        unchangedSince,
        60_000,
      ),
    ).toBe("running");
  });

  test("does not keep live tail running forever when ChatGPT login has expired", () => {
    const unchangedSince = Date.now() - 120_000;
    expect(
      deriveLiveTailStateForTest(
        {
          blocker: "login-expired",
          stopExists: true,
          thinkingActive: false,
          completionVisible: false,
          authenticated: false,
        },
        unchangedSince,
        60_000,
      ),
    ).toBe("blocked");
  });

  test("keeps live tail running while Pro Extended progress continues after first text", () => {
    const unchangedSince = Date.now() - 120_000;
    expect(
      deriveLiveTailStateForTest(
        {
          stopExists: false,
          thinkingActive: true,
          completionVisible: false,
          authenticated: true,
        },
        unchangedSince,
        60_000,
        "Partial answer already visible.",
      ),
    ).toBe("running");
  });

  test("keeps live tail running when completion UI appears before text is stable", () => {
    const unchangedSince = Date.now() - 1_000;
    expect(
      deriveLiveTailStateForTest(
        {
          stopExists: false,
          thinkingActive: false,
          completionVisible: true,
          authenticated: true,
        },
        unchangedSince,
        60_000,
        "Final answer body",
        8_000,
      ),
    ).toBe("running");
  });

  test("does not keep live tail running from stale thinking once completion UI is stable", () => {
    const unchangedSince = Date.now() - 10_000;
    const activeClearedSince = Date.now() - 10_000;
    expect(
      deriveLiveTailStateForTest(
        {
          stopExists: false,
          thinkingActive: true,
          completionVisible: true,
          authenticated: true,
        },
        unchangedSince,
        60_000,
        "Final answer body",
        8_000,
        activeClearedSince,
      ),
    ).toBe("completed");
  });

  test("does not treat a one-character harvest as completed output", () => {
    const unchangedSince = Date.now() - 1_000;
    expect(
      deriveLiveTailStateForTest(
        {
          stopExists: false,
          thinkingActive: false,
          completionVisible: true,
          authenticated: true,
        },
        unchangedSince,
        60_000,
        "I",
        8_000,
      ),
    ).toBe("running");
  });

  test("keeps live tail running until Stop has been absent long enough", () => {
    const unchangedSince = Date.now() - 20_000;
    const activeClearedSince = Date.now() - 1_000;
    expect(
      deriveLiveTailStateForTest(
        {
          stopExists: false,
          thinkingActive: false,
          completionVisible: true,
          authenticated: true,
        },
        unchangedSince,
        60_000,
        "Final answer body",
        8_000,
        activeClearedSince,
      ),
    ).toBe("running");
  });

  test("marks stable non-trivial completed text as completed", () => {
    const unchangedSince = Date.now() - 10_000;
    const activeClearedSince = Date.now() - 10_000;
    expect(
      deriveLiveTailStateForTest(
        {
          stopExists: false,
          thinkingActive: false,
          completionVisible: true,
          authenticated: true,
        },
        unchangedSince,
        60_000,
        "Final answer body",
        8_000,
        activeClearedSince,
      ),
    ).toBe("completed");
  });

  test("prints an explicit active signal while Stop remains visible", () => {
    const tab = {
      stopExists: true,
      thinkingActive: false,
      completionVisible: false,
      state: "completed",
      authenticated: true,
      sendExists: false,
      promptReady: false,
      assistantCount: 1,
    } as Pick<
      ChatGptTabSummary,
      | "stopExists"
      | "thinkingActive"
      | "completionVisible"
      | "state"
      | "authenticated"
      | "sendExists"
      | "promptReady"
      | "assistantCount"
    >;
    expect(isBrowserTabActiveForTest(tab)).toBe(true);
    expect(formatBrowserSignalsForTest(tab)).toBe(
      "active=yes stop=yes progress=yes completeUi=no send=no",
    );
  });

  test("prints reasoning UI downgrade suspicion in browser signals", () => {
    const tab = {
      stopExists: false,
      thinkingActive: false,
      reasoningUiState: "missing",
      reasoningDowngradeSuspected: true,
      completionVisible: true,
      state: "completed",
      authenticated: true,
      sendExists: true,
      promptReady: true,
      assistantCount: 1,
    } as Pick<
      ChatGptTabSummary,
      | "stopExists"
      | "thinkingActive"
      | "reasoningUiState"
      | "reasoningDowngradeSuspected"
      | "completionVisible"
      | "state"
      | "authenticated"
      | "sendExists"
      | "promptReady"
      | "assistantCount"
    >;
    expect(formatBrowserSignalsForTest(tab)).toBe(
      "active=no stop=no progress=no completeUi=yes send=yes reasoningUi=missing downgrade=suspect",
    );
  });

  test("does not print empty thinking-only ChatGPT home as active", () => {
    const tab = {
      stopExists: false,
      thinkingActive: true,
      completionVisible: false,
      state: "completed",
      authenticated: true,
      sendExists: false,
      promptReady: true,
      assistantCount: 0,
    } as Pick<
      ChatGptTabSummary,
      | "stopExists"
      | "thinkingActive"
      | "completionVisible"
      | "state"
      | "authenticated"
      | "sendExists"
      | "promptReady"
      | "assistantCount"
    >;
    expect(isBrowserTabActiveForTest(tab)).toBe(false);
    expect(formatBrowserSignalsForTest(tab)).toBe(
      "active=no stop=no progress=no completeUi=no send=no",
    );
  });

  test("does not print completed UI with stale thinking as active", () => {
    const tab = {
      stopExists: false,
      thinkingActive: true,
      completionVisible: true,
      state: "running",
      authenticated: true,
      sendExists: true,
      promptReady: true,
      assistantCount: 2,
    } as Pick<
      ChatGptTabSummary,
      | "stopExists"
      | "thinkingActive"
      | "completionVisible"
      | "state"
      | "authenticated"
      | "sendExists"
      | "promptReady"
      | "assistantCount"
    >;
    expect(isBrowserTabActiveForTest(tab)).toBe(false);
    expect(formatBrowserSignalsForTest(tab)).toBe(
      "active=no stop=no progress=no completeUi=yes send=yes",
    );
  });

  test("prints blocker details separately from Stop visibility", () => {
    const tab = {
      blocker: "login-expired",
      stopExists: true,
      thinkingActive: false,
      completionVisible: false,
      state: "blocked",
      authenticated: false,
      sendExists: false,
      promptReady: false,
      assistantCount: 1,
    } as Pick<
      ChatGptTabSummary,
      | "blocker"
      | "stopExists"
      | "thinkingActive"
      | "completionVisible"
      | "state"
      | "authenticated"
      | "sendExists"
      | "promptReady"
      | "assistantCount"
    >;
    expect(isBrowserTabActiveForTest(tab)).toBe(false);
    expect(formatBrowserSignalsForTest(tab)).toBe(
      "active=no stop=yes progress=yes completeUi=no send=no blocker=login-expired",
    );
  });

  test("resolves owner labels while tolerating legacy browser metadata", () => {
    expect(
      resolveBrowserOwnerLabelForTest({
        id: "legacy-session",
        createdAt: "2026-05-05T00:00:00.000Z",
        status: "completed",
        options: {},
        browser: { runtime: { chromeTargetId: "target-1" } },
      } as SessionMetadata),
    ).toBe("legacy-session");

    expect(
      resolveBrowserOwnerLabelForTest({
        id: "session-1",
        createdAt: "2026-05-05T00:00:00.000Z",
        status: "completed",
        options: {},
        mode: "browser",
        browser: { ownerLabel: "agent-a" },
      } as SessionMetadata),
    ).toBe("agent-a");
  });

  test("builds backward-compatible enriched harvest metadata", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        ownerLabel: "agent-a",
        ownerSource: "explicit",
        harvest: {
          targetId: "legacy-target",
          state: "completed",
        },
      },
    } as SessionMetadata;
    const harvested = {
      targetId: "target-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/conversation-1",
      currentModelLabel: "GPT-5.5",
      stopExists: false,
      reasoningUiState: "complete",
      reasoningUiText: "Thought for 8s",
      reasoningUiEvidence: ["reasoning-duration"],
      reasoningDowngradeSuspected: false,
      sendExists: true,
      promptReady: true,
      loginButtonExists: false,
      authenticated: true,
      assistantCount: 2,
      firstAssistantText: "Opening line\nBody",
      firstAssistantSnippet: "Opening line Body",
      openingLine: "Opening line",
      lastAssistantText: "Last answer",
      lastAssistantSnippet: "Last answer",
      lastUserText: "Last prompt",
      lastUserSnippet: "Last prompt",
      focused: true,
      visibilityState: "visible",
      conversationId: "conversation-1",
      fingerprint: "fp",
      state: "completed",
      lastAssistantMarkdown: "Last answer",
    } as ChatGptTabSummary;

    const browser = buildHarvestBrowserMetadataForTest(
      meta,
      harvested,
      new Date("2026-05-06T00:00:00.000Z"),
    );

    expect(browser.harvest).toMatchObject({
      ownerLabel: "agent-a",
      ownerSource: "explicit",
      targetId: "target-1",
      conversationId: "conversation-1",
      harvestedAt: "2026-05-06T00:00:00.000Z",
      assistantCount: 2,
      currentModelLabel: "GPT-5.5",
      reasoningUiState: "complete",
      reasoningUiText: "Thought for 8s",
      reasoningUiEvidence: ["reasoning-duration"],
      reasoningDowngradeSuspected: false,
      firstAssistantSnippet: "Opening line Body",
      openingLine: "Opening line",
      lastAssistantSnippet: "Last answer",
      lastUserSnippet: "Last prompt",
    });
  });

  test("formats harvest output with lineage, signals, and snippets", () => {
    const harvested = {
      targetId: "target-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/conversation-1",
      currentModelLabel: "GPT-5.5",
      stopExists: true,
      sendExists: false,
      promptReady: false,
      loginButtonExists: false,
      authenticated: true,
      assistantCount: 2,
      firstAssistantText: "Opening line\nBody",
      firstAssistantSnippet: "Opening line Body",
      openingLine: "Opening line",
      lastAssistantText: "Last answer",
      lastAssistantSnippet: "Last answer",
      lastUserText: "Last prompt",
      lastUserSnippet: "Last prompt",
      focused: true,
      visibilityState: "visible",
      conversationId: "conversation-1",
      fingerprint: "fp",
      state: "running",
      lastAssistantMarkdown: "Last answer",
    } as ChatGptTabSummary;

    expect(formatHarvestSummaryLinesForTest("session-1", harvested, "agent-a")).toEqual([
      "Session: session-1",
      "Owner: agent-a",
      "Target: target-1",
      "Conversation: conversation-1",
      "State: running",
      "Model: GPT-5.5",
      "URL: https://chatgpt.com/c/conversation-1",
      "Assistant turns: 2",
      "Signals: active=yes stop=yes progress=yes completeUi=no send=no",
      "Opening: Opening line",
      "Last assistant: Last answer",
      "Last user: Last prompt",
    ]);
  });

  test("formats browser tab status lines with lineage and URL-derived conversation id", () => {
    const tab = {
      targetId: "target-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/conversation-1",
      currentModelLabel: "GPT-5.5",
      stopExists: true,
      reasoningUiState: "active",
      reasoningUiText: "Pro thinking",
      reasoningUiEvidence: ["reasoning-active"],
      reasoningDowngradeSuspected: false,
      sendExists: false,
      promptReady: false,
      loginButtonExists: false,
      authenticated: true,
      assistantCount: 2,
      firstAssistantText: "Opening line\nBody",
      firstAssistantSnippet: "Opening line Body",
      openingLine: "Opening line",
      lastAssistantText: "Last answer",
      lastAssistantSnippet: "Last answer",
      lastUserText: "Last prompt",
      lastUserSnippet: "Last prompt",
      focused: true,
      visibilityState: "visible",
      fingerprint: "fp",
      state: "running",
      lastAssistantMarkdown: "Last answer",
    } as ChatGptTabSummary;
    const linkedSession = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "running",
      startedAt: "2026-05-05T00:10:00.000Z",
      options: {},
      mode: "browser",
      browser: {
        ownerLabel: "agent-a",
        runtime: {
          userDataDir: "/profiles/oracle",
          controllerPid: 1234,
          chromePid: 5678,
        },
      },
    } as SessionMetadata;

    expect(formatBrowserTabStatusLinesForTest(tab, linkedSession)).toEqual([
      "- target-1 running active=yes stop=yes progress=yes completeUi=no send=no reasoningUi=active model=GPT-5.5 turns=2",
      "  title=ChatGPT",
      "  url=https://chatgpt.com/c/conversation-1",
      "  conversation=conversation-1",
      "  session=session-1",
      "  owner=agent-a",
      "  profile=/profiles/oracle",
      "  runtime=status=running cdp=reachable controllerPid=1234(dead) chromePid=5678(dead) startedAt=2026-05-05T00:10:00.000Z",
      "  opening=Opening line",
      "  last=Last answer",
      "  lastUser=Last prompt",
      "  evidence=visible-stop-button,assistant-turns=2,last-user-present,last-assistant-present,reasoning-ui-active",
      "  reasoning=active (Pro thinking) evidence=reasoning-active",
    ]);
  });

  test("formats completed Pro tabs with missing reasoning UI as suspect", () => {
    const tab = {
      targetId: "target-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/conversation-1",
      currentModelLabel: "Pro",
      stopExists: false,
      thinkingActive: false,
      reasoningUiState: "missing",
      reasoningUiText: "",
      reasoningUiEvidence: [],
      reasoningDowngradeSuspected: true,
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
      fingerprint: "fp",
      state: "completed",
      lastAssistantMarkdown: "Answer",
    } as ChatGptTabSummary;

    expect(formatBrowserTabStatusLinesForTest(tab, null)).toEqual([
      "- target-1 completed active=no stop=no progress=no completeUi=yes send=yes reasoningUi=missing downgrade=suspect model=Pro turns=1",
      "  title=ChatGPT",
      "  url=https://chatgpt.com/c/conversation-1",
      "  conversation=conversation-1",
      "  opening=Answer",
      "  last=Answer",
      "  reasoning=missing downgrade=suspect",
    ]);
  });

  test("formats unsaved root tabs with user-visible provenance evidence", () => {
    const tab = {
      targetId: "target-root",
      title: "ChatGPT",
      url: "https://chatgpt.com/",
      currentModelLabel: "Pro",
      stopExists: true,
      thinkingActive: true,
      completionVisible: false,
      sendExists: false,
      promptReady: true,
      loginButtonExists: false,
      authenticated: true,
      assistantCount: 2,
      firstAssistantText: "Pro thinking",
      firstAssistantSnippet: "Pro thinking",
      openingLine: "Pro thinking",
      lastAssistantText: "Pro thinking",
      lastAssistantSnippet: "Pro thinking",
      lastUserText: "Produce the actual complete unified diff inline now.",
      lastUserSnippet: "Produce the actual complete unified diff inline now.",
      focused: false,
      visibilityState: "visible",
      fingerprint: "fp",
      state: "running",
      lastAssistantMarkdown: null,
    } as ChatGptTabSummary;

    expect(formatBrowserTabStatusLinesForTest(tab, null)).toEqual([
      "- target-root running active=yes stop=yes progress=yes completeUi=no send=no model=Pro turns=2",
      "  title=ChatGPT",
      "  url=https://chatgpt.com/",
      "  conversation=(unsaved root tab)",
      "  opening=Pro thinking",
      "  last=Pro thinking",
      "  lastUser=Produce the actual complete unified diff inline now.",
      "  evidence=root-url,visible-stop-button,response-progress-active,assistant-turns=2,last-user-present,last-assistant-present",
    ]);
  });

  test("resolves browser profile labels from runtime and config metadata", () => {
    expect(
      resolveBrowserProfileLabelForTest({
        id: "runtime-profile",
        createdAt: "2026-05-05T00:00:00.000Z",
        status: "running",
        options: {},
        mode: "browser",
        browser: {
          runtime: { userDataDir: "/profiles/runtime" },
          config: { manualLoginProfileDir: "/profiles/config" },
        },
      } as SessionMetadata),
    ).toBe("/profiles/runtime");

    expect(
      resolveBrowserProfileLabelForTest({
        id: "config-profile",
        createdAt: "2026-05-05T00:00:00.000Z",
        status: "running",
        options: { browserConfig: { manualLoginProfileDir: "/profiles/options" } },
        mode: "browser",
        browser: {
          config: { manualLoginProfileDir: "/profiles/config" },
        },
      } as SessionMetadata),
    ).toBe("/profiles/config");
  });

  test("resolves browser runtime labels for provenance debugging", () => {
    expect(
      resolveBrowserRuntimeLabelForTest({
        id: "running-session",
        createdAt: "2026-05-05T00:00:00.000Z",
        startedAt: "2026-05-05T00:10:00.000Z",
        status: "running",
        options: {},
        mode: "browser",
        browser: {
          runtime: {
            controllerPid: 1234,
            chromePid: 5678,
          },
        },
      } as SessionMetadata),
    ).toBe(
      "status=running controllerPid=1234(dead) chromePid=5678(dead) startedAt=2026-05-05T00:10:00.000Z",
    );

    expect(resolveBrowserRuntimeLabelForTest(null)).toBeNull();

    expect(
      resolveBrowserRuntimeLabelForTest(
        {
          id: "stale-running-session",
          createdAt: "2026-05-05T00:00:00.000Z",
          startedAt: "2026-05-05T00:10:00.000Z",
          status: "running",
          options: {},
          mode: "browser",
          browser: {
            runtime: {
              controllerPid: 1234,
            },
          },
        } as SessionMetadata,
        {
          state: "completed",
          blocker: undefined,
          stopExists: false,
          thinkingActive: false,
          completionVisible: true,
          authenticated: true,
          sendExists: true,
          promptReady: true,
          assistantCount: 1,
        },
      ),
    ).toBe(
      "status=running(stale) cdp=reachable controllerPid=1234(dead) startedAt=2026-05-05T00:10:00.000Z",
    );
  });

  test("uses persisted harvest snippet when live tab snippet is only a tiny partial", () => {
    const tab = {
      targetId: "target-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/conversation-1",
      currentModelLabel: "GPT-5.5",
      stopExists: false,
      sendExists: true,
      promptReady: true,
      loginButtonExists: false,
      authenticated: true,
      assistantCount: 2,
      firstAssistantText: "Opening line\nBody",
      firstAssistantSnippet: "Opening line Body",
      openingLine: "Opening line",
      lastAssistantText: "I",
      lastAssistantSnippet: "I",
      lastUserText: "Last prompt",
      lastUserSnippet: "Last prompt",
      focused: true,
      visibilityState: "visible",
      fingerprint: "fp",
      state: "completed",
      lastAssistantMarkdown: null,
    } as ChatGptTabSummary;
    const linkedSession = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        ownerLabel: "agent-a",
        harvest: {
          lastAssistantSnippet:
            "According to the uploaded context, this is the complete assistant answer.",
        },
      },
    } as SessionMetadata;

    expect(formatBrowserTabStatusLinesForTest(tab, linkedSession)).toContain(
      "  last=According to the uploaded context, this is the complete assistant answer.",
    );
  });

  test("formats live status lines with session provenance and snippets", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "running",
      options: {},
      mode: "browser",
      browser: { ownerLabel: "agent-a" },
    } as SessionMetadata;
    const harvested = {
      targetId: "target-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/conversation-1",
      currentModelLabel: "GPT-5.5",
      stopExists: true,
      sendExists: false,
      promptReady: false,
      loginButtonExists: false,
      authenticated: true,
      assistantCount: 2,
      firstAssistantText: "Opening line\nBody",
      firstAssistantSnippet: "Opening line Body",
      openingLine: "Opening line",
      lastAssistantText: "Last answer",
      lastAssistantSnippet: "Last answer",
      lastUserText: "Last prompt",
      lastUserSnippet: "Last prompt",
      focused: true,
      visibilityState: "visible",
      fingerprint: "fp",
      state: "completed",
      lastAssistantMarkdown: "Last answer",
    } as ChatGptTabSummary;

    expect(
      formatLiveTailStatusLineForTest(
        "session-1",
        meta,
        harvested,
        new Date("2026-05-06T00:00:00.000Z"),
      ),
    ).toBe(
      "[2026-05-06T00:00:00.000Z] session=session-1 owner=agent-a target=target-1 conversation=conversation-1 state=completed active=yes stop=yes progress=yes completeUi=no send=no model=GPT-5.5 turns=2 opening=Opening line last=Last answer",
    );
  });
});
