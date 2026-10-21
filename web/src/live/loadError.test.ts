import { describe, it, expect, vi, afterEach } from "vitest";
import { UNREACHABLE, fetchLoad, loadError, statusOf } from "./loadError";

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  } as unknown as Response;
}

describe("loadError", () => {
  it("gives what failed and the server's reason when it answered", () => {
    expect(loadError("the briefing", "database is locked")).toBe(
      "Couldn't load the briefing: database is locked",
    );
    expect(loadError("the Vault", "HTTP 500", "search")).toBe(
      "Couldn't search the Vault: HTTP 500",
    );
  });

  it("says only that the server was unreachable when it did not answer", () => {
    expect(loadError("the briefing", UNREACHABLE)).toBe("Couldn't reach the Argus server");
  });
});

describe("fetchLoad", () => {
  it("keeps the server's JSON reason and the status of an error answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(500, { error: "database is locked" })));
    const e = await fetchLoad("/api/briefing").catch((x: unknown) => x);
    expect((e as Error).message).toBe("database is locked");
    expect(statusOf(e)).toBe(500);
  });

  it("reads a `message` reason too, and falls back to the status without one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(400, { message: "bad window" })));
    await expect(fetchLoad("/api/x")).rejects.toThrow("bad window");

    // A proxy's HTML error page is not JSON: the status is all there is.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(502, new SyntaxError("<html>"))));
    await expect(fetchLoad("/api/x")).rejects.toThrow("HTTP 502");
  });

  it("words a rejected fetch as unreachable, with no status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const e = await fetchLoad("/api/briefing").catch((x: unknown) => x);
    expect((e as Error).message).toBe(UNREACHABLE);
    expect(statusOf(e)).toBeNull();
  });

  it("lets an abort through as itself, not as a failure to report", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(fetchLoad("/api/x", { signal: controller.signal })).rejects.toBe(abort);
  });

  it("resolves with a 2xx, and with the 304 a validator asked for", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(304, null)));
    expect((await fetchLoad("/api/x")).status).toBe(304);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(200, { ok: true })));
    expect((await fetchLoad("/api/x")).status).toBe(200);
  });
});
