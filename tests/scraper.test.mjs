import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildParticipation, canonicalTournamentUrl } from "../src/participation.mjs";
import { calendarDate, createHttp, getConfig, runScraper } from "../src/scraper.mjs";

const SOURCE = "https://member.usafencing.org/details/tournaments/12312";
const NOW = new Date("2026-10-06T19:00:00Z");
const CONFIG = getConfig({
  SUPABASE_URL: "https://database.example",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  EVENT_REVALIDATION_SECRET: "test-revalidation-secret",
  EVENT_REVALIDATION_SITE_URL: "https://calendar.example",
  SCRAPER_DELAY_MS: "0",
});
const HTML = `
  <div class="card contested-event" data-event_id="72959">
    <span class="short-code"><span><span class="name">Junior Men&rsquo;s Foil (JNRMF)</span></span></span>
    <div>This event has a registration cap in place.</div>
    <a><span class="entrant-count mono">28</span></a>
    <div><div><strong>28</strong> Official Competitors</div><div><strong>84</strong> Open Spots</div></div>
  </div>
  <div data-event_id='72940' class='card contested-event event-is-full'>
    <span class='name'>Youth 14 Women’s Saber (Y14WS)</span>
    <div><strong>91</strong> Official Entries</div>
    <div><strong>0</strong> Open Spots</div>
  </div>`;

const event = (id, changes = {}) => ({
  id, tournament: `Tournament ${id}`, start_date: "2026-10-09", end_date: "2026-10-12",
  registration_url: SOURCE, ...changes,
});
const json = (value) => Response.json(value);

function mockApi(pages, html = HTML) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === "/rest/v1/events") return json(pages.shift() ?? []);
    if (url.hostname === "member.usafencing.org") return new Response(html);
    if (url.pathname === "/rest/v1/event_participation") return new Response(null, { status: 201 });
    if (url.pathname === "/api/revalidate/events") return json({ revalidated: true, tag: "events" });
    throw new Error(`Unexpected URL ${url}`);
  };
  return { calls, fetchImpl };
}
const options = (api, extra = {}) => ({
  now: NOW, fetchImpl: api.fetchImpl, sleepImpl: async () => {}, log: () => {}, ...extra,
});

describe("participation payload", () => {
  it("matches the website contract, including zero spots and capacity", () => {
    assert.deepEqual(buildParticipation(`${SOURCE}?tracking=1`, HTML, NOW.toISOString()), {
      source: "usa_fencing", sourceUrl: SOURCE, scrapedAt: NOW.toISOString(), events: [
        { code: "JNRMF", name: "Junior Men's Foil", usaFencingEventId: "72959", registered: 28,
          openSpots: 84, capacity: 112, registrationCap: true, isFull: false },
        { code: "Y14WS", name: "Youth 14 Women’s Saber", usaFencingEventId: "72940", registered: 91,
          openSpots: 0, capacity: 91, registrationCap: false, isFull: true },
      ],
    });
  });

  it("keeps missing spots null and ignores numbers outside the event card", () => {
    const html = `<div data-event_id="1" class="contested-event">
      <span class="name">Division IA Men’s Saber (D1AMS)</span>
      <span class="entrant-count mono">1,234</span>
    </div><footer><strong>99</strong> Open Spots</footer>`;
    const [entry] = buildParticipation(SOURCE, html).events;
    assert.equal(entry.registered, 1234);
    assert.equal(entry.openSpots, null);
    assert.equal(entry.capacity, null);
  });

  it("rejects empty pages, incomplete cards, and partial parsing", () => {
    for (const html of ["<h1>Access denied</h1>", HTML.slice(0, -6),
      HTML.replace("(JNRMF)", "unexpected name"),
      `<div class="contested-event" data-event_id="1"><span class="name">Foil (JNRMF)</span></div>`]) {
      assert.throws(() => buildParticipation(SOURCE, html));
    }
  });

  it("restricts tournament URLs to the USA Fencing host and path", () => {
    assert.equal(canonicalTournamentUrl("/details/tournaments/12312/"), SOURCE);
    for (const url of [null, "", "https://askfred.net/tournaments/12312",
      "https://member.usafencing.org.evil.example/details/tournaments/12312",
      "https://member.usafencing.org/details/tournaments/abc", "file:///details/tournaments/12312",
      "https://user:pass@member.usafencing.org/details/tournaments/12312",
      "https://member.usafencing.org:1234/details/tournaments/12312"]) {
      assert.equal(canonicalTournamentUrl(url), null);
    }
  });
});

