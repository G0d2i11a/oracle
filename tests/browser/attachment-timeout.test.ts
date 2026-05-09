import { describe, expect, test } from "vitest";
import { isAttachmentUploadTimeoutErrorForTest } from "../../src/browser/index.js";

describe("isAttachmentUploadTimeoutErrorForTest", () => {
  test("matches the browser attachment timeout error", () => {
    expect(
      isAttachmentUploadTimeoutErrorForTest(
        new Error("Attachments did not finish uploading before timeout."),
      ),
    ).toBe(true);
  });

  test("does not match unrelated browser errors", () => {
    expect(
      isAttachmentUploadTimeoutErrorForTest(
        new Error("Attachment did not appear in ChatGPT composer."),
      ),
    ).toBe(false);
  });
});
