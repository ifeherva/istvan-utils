// Standalone implementation of the website's event_participation JSON contract.
const BASE_URL = "https://member.usafencing.org";
const ENTITIES = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"', rsquo: "'" };
const clean = (value) => value.replace(/\s+/g, " ").trim();
const stripTags = (value) => value.replace(/<[^>]+>/g, " ");

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity) => {
    const lower = entity.toLowerCase();
    if (!lower.startsWith("#")) return ENTITIES[lower] ?? full;
    const code = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : full;
  });
}

export function canonicalTournamentUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), BASE_URL);
    const match = url.pathname.match(/^\/details\/tournaments\/(\d+)\/?$/i);
    if (!match || !["https:", "http:"].includes(url.protocol) ||
        url.hostname.toLowerCase() !== "member.usafencing.org" ||
        url.username || url.password || url.port) return null;
    return `${BASE_URL}/details/tournaments/${match[1]}`;
  } catch {
    return null;
  }
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2];
}

function hasClass(tag, name) {
  return (attribute(tag, "class") ?? "").split(/\s+/).includes(name);
}

function eventBlocks(html) {
  const blocks = [];
  // Stop at the matching closing div so footer counts cannot leak into the last card.
  const divs = /<\/?div\b[^>]*>/gi;
  let match;
  let start = null;
  let depth = 0;
  let eventId;
  while ((match = divs.exec(html))) {
    const closing = /^<\//.test(match[0]);
    if (start === null) {
      if (!closing && hasClass(match[0], "contested-event")) {
        eventId = attribute(match[0], "data-event_id");
        if (!eventId) throw new Error("USA Fencing event card has no event ID");
        start = match.index;
        depth = 1;
      }
    } else {
      depth += closing ? -1 : 1;
      if (depth === 0) {
        blocks.push({ eventId, block: html.slice(start, divs.lastIndex) });
        start = null;
      }
    }
  }
  if (start !== null) throw new Error("USA Fencing returned an incomplete event card");
  return blocks;
}

function spanText(block, className) {
  for (const match of block.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
    if (hasClass(match[0].slice(0, match[0].indexOf(">") + 1), className)) {
      return clean(decodeEntities(stripTags(match[1])));
    }
  }
  return null;
}

function numberBeforeLabel(block, label) {
  const text = clean(decodeEntities(stripTags(block)));
  const value = text.match(new RegExp(`([\\d,]+)\\s+${label}\\b`, "i"))?.[1];
  return value === undefined ? null : Number.parseInt(value.replace(/,/g, ""), 10);
}

export function buildParticipation(sourceUrl, html, scrapedAt = new Date().toISOString()) {
  const canonicalUrl = canonicalTournamentUrl(sourceUrl);
  if (!canonicalUrl) throw new Error("Invalid USA Fencing tournament URL");
  const blocks = eventBlocks(html);
  if (blocks.length === 0) throw new Error("No USA Fencing event cards found; retaining stored counts");
  const events = blocks.map(({ block, eventId }) => {
    // Match the name span directly; an enclosing short-code span may contain it.
    const nameMatch = block.match(/<span\b[^>]*\bclass\s*=\s*(["'])[^"']*\bname\b[^"']*\1[^>]*>([\s\S]*?)<\/span>/i);
    const displayName = clean(decodeEntities(stripTags(nameMatch?.[2] ?? "")));
    const code = displayName.match(/\(([A-Z0-9]{4,8})\)\s*$/)?.[1];
    if (!code) throw new Error("Unrecognized USA Fencing event name; retaining stored counts");
    const entrantText = spanText(block, "entrant-count");
    const entrantCount = entrantText && /^[\d,]+$/.test(entrantText)
      ? Number.parseInt(entrantText.replace(/,/g, ""), 10) : null;
    const registered = numberBeforeLabel(block, "Official\\s+(?:Competitors|Entries)") ?? entrantCount;
    const openSpots = numberBeforeLabel(block, "Open\\s+Spots");
    return {
      code,
      name: clean(displayName.replace(/\s*\([A-Z0-9]{4,8}\)\s*$/, "")),
      usaFencingEventId: eventId,
      registered,
      openSpots,
      capacity: registered === null || openSpots === null ? null : registered + openSpots,
      registrationCap: /registration\s+cap/i.test(stripTags(block)),
      isFull: /\bevent-is-full\b/i.test(block) || openSpots === 0,
    };
  });
  if (!events.some((event) => event.registered !== null || event.openSpots !== null)) {
    throw new Error("No participation counts found; retaining stored counts");
  }
  if (new Set(events.map((event) => event.usaFencingEventId)).size !== events.length) {
    throw new Error("Duplicate USA Fencing event IDs; retaining stored counts");
  }
  return { source: "usa_fencing", sourceUrl: canonicalUrl, scrapedAt, events };
}
