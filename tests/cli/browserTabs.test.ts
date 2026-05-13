import { describe, expect, test } from "vitest";
import {
  deriveLiveTailStateForTest,
  formatBrowserSignalsForTest,
  isBrowserTabActiveForTest,
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
    expect(formatBrowserSignalsForTest(tab)).toBe("active=yes stop=yes send=no");
  });
});
