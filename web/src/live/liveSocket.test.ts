import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { subscribeLive, isLive } from "./liveSocket";
import type { LiveFrame } from "./liveSocket";

let sockets: FakeWS[] = [];

class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor() {
    sockets.push(this);
  }
  open() {
    this.onopen?.();
  }
  send(raw: string) {
    this.onmessage?.({ data: raw });
  }
  emit(obj: unknown) {
    this.send(JSON.stringify(obj));
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

function collect(): { frames: LiveFrame[]; stop: () => void } {
  const frames: LiveFrame[] = [];
  const stop = subscribeLive({ onMessage: (f) => frames.push(f) });
  return { frames, stop };
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("liveSocket frame parsing", () => {
  it("forwards a well-formed change ping", () => {
    const { frames, stop } = collect();
    sockets[0].emit({ type: "pipelines:changed" });
    expect(frames).toEqual([{ type: "pipelines:changed" }]);
    stop();
  });

  it("drops non-JSON, non-object and type-less frames", () => {
    const { frames, stop } = collect();
    sockets[0].send("not json{");
    sockets[0].emit(42);
    sockets[0].emit(null);
    sockets[0].emit({ noType: true });
    sockets[0].emit({ type: 7 });
    expect(frames).toEqual([]);
    stop();
  });

  it("drops a run:activity frame with a missing or malformed payload", () => {
    const { frames, stop } = collect();
    sockets[0].emit({ type: "run:activity", runId: "r1" }); // no events
    sockets[0].emit({ type: "run:activity", runId: "r1", events: [] }); // empty batch
    sockets[0].emit({ type: "run:activity", events: [{ at: "t", label: "l" }] }); // no runId
    sockets[0].emit({ type: "run:activity", runId: "r1", events: [{ label: "l" }] }); // no `at`
    sockets[0].emit({ type: "run:activity", runId: "r1", events: ["nope"] });
    expect(frames).toEqual([]);
    stop();
  });

  it("forwards a well-formed run:activity frame", () => {
    const { frames, stop } = collect();
    const frame = {
      type: "run:activity",
      runId: "r1",
      events: [{ at: "2026-07-07T10:00:00.000Z", kind: "tool", label: "Bash: npm ci" }],
    };
    sockets[0].emit(frame);
    expect(frames).toEqual([frame]);
    stop();
  });

  it("drops an alert frame with no alert body and keeps a valid one", () => {
    const { frames, stop } = collect();
    sockets[0].emit({ type: "monitors:alert" });
    sockets[0].emit({ type: "budget:alert", alert: { noEvent: true } });
    const good = {
      type: "monitors:alert",
      alert: {
        event: "monitor.down",
        scheduleId: "s1",
        name: "Nightly",
        status: "down",
        at: "2026-07-07T10:00:00.000Z",
        detail: "expected a run, none arrived",
      },
    };
    sockets[0].emit(good);
    expect(frames).toEqual([good]);
    stop();
  });

  it("forwards a frame type this build does not know, for forward compatibility", () => {
    const { frames, stop } = collect();
    const future = { type: "something:new", payload: { a: 1 } };
    sockets[0].emit(future);
    expect(frames).toEqual([future]);
    stop();
  });
});

describe("liveSocket lifecycle", () => {
  it("opens one socket for many subscribers and closes it with the last", () => {
    const a = collect();
    const b = collect();
    expect(sockets.length).toBe(1);
    sockets[0].open();
    expect(isLive()).toBe(true);
    sockets[0].emit({ type: "agents:changed" });
    expect(a.frames.length).toBe(1);
    expect(b.frames.length).toBe(1);
    a.stop();
    expect(sockets[0].closed).toBe(false);
    b.stop();
    expect(sockets[0].closed).toBe(true);
  });

  it("reconnects after an unexpected close while a subscriber remains", () => {
    const { stop } = collect();
    sockets[0].open();
    sockets[0].close();
    expect(isLive()).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(sockets.length).toBe(2);
    stop();
  });

  it("reports the current status immediately to a late subscriber", () => {
    const first = collect();
    sockets[0].open();
    const seen: boolean[] = [];
    const stop = subscribeLive({ onStatus: ({ live }) => seen.push(live) });
    expect(seen).toEqual([true]);
    stop();
    first.stop();
  });
});
