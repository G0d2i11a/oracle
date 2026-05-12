import { describe, expect, test } from "vitest";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.ts";

describe("prompt composer attachment expressions", () => {
  test("attachment ready check does not match prompt text", () => {
    const expression = buildAttachmentReadyExpressionForTest(["oracle-attach-verify.txt"]);
    expect(expression).toContain("document.querySelector('[data-testid*=\"composer\"]')");
    expect(expression).toContain("attachmentRoots");
    expect(expression).toContain('input[type="file"]');
    expect(expression).toContain('[aria-label*="Remove file"]');
    expect(expression).toContain("getAttribute?.('aria-label')");
    expect(expression).toContain("\\s*\\(\\d+\\)");
    expect(expression).toContain("observedNames");
    expect(expression).toContain("chipNames");
    expect(expression).toContain("inputNames");
    expect(expression).not.toContain("a,div,span");
    expect(expression).not.toContain("chipsReady || inputsReady");
    expect(expression).not.toContain(
      'document.querySelectorAll(\'[data-testid*="chip"],[data-testid*="attachment"],a,div,span\')',
    );
  });
});
