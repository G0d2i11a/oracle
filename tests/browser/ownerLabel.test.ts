import { describe, expect, test } from "vitest";
import {
  deriveBrowserOwnerLabel,
  sanitizeBrowserOwnerLabel,
} from "../../src/browser/ownerLabel.js";

describe("browser owner labels", () => {
  test("sanitizes labels conservatively", () => {
    expect(sanitizeBrowserOwnerLabel(" Agent One \n repo ")).toBe("Agent-One-repo");
    expect(sanitizeBrowserOwnerLabel("team/worker:@2")).toBe("team/worker:@2");
    expect(sanitizeBrowserOwnerLabel("   ")).toBeUndefined();
  });

  test("prefers explicit labels over every fallback", () => {
    expect(
      deriveBrowserOwnerLabel({
        explicit: "codex agent a",
        optionSlug: "slug-label",
        sessionId: "session-1",
        cwd: "/tmp/oracle",
        pid: 123,
        env: { ORACLE_BROWSER_OWNER_LABEL: "env-label" },
      }),
    ).toEqual({ label: "codex-agent-a", source: "explicit" });
  });

  test("prefers env labels before slug defaults", () => {
    expect(
      deriveBrowserOwnerLabel({
        optionSlug: "slug-label",
        sessionId: "session-1",
        cwd: "/tmp/oracle",
        pid: 123,
        env: { ORACLE_BROWSER_OWNER_LABEL: "ralph-worker-2" },
      }),
    ).toEqual({ label: "ralph-worker-2", source: "env" });
  });

  test("falls back through slug, cwd/pid, cwd, pid, and session id", () => {
    expect(
      deriveBrowserOwnerLabel({
        optionSlug: "custom slug",
        sessionId: "session-1",
        cwd: "/tmp/oracle",
        pid: 123,
        env: {},
      }),
    ).toEqual({ label: "custom-slug", source: "slug" });
    expect(
      deriveBrowserOwnerLabel({
        sessionId: "session-1",
        cwd: "/Users/shawn/Workspace/oracle",
        pid: 456,
        env: {},
      }),
    ).toEqual({ label: "oracle:pid-456", source: "cwd-pid" });
    expect(
      deriveBrowserOwnerLabel({
        sessionId: "session-1",
        cwd: "/Users/shawn/Workspace/oracle",
        env: {},
      }),
    ).toEqual({ label: "oracle", source: "cwd" });
    expect(deriveBrowserOwnerLabel({ sessionId: "session-1", pid: 789, env: {} })).toEqual({
      label: "pid-789",
      source: "pid",
    });
    expect(deriveBrowserOwnerLabel({ sessionId: "session-abc", env: {} })).toEqual({
      label: "session-abc",
      source: "session-id",
    });
  });
});