describe("catalog discovery and updates", () => {
  it("queries only U.S. events, excludes past starts, and paginates short pages", async () => {
    const api = mockApi([
      [event("past", { start_date: "2026-10-05", end_date: "2026-10-08" }),
        event("askfred", { registration_url: "https://askfred.net/tournaments/1" })],
      [event("today", { start_date: "2026-10-06" })], [event("future")], [],
    ]);
    const summary = await runScraper(CONFIG, options(api));
    assert.equal(summary.eligibleEvents, 2);
    assert.equal(summary.updated, 2);
    assert.equal(summary.tournaments, 1);
    const reads = api.calls.filter((call) => call.url.pathname === "/rest/v1/events");
    assert.deepEqual(reads.map((call) => call.url.searchParams.get("offset")), ["0", "2", "3", "4"]);
    for (const call of reads) {
      assert.equal(call.url.searchParams.get("start_date"), "gte.2026-10-06");
      assert.equal(call.init.headers.apikey, CONFIG.key);
      assert.equal(call.init.headers.authorization, undefined);
    }
    assert.equal(api.calls.filter((call) => call.url.hostname === "member.usafencing.org").length, 1);
    assert.equal(api.calls.some((call) => call.url.pathname.includes("canadian")), false);
    const write = api.calls.find((call) => call.init.method === "POST" && call.url.pathname.includes("event_participation"));
    assert.equal(write.url.searchParams.get("on_conflict"), "event_id");
    assert.equal(write.init.headers.prefer, "resolution=merge-duplicates,return=minimal");
    assert.deepEqual(JSON.parse(write.init.body).map((record) => record.event_id), ["today", "future"]);
    const refresh = api.calls.at(-1);
    assert.equal(refresh.url.pathname, "/api/revalidate/events");
    assert.equal(refresh.init.headers.authorization, `Bearer ${CONFIG.revalidationSecret}`);
    assert.equal(refresh.init.headers.apikey, undefined);
    assert.equal(summary.revalidated, true);
  });

  it("applies the limit after URL filtering and dry runs never write or revalidate", async () => {
    const api = mockApi([[event("other", { registration_url: "https://askfred.net/tournaments/1" }),
      event("valid"), event("beyond-limit")]]);
    const summary = await runScraper({ ...CONFIG, limit: 1 }, options(api, { dryRun: true }));
    assert.equal(summary.eligibleEvents, 1);
    assert.equal(summary.wouldUpdate, 1);
    assert.equal(summary.updated, 0);
    assert.equal(api.calls.some((call) => call.init.method === "POST"), false);
  });

  it("waits the configured delay between tournament pages, including after a failed page", async () => {
    const api = mockApi([[event("first"),
      event("second", { registration_url: SOURCE.replace("12312", "999") })], []]);
    const original = api.fetchImpl;
    const sequence = [];
    api.fetchImpl = async (url, init) => {
      if (new URL(url).hostname === "member.usafencing.org") {
        sequence.push(String(url));
        if (String(url) === SOURCE) return new Response("denied", { status: 403 });
      }
      return original(url, init);
    };
    await runScraper({ ...CONFIG, delayMs: 180000 }, options(api, {
      dryRun: true, sleepImpl: async (ms) => { sequence.push(ms); },
    }));
    assert.deepEqual(sequence, [SOURCE, 180000, SOURCE.replace("12312", "999")]);
  });

  it("preserves stored counts for a failed page and refreshes partial successes", async () => {
    const api = mockApi([[event("first"), event("second", { registration_url: SOURCE.replace("12312", "999") })], []]);
    const original = api.fetchImpl;
    api.fetchImpl = async (url, init) => String(url).endsWith("/999")
      ? new Response("blocked", { status: 403 }) : original(url, init);
    const summary = await runScraper(CONFIG, options(api));
    assert.equal(summary.updated, 1);
    assert.equal(summary.errors, 1);
    assert.equal(summary.revalidated, true);
    assert.equal(api.calls.filter((call) => call.url.pathname === "/rest/v1/event_participation").length, 1);
  });

  it("doesn't replace existing data with an empty or challenge page", async () => {
    const api = mockApi([[event("valid")], []], "<h1>Please sign in</h1>");
    const summary = await runScraper(CONFIG, options(api));
    assert.equal(summary.errors, 1);
    assert.equal(summary.updated, 0);
    assert.equal(api.calls.some((call) => call.init.method === "POST"), false);
  });

  it("reports failed database writes and doesn't claim success or refresh", async () => {
    const api = mockApi([[event("valid")], []]);
    const original = api.fetchImpl;
    api.fetchImpl = async (url, init) => String(url).includes("event_participation")
      ? new Response("denied", { status: 401 }) : original(url, init);
    const summary = await runScraper(CONFIG, options(api));
    assert.equal(summary.errors, 1);
    assert.equal(summary.updated, 0);
    assert.equal(summary.revalidated, false);
  });

  it("marks cache refresh failures as errors", async () => {
    const api = mockApi([[event("valid")], []]);
    const original = api.fetchImpl;
    api.fetchImpl = async (url, init) => String(url).includes("revalidate")
      ? new Response("denied", { status: 401 }) : original(url, init);
    const summary = await runScraper(CONFIG, options(api));
    assert.equal(summary.updated, 1);
    assert.equal(summary.errors, 1);
    assert.equal(summary.revalidated, false);
  });

  it("handles an empty catalog without fetching or refreshing", async () => {
    const api = mockApi([[]]);
    const summary = await runScraper(CONFIG, options(api));
    assert.equal(summary.errors, 0);
    assert.equal(api.calls.length, 1);
  });
});

