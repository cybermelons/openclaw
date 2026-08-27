import { describe, expect, it } from "vitest";
import { SessionConflictError } from "./session-conflict-error.js";
import { withSessionRetry } from "./with-session-retry.js";

describe("withSessionRetry", () => {
  it("succeeds after N-1 injected conflicts when fn re-reads a fresh revision each attempt", async () => {
    const budget = 4;
    let calls = 0;
    const result = await withSessionRetry(async (attempt) => {
      calls += 1;
      // Simulates a correct fn: re-reads current revision fresh each attempt,
      // so each conflict carries a DIFFERENT expectedRevision.
      const expectedRevision = attempt;
      if (attempt < budget) {
        throw new SessionConflictError({
          key: "session:1",
          expectedRevision,
          actualRevision: expectedRevision + 1,
        });
      }
      return "ok";
    }, budget);

    expect(result).toBe("ok");
    expect(calls).toBe(budget);
  });

  it("rethrows a non-retryable error immediately without retrying", async () => {
    let calls = 0;
    const boom = new Error("boom");

    await expect(
      withSessionRetry(async () => {
        calls += 1;
        throw boom;
      }, 5),
    ).rejects.toBe(boom);

    expect(calls).toBe(1);
  });

  it("rethrows the last SessionConflictError when the budget is exhausted", async () => {
    const budget = 3;
    let calls = 0;
    const conflicts: SessionConflictError[] = [];

    await expect(
      withSessionRetry(async (attempt) => {
        calls += 1;
        const conflict = new SessionConflictError({
          key: "session:2",
          expectedRevision: attempt,
          actualRevision: attempt + 1,
        });
        conflicts.push(conflict);
        throw conflict;
      }, budget),
    ).rejects.toThrow(SessionConflictError);

    expect(calls).toBe(budget);

    const lastConflict = conflicts.at(-1);
    expect(lastConflict).toBeDefined();

    try {
      await withSessionRetry(async (attempt) => {
        throw new SessionConflictError({
          key: "session:2",
          expectedRevision: attempt,
          actualRevision: attempt + 1,
        });
      }, budget);
      expect.unreachable("expected withSessionRetry to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionConflictError);
      const thrown = err as SessionConflictError;
      expect(thrown.actualRevision).toBe(budget + 1);
    }
  });

  it("terminates on attempt 2 via the stale-closure tripwire when expectedRevision never changes", async () => {
    const budget = 10;
    let calls = 0;

    await expect(
      withSessionRetry(async () => {
        calls += 1;
        // Deliberately stale: same expectedRevision every attempt, as if fn
        // closed over a snapshot instead of re-reading.
        throw new SessionConflictError({
          key: "session:3",
          expectedRevision: 7,
          actualRevision: 8,
        });
      }, budget),
    ).rejects.toMatchObject({
      message: expect.stringContaining("stale closure"),
    });

    expect(calls).toBe(2);

    // Confirm the thrown error is NOT a SessionConflictError (so ordinary
    // retry callers won't retry it), and that it wraps the last conflict.
    calls = 0;
    try {
      await withSessionRetry(async () => {
        calls += 1;
        throw new SessionConflictError({
          key: "session:3",
          expectedRevision: 7,
          actualRevision: 8,
        });
      }, budget);
      expect.unreachable("expected withSessionRetry to throw");
    } catch (err) {
      expect(err).not.toBeInstanceOf(SessionConflictError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBeInstanceOf(SessionConflictError);
      expect(calls).toBe(2);
    }
  });
});
