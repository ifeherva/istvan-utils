import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHttp, getCacheConfig, invalidateEventsCache } from "../src/scraper.mjs";

describe("standalone cache invalidation", () => {
  it("only requires the website secret and defaults to the canonical URL", () => {
    const config = getCacheConfig({ EVENT_REVALIDATION_SECRET: "test-secret" });
    assert.deepEqual(config, {
      revalidationSecret: "test-secret", siteUrl: "https://www.fencingcalendar.com",
    });
    assert.throws(() => getCacheConfig({}), /EVENT_REVALIDATION_SECRET is required/);
  });

  it("makes only one authenticated cache request, without database or scraping requests", async () => {
    const config = getCacheConfig({
      EVENT_REVALIDATION_SECRET: "test-secret", EVENT_REVALIDATION_SITE_URL: "https://calendar.example",
    });
    const calls = [];
    const request = createHttp({ fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ revalidated: true, tag: "events" });
    } });
    await invalidateEventsCache(config, request);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://calendar.example/api/revalidate/events");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].init.headers, { authorization: "Bearer test-secret" });
  });

  it("reports an invalid token as HTTP 401", async () => {
    const request = createHttp({ fetchImpl: async () => new Response(null, { status: 401 }) });
    await assert.rejects(invalidateEventsCache(getCacheConfig({ EVENT_REVALIDATION_SECRET: "wrong" }), request), {
      message: "Refresh website events cache: HTTP 401",
    });
  });

  it("requires confirmation for the events cache, even after an HTTP success", async () => {
    const config = getCacheConfig({ EVENT_REVALIDATION_SECRET: "test-secret" });
    for (const result of [{}, { revalidated: false, tag: "events" }, { revalidated: true, tag: "canadian-events" }]) {
      await assert.rejects(invalidateEventsCache(config, async () => Response.json(result)),
        /Website did not confirm events cache revalidation/);
    }
  });
});
