import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { InstancesRunningError, usePipelines } from "./usePipelines";

class FakeWS {
  onmessage: ((ev: unknown) => void) | null = null;
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("usePipelines", () => {
  it("loads the pipeline list on mount", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ pipelines: [{ id: "p1", name: "One" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => usePipelines());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pipelines).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/pipelines", expect.anything());
  });

  it("create POSTs the input to /api/pipelines", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ pipelines: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => usePipelines());
    await act(async () => {
      await result.current.create({ name: "p", phases: [], trigger: null });
    });
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/pipelines" && c[1]?.method === "POST",
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body as string)).toMatchObject({ name: "p" });
  });

  it("setEnabled PATCHes { enabled } to the pipeline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ pipelines: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => usePipelines());
    await act(async () => {
      await result.current.setEnabled("p1", false);
    });
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/pipelines/p1" && c[1]?.method === "PATCH",
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body as string)).toEqual({ enabled: false });
  });

  it("update PUTs the input, adding ?force=1 only when forced", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ pipelines: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => usePipelines());
    const input = { name: "p", phases: [], trigger: null };
    await act(async () => {
      await result.current.update("p1", input);
      await result.current.update("p1", input, { force: true });
    });
    const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === "PUT").map((c) => c[0]);
    expect(puts).toEqual(["/api/pipelines/p1", "/api/pipelines/p1?force=1"]);
  });

  it("a 409 naming running instances is an InstancesRunningError carrying them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ pipelines: [] })) // mount refresh
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: "1 instance is running",
          code: "instances-running",
          instances: [{ id: "i1", status: "running" }],
        }),
      } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => usePipelines());
    const attempt = result.current.update("p1", { name: "p", phases: [], trigger: null });
    await expect(attempt).rejects.toBeInstanceOf(InstancesRunningError);
    await attempt.catch((e: InstancesRunningError) => {
      expect(e.message).toBe("1 instance is running");
      expect(e.instances).toEqual([{ id: "i1", status: "running" }]);
    });
  });

  it("surfaces the server error message on a failed mutation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ pipelines: [] })) // mount refresh
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "already running" }),
      } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => usePipelines());
    await expect(result.current.runNow("p1")).rejects.toThrow("already running");
  });
});
