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

  test("keeps live tail running while Stop remains visible", () => {
    const unchangedSince = Date.now() - 120_000;
    expect(
      deriveLiveTailStateForTest({ stopExists: true, authenticated: true }, unchangedSince, 60_000),
    ).toBe("running");
  });

  test("does not keep live tail running forever when ChatGPT login has expired", () => {
    const unchangedSince = Date.now() - 120_000;
    expect(
      deriveLiveTailStateForTest(
        { blocker: "login-expired", stopExists: true, authenticated: false },
        unchangedSince,
        60_000,
      ),
    ).toBe("blocked");
  });

  test("keeps live tail running while Pro thinking continues after first text", () => {
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
      state: "completed",
      authenticated: true,
      sendExists: false,
      promptReady: false,
      assistantCount: 1,
    } as Pick<
      ChatGptTabSummary,
      "stopExists" | "state" | "authenticated" | "sendExists" | "promptReady" | "assistantCount"
    >;
    expect(isBrowserTabActiveForTest(tab)).toBe(true);
    expect(formatBrowserSignalsForTest(tab)).toBe(
      "active=yes stop=yes thinking=yes completeUi=no send=no",
    );
  });

  test("prints blocker details separately from Stop visibility", () => {
    const tab = {
      blocker: "login-expired",
      stopExists: true,
      state: "blocked",
      authenticated: false,
      sendExists: false,
      promptReady: false,
      assistantCount: 1,
    } as Pick<
      ChatGptTabSummary,
      | "blocker"
      | "stopExists"
      | "state"
      | "authenticated"
      | "sendExists"
      | "promptReady"
      | "assistantCount"
    >;
    expect(isBrowserTabActiveForTest(tab)).toBe(false);
    expect(formatBrowserSignalsForTest(tab)).toBe(
      "active=no stop=yes thinking=yes completeUi=no send=no blocker=login-expired",
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
      "Signals: active=yes stop=yes thinking=yes completeUi=no send=no",
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
      options: {},
      mode: "browser",
      browser: { ownerLabel: "agent-a" },
    } as SessionMetadata;

    expect(formatBrowserTabStatusLinesForTest(tab, linkedSession)).toEqual([
      "- target-1 running active=yes stop=yes thinking=yes completeUi=no send=no model=GPT-5.5 turns=2",
      "  title=ChatGPT",
      "  url=https://chatgpt.com/c/conversation-1",
      "  conversation=conversation-1",
      "  session=session-1",
      "  owner=agent-a",
      "  opening=Opening line",
      "  last=Last answer",
    ]);
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
      "[2026-05-06T00:00:00.000Z] session=session-1 owner=agent-a target=target-1 conversation=conversation-1 state=completed active=yes stop=yes thinking=yes completeUi=no send=no model=GPT-5.5 turns=2 opening=Opening line last=Last answer",
    );
  });
});
