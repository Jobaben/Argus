import { describe, it, expect } from "vitest";
import { STATUS, toDsStatus, runDsStatus } from "./status";

describe("STATUS record", () => {
  it("maps each status to its color token", () => {
    expect(STATUS.working.token).toBe("run");
    expect(STATUS.done.token).toBe("ok");
    expect(STATUS.failed.token).toBe("fail");
    expect(STATUS.queued.token).toBe("queue");
    expect(STATUS.idle.token).toBe("idle");
    expect(STATUS.await.token).toBe("await");
  });

  it("glows only for working, failed, await", () => {
    expect(STATUS.working.glow).toBe(true);
    expect(STATUS.failed.glow).toBe(true);
    expect(STATUS.await.glow).toBe(true);
    expect(STATUS.done.glow).toBe(false);
    expect(STATUS.queued.glow).toBe(false);
    expect(STATUS.idle.glow).toBe(false);
  });

  it('labels "await" as "Needs approval"', () => {
    expect(STATUS.await.label).toBe("Needs approval");
  });

  it("adds a label-distinct Stopped status on the idle color token", () => {
    expect(STATUS.stopped.token).toBe("idle");
    expect(STATUS.stopped.label).toBe("Stopped");
    expect(STATUS.stopped.glow).toBe(false);
  });
});

describe("toDsStatus", () => {
  it("passes through known statuses", () => {
    expect(toDsStatus("working")).toBe("working");
    expect(toDsStatus("done")).toBe("done");
    expect(toDsStatus("failed")).toBe("failed");
    expect(toDsStatus("queued")).toBe("queued");
    expect(toDsStatus("idle")).toBe("idle");
  });

  it("folds stopped and unknown into idle", () => {
    expect(toDsStatus("stopped")).toBe("idle");
    expect(toDsStatus("unknown")).toBe("idle");
  });
});

describe("runDsStatus", () => {
  it("shows failed when the outcome failed even if the process exited 0", () => {
    expect(runDsStatus({ status: "succeeded", outcome: "failed" })).toBe("failed");
    expect(runDsStatus({ status: "succeeded", outcome: "blocked" })).toBe("failed");
  });

  it("falls back to the process status when there is no failing outcome", () => {
    expect(runDsStatus({ status: "succeeded", outcome: "succeeded" })).toBe("done");
    expect(runDsStatus({ status: "running" })).toBe("working");
  });
});
