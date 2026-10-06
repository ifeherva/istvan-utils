import { setTimeout as sleep } from "node:timers/promises";
import { buildParticipation, canonicalTournamentUrl } from "./participation.mjs";

const PAGE_SIZE = 250;
const TIMEOUT_MS = 30000;

export function integerOption(value, name, fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function httpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url.origin;
}

export function getConfig(env = process.env, { dryRun = false } = {}) {
  const key = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required");
  const revalidationSecret = env.EVENT_REVALIDATION_SECRET?.trim();
  if (!dryRun && !revalidationSecret) {
    throw new Error("EVENT_REVALIDATION_SECRET is required to refresh the website cache after writes");
  }
  const timeZone = env.SCRAPER_TIME_ZONE?.trim() || "America/New_York";
  // Validate before any network requests or writes.
  new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  return {
    supabaseUrl: httpsUrl(env.SUPABASE_URL, "SUPABASE_URL"),
    key,
    revalidationSecret,
    siteUrl: httpsUrl(env.EVENT_REVALIDATION_SITE_URL || "https://fencingcalendar.com", "EVENT_REVALIDATION_SITE_URL"),
    timeZone,
    delayMs: integerOption(env.SCRAPER_DELAY_MS, "SCRAPER_DELAY_MS", 180000),
    limit: integerOption(env.SCRAPER_LIMIT, "SCRAPER_LIMIT", 0),
  };
}

export function calendarDate(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function createHttp({ fetchImpl = fetch, sleepImpl = sleep } = {}) {
  return async function request(url, init, label, { minRetryDelayMs = 0 } = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        if (attempt === 2) throw new Error(`${label}: request failed or timed out`);
        await sleepImpl(Math.max(minRetryDelayMs, 1000 * 2 ** attempt));
        continue;
      }
      if (response.ok) return response;
      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt === 2) {
        await response.body?.cancel();
        // Response bodies can contain credentials or challenge HTML; don't log them.
        throw new Error(`${label}: HTTP ${response.status}`);
      }
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryAfterMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : Date.parse(retryAfterHeader) - Date.now();
      // Never retry before Retry-After, including when the server sends an HTTP date.
      const delay = Math.max(minRetryDelayMs, 1000 * 2 ** attempt,
        Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
      await response.body?.cancel();
      await sleepImpl(delay);
    }
  };
}

function supabaseHeaders(config) {
  const headers = { apikey: config.key, "content-type": "application/json", "accept-profile": "public", "content-profile": "public" };
  // New sb_secret_* keys aren't JWTs. Only legacy JWT keys go in Authorization.
  if (!config.key.startsWith("sb_secret_")) headers.authorization = `Bearer ${config.key}`;
  return headers;
}

async function discoverEvents(config, today, request) {
  const events = [];
  const seen = new Set();
  let offset = 0;
  for (;;) {
    // events is the U.S. catalog. Never query canadian_events or CSV snapshots.
    const params = new URLSearchParams({
      select: "id,tournament,start_date,end_date,registration_url",
      start_date: `gte.${today}`,
      registration_url: "not.is.null",
      order: "start_date.asc,id.asc",
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    const response = await request(`${config.supabaseUrl}/rest/v1/events?${params}`, {
      headers: supabaseHeaders(config),
    }, "Read upcoming U.S. events");
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("Supabase returned an invalid events response");
    if (page.length === 0) break;
    let newRows = 0;
    for (const event of page) {
      if (typeof event.id !== "string") throw new Error("Supabase event is missing an ID");
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      newRows += 1;
      // Recheck the date locally before fetching any tournament page.
      if (typeof event.start_date !== "string" || event.start_date < today) continue;
      const sourceUrl = canonicalTournamentUrl(event.registration_url);
      if (!sourceUrl) continue;
      events.push({ ...event, sourceUrl });
      if (config.limit > 0 && events.length >= config.limit) return events;
    }
    if (newRows === 0) throw new Error("Supabase pagination made no progress");
    // Keep reading even if the API caps pages below PAGE_SIZE.
    offset += page.length;
  }
  return events;
}

export async function runScraper(config, {
  dryRun = false,
  now = new Date(),
  fetchImpl = fetch,
  sleepImpl = sleep,
  log = console.log,
} = {}) {
  const request = createHttp({ fetchImpl, sleepImpl });
  const today = calendarDate(now, config.timeZone);
  const events = await discoverEvents(config, today, request);
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.sourceUrl)) groups.set(event.sourceUrl, []);
    groups.get(event.sourceUrl).push(event);
  }
  const summary = { eligibleEvents: events.length, tournaments: groups.size, updated: 0, wouldUpdate: 0, errors: 0, revalidated: false };
  log(`Found ${events.length} U.S. calendar rows starting ${today} or later (${config.timeZone}); ${groups.size} USA Fencing pages`);
  let processed = 0;
  for (const [sourceUrl, calendarEvents] of groups) {
    if (processed > 0 && config.delayMs > 0) await sleepImpl(config.delayMs);
    processed += 1;
    try {
      const response = await request(sourceUrl, {
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": "FencingCalendarBot/1.0 (+https://fencingcalendar.com)" },
      }, "Fetch USA Fencing tournament", { minRetryDelayMs: config.delayMs });
      const participation = buildParticipation(sourceUrl, await response.text());
      const records = calendarEvents.map((event) => ({
        event_id: event.id,
        source: "usa_fencing",
        source_url: sourceUrl,
        participation,
        last_updated_at: participation.scrapedAt,
      }));
      if (dryRun) {
        summary.wouldUpdate += records.length;
      } else {
        await request(`${config.supabaseUrl}/rest/v1/event_participation?on_conflict=event_id`, {
          method: "POST",
          headers: { ...supabaseHeaders(config), prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(records),
        }, "Upsert participation");
        summary.updated += records.length;
      }
      log(`${dryRun ? "Would update" : "Updated"} ${records.length} calendar row(s) from ${sourceUrl}: ${participation.events.length} event counts`);
    } catch (error) {
      summary.errors += 1;
      log(`Failed ${sourceUrl}: ${error.message}`);
    }
  }
  // Refresh even after a partial success; failed pages never overwrite stored data.
  if (!dryRun && summary.updated > 0) {
    try {
      const response = await request(`${config.siteUrl}/api/revalidate/events`, {
        method: "POST", headers: { authorization: `Bearer ${config.revalidationSecret}` },
      }, "Refresh website events cache");
      const result = await response.json();
      if (result.revalidated !== true || result.tag !== "events") {
        throw new Error("Website did not confirm events cache revalidation");
      }
      summary.revalidated = true;
    } catch (error) {
      summary.errors += 1;
      log(`Cache refresh failed: ${error.message}`);
    }
  }
  log(JSON.stringify(summary));
  return summary;
}
