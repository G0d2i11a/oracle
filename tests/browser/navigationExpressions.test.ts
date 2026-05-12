import { describe, expect, test } from "vitest";
import { buildUnarchiveConversationExpressionForTest } from "../../src/browser/actions/navigation.ts";

describe("navigation expressions", () => {
  test("unarchive expression detects archived ChatGPT conversations", () => {
    const expression = buildUnarchiveConversationExpressionForTest();

    expect(expression).toContain("conversation is archived");
    expect(expression).toContain("this conversation is archived");
    expect(expression).toContain("unarchive");
    expect(expression).toContain("restore conversation");
    expect(expression).toContain("target.click()");
  });
});
