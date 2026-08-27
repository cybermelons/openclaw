import { describe, expect, it } from "vitest";
import { SessionConflictError } from "./session-conflict-error.js";
import { SessionRowCorruptError } from "./session-row-corrupt-error.js";
import { withSessionRetry } from "./with-session-retry.js";

describe("SessionRowCorruptError", () => {
  it("sets its fields, is instanceof Error, retryable is false, and the message omits the full blob", () => {
    const blob = `{"garbage": true, "padding": "${"x".repeat(500)}"}`;
    const err = new SessionRowCorruptError({
      key: "session:corrupt-1",
      reason: "JSON.parse failed",
      blobExcerpt: blob.slice(0, 64),
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SessionRowCorruptError);
    expect(err.key).toBe("session:corrupt-1");
    expect(err.reason).toBe("JSON.parse failed");
    expect(err.blobExcerpt).toBe(blob.slice(0, 64));
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain(blob);
    expect(err.message.length).toBeLessThan(blob.length);
  });
});

describe("withSessionRetry — SessionRowCorruptError (T-P2f)", () => {
  it("rethrows SessionRowCorruptError on attempt 1 without retrying", async () => {
    let calls = 0;
    const corrupt = new SessionRowCorruptError({
      key: "session:corrupt-2",
      reason: "unexpected token",
      blobExcerpt: "{not json",
    });

    await expect(
      withSessionRetry(async () => {
        calls += 1;
        throw corrupt;
      }, 5),
    ).rejects.toBe(corrupt);

    expect(calls).toBe(1);
  });

  it("still retries an ordinary retryable SessionConflictError (control case)", async () => {
    let calls = 0;
    const result = await withSessionRetry(async (attempt) => {
      calls += 1;
      if (attempt < 2) {
        throw new SessionConflictError({
          key: "session:control",
          expectedRevision: attempt,
          actualRevision: attempt + 1,
        });
      }
      return "ok";
    }, 3);

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});