describe("configuration and HTTP", () => {
  it("uses the configured calendar timezone at a midnight boundary", () => {
    const now = new Date("2026-10-07T02:00:00Z");
    assert.equal(calendarDate(now, "America/New_York"), "2026-10-06");
    assert.equal(calendarDate(now, "UTC"), "2026-10-07");
  });

  it("requires server credentials and revalidation, with a read-only dry-run exception", () => {
    assert.throws(() => getConfig({}), /SUPABASE_SECRET_KEY/);
    const env = { SUPABASE_URL: CONFIG.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: "legacy-test-key" };
    assert.throws(() => getConfig(env), /EVENT_REVALIDATION_SECRET/);
    assert.equal(getConfig(env, { dryRun: true }).key, "legacy-test-key");
    assert.equal(getConfig(env, { dryRun: true }).siteUrl, "https://www.fencingcalendar.com");
    assert.equal(getConfig(env, { dryRun: true }).delayMs, 180000);
    assert.equal(getConfig({ ...env, SCRAPER_DELAY_MS: "240000" }, { dryRun: true }).delayMs, 240000);
    assert.equal(getConfig({ ...env, SCRAPER_DELAY_MS: "0" }, { dryRun: true }).delayMs, 0);
    assert.throws(() => getConfig({ ...env, SCRAPER_LIMIT: "1garbage" }, { dryRun: true }), /non-negative integer/);
    assert.throws(() => getConfig({ ...env, SCRAPER_TIME_ZONE: "invalid" }, { dryRun: true }));
  });

  it("honors Retry-After on rate limits, with retry backoff and timeout", async () => {
    const responses = [new Response("rate limited", { status: 429, headers: { "retry-after": "3600" } }),
      new Response("unavailable", { status: 503 }), new Response("ok")];
    const delays = [];
    const request = createHttp({ fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal instanceof AbortSignal);
      return responses.shift();
    }, sleepImpl: async (ms) => { delays.push(ms); } });
    assert.equal(await (await request(SOURCE, {}, "Test")).text(), "ok");
    assert.deepEqual(delays, [3600000, 2000]);
  });

  it("waits at least the configured USA Fencing delay for every retry", async () => {
    const api = mockApi([[event("valid")], []]);
    const original = api.fetchImpl;
    const delays = [];
    let attempts = 0;
    api.fetchImpl = async (url, init) => {
      if (String(url) === SOURCE) {
        attempts += 1;
        if (attempts === 1) throw new Error("network failure");
        if (attempts === 2) return new Response("unavailable", { status: 503 });
      }
      return original(url, init);
    };
    const summary = await runScraper({ ...CONFIG, delayMs: 180000 }, options(api, {
      dryRun: true, sleepImpl: async (ms) => { delays.push(ms); },
    }));
    assert.equal(summary.errors, 0);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [180000, 180000]);
  });

  it("doesn't retry permanent denials or print response bodies", async () => {
    let attempts = 0;
    const request = createHttp({ fetchImpl: async () => {
      attempts += 1;
      return new Response("sensitive payload", { status: 403 });
    } });
    await assert.rejects(request(SOURCE, {}, "Test"), { message: "Test: HTTP 403" });
    assert.equal(attempts, 1);
  });

  it("reports redirects explicitly without retrying or forwarding credentials", async () => {
    let attempts = 0;
    const request = createHttp({ fetchImpl: async (_url, init) => {
      attempts += 1;
      assert.equal(init.redirect, "manual");
      return new Response(null, { status: 308,
        headers: { location: "https://www.fencingcalendar.com/api/revalidate/events" } });
    } });
    await assert.rejects(request("https://fencingcalendar.com/api/revalidate/events", {
      method: "POST", headers: { authorization: "Bearer test-secret" },
    }, "Refresh website events cache"), {
      message: "Refresh website events cache: HTTP 308 redirect; configure the final destination URL",
    });
    assert.equal(attempts, 1);
  });
});
