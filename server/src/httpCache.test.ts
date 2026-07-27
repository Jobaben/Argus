import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { conditionalGet, ifNoneMatchMatches } from "./httpCache.js";

function appWith(body: unknown, opts: { status?: number; text?: boolean } = {}): Hono {
  const app = new Hono();
  app.use("*", conditionalGet());
  app.get("/r", (c) => {
    if (opts.text) return c.text(String(body));
    return c.json(body as object, (opts.status ?? 200) as 200);
  });
  app.post("/r", (c) => c.json({ ok: true }));
  return app;
}

describe("ifNoneMatchMatches", () => {
  it("matches a single tag, a list, and the wildcard", () => {
    assert.equal(ifNoneMatchMatches('"abc"', '"abc"'), true);
    assert.equal(ifNoneMatchMatches('"x", "abc" , "y"', '"abc"'), true);
    assert.equal(ifNoneMatchMatches("*", '"abc"'), true);
  });

  it("ignores a weak prefix, so a proxy that weakens the tag still revalidates", () => {
    assert.equal(ifNoneMatchMatches('W/"abc"', '"abc"'), true);
  });

  it("does not match a different or absent tag", () => {
    assert.equal(ifNoneMatchMatches('"other"', '"abc"'), false);
    assert.equal(ifNoneMatchMatches(undefined, '"abc"'), false);
    assert.equal(ifNoneMatchMatches("", '"abc"'), false);
  });
});

describe("conditionalGet", () => {
  it("tags a JSON GET and marks it must-revalidate", async () => {
    const res = await appWith({ a: 1 }).request("/r");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("etag") ?? "", /^"[\w-]{27}"$/);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.deepEqual(await res.json(), { a: 1 });
  });

  it("replies 304 with no body when the client's tag still matches", async () => {
    const app = appWith({ a: 1 });
    const first = await app.request("/r");
    const etag = first.headers.get("etag") ?? "";
    const second = await app.request("/r", { headers: { "if-none-match": etag } });
    assert.equal(second.status, 304);
    assert.equal(second.headers.get("etag"), etag);
    assert.equal(await second.text(), "");
  });

  it("replies 200 again once the payload changes", async () => {
    const firstApp = appWith({ a: 1 });
    const stale = (await firstApp.request("/r")).headers.get("etag") ?? "";
    const changed = await appWith({ a: 2 }).request("/r", {
      headers: { "if-none-match": stale },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), stale);
    assert.deepEqual(await changed.json(), { a: 2 });
  });

  it("gives identical payloads the same tag regardless of request count", async () => {
    const app = appWith({ a: 1, nested: [1, 2, 3] });
    const one = (await app.request("/r")).headers.get("etag");
    const two = (await app.request("/r")).headers.get("etag");
    assert.equal(one, two);
  });

  it("leaves mutations, non-JSON bodies and error responses untagged", async () => {
    assert.equal((await appWith({}).request("/r", { method: "POST" })).headers.get("etag"), null);
    assert.equal((await appWith("plain", { text: true }).request("/r")).headers.get("etag"), null);
    assert.equal(
      (await appWith({ e: 1 }, { status: 500 }).request("/r")).headers.get("etag"),
      null,
    );
  });
});
