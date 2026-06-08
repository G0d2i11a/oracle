import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserLogger } from "../../src/browser/types.js";

describe("resolveAttachRunningConnection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("defaults attach-running discovery to 127.0.0.1:9222", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => [
        {
          port: 9222,
          browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/default",
          path: "/profiles/default/DevToolsActivePort",
          profileRoot: "/profiles/default",
          mtimeMs: 10,
        },
      ]),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn();

    const result = await resolveAttachRunningConnection(
      { chromePath: null, remoteChrome: undefined },
      logger,
    );

    expect(result).toMatchObject({
      host: "127.0.0.1",
      port: 9222,
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/default",
      profileRoot: "/profiles/default",
    });
    expect(logger).not.toHaveBeenCalledWith(
      expect.stringContaining("Waiting for Chrome remote debugging approval"),
    );
    expect(logger).toHaveBeenCalledWith(
      "Selected attach-running browser metadata from /profiles/default/DevToolsActivePort",
    );
  });

  test("uses remote-chrome as the attach-running hint and prefers the newest candidate", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => [
        {
          port: 63332,
          browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/older",
          path: "/profiles/dia-older/DevToolsActivePort",
          profileRoot: "/profiles/dia-older",
          mtimeMs: 5,
        },
        {
          port: 63332,
          browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/newer",
          path: "/profiles/dia-newer/DevToolsActivePort",
          profileRoot: "/profiles/dia-newer",
          mtimeMs: 20,
        },
      ]),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn();

    const result = await resolveAttachRunningConnection(
      {
        chromePath: "/Applications/Dia.app/Contents/MacOS/Dia",
        remoteChrome: { host: "127.0.0.1", port: 63332 },
      },
      logger,
    );

    expect(result).toMatchObject({
      host: "127.0.0.1",
      port: 63332,
      browserWSEndpoint: "ws://127.0.0.1:63332/devtools/browser/newer",
      profileRoot: "/profiles/dia-newer",
    });
    expect(logger).toHaveBeenCalledWith(
      "Note: --browser-chrome-path is ignored when --browser-attach-running is enabled.",
    );
    expect(logger).toHaveBeenCalledWith(
      "Selected attach-running browser metadata from /profiles/dia-newer/DevToolsActivePort",
    );
  });

  test("resolves bare DevToolsActivePort websocket paths through /json/version", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => [
        {
          port: 53193,
          browserWSEndpoint: "ws://127.0.0.1:53193/devtools/browser",
          path: "/profiles/oracle/DevToolsActivePort",
          profileRoot: "/profiles/oracle",
          mtimeMs: 20,
        },
      ]),
    }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl:
          "ws://127.0.0.1:53193/devtools/browser/5ef5714d-f4d5-4b33-9e05-60fdaffa84e2",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn();

    const result = await resolveAttachRunningConnection(
      {
        chromePath: null,
        remoteChrome: { host: "127.0.0.1", port: 53193 },
      },
      logger,
    );

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:53193/json/version");
    expect(result.browserWSEndpoint).toBe(
      "ws://127.0.0.1:53193/devtools/browser/5ef5714d-f4d5-4b33-9e05-60fdaffa84e2",
    );
    expect(logger).toHaveBeenCalledWith(
      "Resolved attach-running browser websocket endpoint from /json/version.",
    );
  });

  test("rejects attach-running when no local DevToolsActivePort matches the selected port", async () => {
    vi.doMock("../../src/browser/detect.js", () => ({
      discoverDevToolsActivePortCandidates: vi.fn(async () => []),
    }));

    const { resolveAttachRunningConnection } = await import("../../src/browser/attachRunning.js");
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resolveAttachRunningConnection(
        {
          chromePath: null,
          remoteChrome: { host: "127.0.0.1", port: 63332 },
        },
        logger,
      ),
    ).rejects.toThrow(/No running browser with attach metadata matched 127\.0\.0\.1:63332/i);
  });
});
