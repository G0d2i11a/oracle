import { describe, expect, test } from "vitest";
import {
  isAttachmentUploadTimeoutErrorForTest,
  isAttachmentUploadVerificationErrorForTest,
} from "../../src/browser/index.js";

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

  test("matches attachment verification failures for full-context retry", () => {
    expect(
      isAttachmentUploadVerificationErrorForTest(
        new Error("Attachment did not appear in ChatGPT composer."),
      ),
    ).toBe(true);
    expect(
      isAttachmentUploadVerificationErrorForTest(
        new Error("Attachment was not present on the sent user message."),
      ),
    ).toBe(true);
  });
});
