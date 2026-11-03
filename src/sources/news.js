import { fetchRssItems } from "../lib/rss.js";

// Google News RSS search — free, keyless, no rate-limit key required.
// Title format is "<headline> - <source>"; we split that back apart so the
// UI can show the outlet name separately, matching the target data shape.
export async function getNewsForCompany(query, limit) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const items = await fetchRssItems(url);
  return items.slice(0, limit).map(parseItem);
}

function parseItem(item) {
  const rawTitle = String(item.title ?? "").trim();
  const sepIndex = rawTitle.lastIndexOf(" - ");
  const headline = sepIndex === -1 ? rawTitle : rawTitle.slice(0, sepIndex);
  const source = sepIndex === -1 ? "Google News" : rawTitle.slice(sepIndex + 3);
  const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
  return { headline, source, publishedAt: pubDate };
}

// Historical variant for the backfill: Google News' after:/before: search
// operators, then a hard filter on pubDate, because the operators are fuzzy
// at the edges (they return items from the `before` day itself). Google
// dates these items to the day, so `beforeMs` should be a UTC midnight.
// Newest first, like the live feed.
export async function getNewsForCompanyBetween(query, limit, afterMs, beforeMs) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const q = `${query} after:${day(afterMs)} before:${day(beforeMs)}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const items = (await fetchRssItems(url)).map(parseItem);
  return items
    .filter((a) => a.publishedAt.getTime() >= afterMs && a.publishedAt.getTime() < beforeMs)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit);
}
