// Backfill: replay the pipeline on past dates, so the backtest has history.
//
//   npm run backfill                          # weekly, 2026-04-01 → last week
//   npm run backfill -- --from 2026-05-01 --to 2026-06-30
//   npm run backfill -- --tickers AAPL,BTC --from 2026-10-01   # quick test
//
// For each date D (a Monday by default; the next trading day if the market
// was shut) it rebuilds what the pipeline would have seen, using only sources
// that can be queried "as of" a date:
//   - Google News headlines published in the 7 days before D (UTC day)
//   - SEC EDGAR filings filed in the 14 days before D
// judges them with the configured engine, and saves the run to
// data/history/backfill-<D>.json, marked `backfill: true`. Seeking Alpha,
// Reddit and the crowd signal have no history, so backfilled runs lack them.
//
// Timing, so nothing leaks from the future: news stops at the end of D−1,
// the run is stamped D 19:30 UTC (half an hour before the US close in
// daylight time), and the entry price is D's close for stocks and the
// CoinGecko point at the next UTC midnight for crypto — always after the news.
//
// Resumable: dates that already have a file are skipped, so you can stop it
// (Ctrl+C) and run it again. Requires JUDGE_ENGINE=jevk5 (local, free); a
// hosted engine would burn quota, so that needs --allow-hosted.
import { mkdir, writeFile, rename, access } from "node:fs/promises";
import { join } from "node:path";
import { TICKERS, MAX_NEWS_PER_TICKER, MAX_ARTICLES_PER_TICKER } from "../src/config.js";
import { HISTORY_DIR } from "../src/cache.js";
import { getNewsForCompanyBetween } from "../src/sources/news.js";
import { getRecentFilings } from "../src/sources/secFilings.js";
import { judgeArticle, ENGINE_LABEL } from "../src/judge.js";
import { buildTickerRecord } from "../src/aggregate.js";
import { fetchJson, fetchJsonRetry429, sleep } from "../src/lib/httpJson.js";

const DAY = 86_400_000;
const NEWS_WINDOW_DAYS = 7;
const NEWS_SPACING_MS = Number(process.env.BACKFILL_NEWS_SPACING_MS) || 1_500;
const COIN_SPACING_MS = Number(process.env.CROWD_COIN_SPACING_MS) || 10_000;

// ---------- args ----------

function parseArgs(argv) {
  const out = { from: "2026-04-01", to: null, every: 7, tickers: null, allowHosted: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--from") out.from = next();
    else if (a === "--to") out.to = next();
    else if (a === "--every") out.every = { day: 1, week: 7 }[next()] ?? NaN;
    else if (a === "--tickers") out.tickers = next().split(",").map((s) => s.trim().toUpperCase());
    else if (a === "--allow-hosted") out.allowHosted = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!Number.isFinite(out.every)) throw new Error("--every must be 'day' or 'week'");
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  out.to ??= yesterday;
  if (out.to > yesterday) out.to = yesterday;
  return out;
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d) => Date.parse(d + "T00:00:00Z");

// ---------- prices ----------

// Yahoo daily bars keyed by trading date (New York): { date: close }.
async function stockCloses(symbol, fromMs) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  const data = await fetchJson(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const r = data?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const out = new Map();
  for (let i = 0; i < ts.length; i++) {
    // Bars are stamped at the 9:30 ET open, which is the same UTC date.
    if (Number.isFinite(closes[i])) out.set(iso(ts[i] * 1000), closes[i]);
  }
  return out;
}

// CoinGecko daily points (00:00 UTC for ranges over 90 days): { date: price }.
async function coinDaily(id, fromMs) {
  const days = Math.min(365, Math.ceil((Date.now() - fromMs) / DAY) + 1);
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const data = await fetchJsonRetry429(url);
  const out = new Map();
  for (const [t, p] of data?.prices ?? []) out.set(iso(t), p);
  return out;
}

function prevKey(map, date) {
  let best = null;
  for (const k of map.keys()) if (k < date && (!best || k > best)) best = k;
  return best;
}

// ---------- sources as of a date ----------

async function newsWithRetry(query, afterMs, beforeMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getNewsForCompanyBetween(query, MAX_NEWS_PER_TICKER, afterMs, beforeMs);
    } catch (err) {
      if (attempt >= 2 || ![429, 503].includes(err.status)) throw err;
      console.warn(`[backfill] Google News ${err.status}; waiting ${60 * (attempt + 1)}s`);
      await sleep(60_000 * (attempt + 1));
    }
  }
}

const secCache = new Map();

async function articlesAsOf(t, dateD, sinceMs) {
  const before = dayMs(dateD);
  const after = before - NEWS_WINDOW_DAYS * DAY;
  const query = t.a === "crypto" ? `${t.n} ${t.s} crypto` : `${t.n} stock`;
  const tasks = [newsWithRetry(query, after, before)];
  if (t.a === "stock") tasks.push(getRecentFilings(t.s, { asOfMs: before, cache: secCache, sinceMs }));
  const results = await Promise.allSettled(tasks);
  const out = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") out.push(...r.value);
    else console.warn(`[backfill] ${i === 0 ? "news" : "SEC"}/${t.s} on ${dateD} skipped: ${r.reason.message}`);
  });
  return out.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_ARTICLES_PER_TICKER);
}

function ageAt(publishedAt, atMs) {
  const hours = Math.round((atMs - publishedAt.getTime()) / 3_600_000);
  if (hours < 1) return "just now";
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

// ---------- main ----------

const args = parseArgs(process.argv.slice(2));
if (!ENGINE_LABEL.startsWith("JevK5") && !args.allowHosted) {
  console.error(`[backfill] The judge engine is ${ENGINE_LABEL}, which is hosted and metered. Set JUDGE_ENGINE=jevk5 in .env (local, free), or pass --allow-hosted to use it anyway.`);
  process.exit(1);
}
const tickers = args.tickers ? TICKERS.filter((t) => args.tickers.includes(t.s)) : TICKERS;
if (tickers.length === 0) {
  console.error("[backfill] None of --tickers are in the ticker list (src/config.js).");
  process.exit(1);
}

// Fail fast if the judge isn't reachable (e.g. llama-server not started).
try {
  await judgeArticle({ ticker: "AAPL", company: "Apple Inc.", headline: "Apple reports quarterly results", source: "Reuters" });
} catch (err) {
  console.error(`[backfill] The ${ENGINE_LABEL} judge isn't answering: ${err.message}`);
  console.error("[backfill] Start llama-server first (see the README's \"Local engine: JevK5\").");
  process.exit(1);
}

const fromMs = dayMs(args.from);
const priceFrom = fromMs - 10 * DAY;

// Trading calendar from SPY, then each target date → the first trading day on or after it.
const spy = await stockCloses("SPY", priceFrom);
const tradingDays = [...spy.keys()].sort();
const firstMonday = (() => {
  const d = new Date(fromMs);
  const shift = args.every === 7 ? (8 - d.getUTCDay()) % 7 : 0;
  return fromMs + shift * DAY;
})();
const dates = [];
for (let t = firstMonday; iso(t) <= args.to; t += args.every * DAY) {
  const d = tradingDays.find((x) => x >= iso(t));
  if (d && d <= args.to && !dates.includes(d)) dates.push(d);
}
const fileFor = (d) => join(HISTORY_DIR, `backfill-${d}.json`);
const exists = (p) => access(p).then(() => true, () => false);
const todo = [];
for (const d of dates) if (!(await exists(fileFor(d)))) todo.push(d);

console.log(`[backfill] Engine: ${ENGINE_LABEL}. ${tickers.length} tickers, ${dates.length} dates ${dates[0] ?? "—"} → ${dates.at(-1) ?? "—"}; ${dates.length - todo.length} already done, ${todo.length} to go.`);
if (todo.length === 0) process.exit(0);

console.log("[backfill] Loading price history…");
const prices = new Map();
for (const t of tickers.filter((x) => x.a === "stock")) {
  try {
    prices.set(t.s, await stockCloses(t.s, priceFrom));
  } catch (err) {
    console.warn(`[backfill] No price history for ${t.s}: ${err.message}`);
  }
  await sleep(250);
}
for (const t of tickers.filter((x) => x.a === "crypto")) {
  try {
    prices.set(t.s, await coinDaily(t.coingeckoId, priceFrom));
  } catch (err) {
    console.warn(`[backfill] No price history for ${t.s}: ${err.message}`);
  }
  await sleep(COIN_SPACING_MS);
}

await mkdir(HISTORY_DIR, { recursive: true });
for (const [n, d] of todo.entries()) {
  const started = Date.now();
  const generatedAt = new Date(dayMs(d) + 19.5 * 3_600_000).toISOString();
  const atMs = Date.parse(generatedAt);
  const judgeMs = [];
  const records = [];

  for (const t of tickers) {
    const px = prices.get(t.s);
    // Entry: D's close (stocks) or the next UTC midnight (crypto); change vs the bar before.
    const entryKey = t.a === "stock" ? d : iso(dayMs(d) + DAY);
    const price = px?.get(entryKey);
    const prev = px && prevKey(px, entryKey);
    if (!Number.isFinite(price)) {
      console.warn(`[backfill] ${t.s}: no price for ${entryKey}; skipped on ${d}.`);
      continue;
    }
    const articles = await articlesAsOf(t, d, fromMs - 20 * DAY);
    for (const a of articles) {
      const s = performance.now();
      try {
        a.jevJudgment = await judgeArticle({ ticker: t.s, company: t.n, headline: a.headline, source: a.source });
        judgeMs.push(performance.now() - s);
      } catch (err) {
        console.warn(`[backfill] Judgment failed for ${t.s} "${a.headline}": ${err.message}`);
      }
    }
    const quote = { price, changePct: prev ? (price / px.get(prev) - 1) * 100 : null, name: t.n };
    const rec = buildTickerRecord(t, quote, articles, { openaiEnabled: false, jevLabel: ENGINE_LABEL });
    rec.src = articles.map((a) => ({ so: a.source, h: a.headline, t: ageAt(a.publishedAt, atMs), jevTag: a.jevJudgment?.sentiment ?? null, openaiTag: null }));
    records.push(rec);
    await sleep(NEWS_SPACING_MS);
  }

  const sorted = [...judgeMs].sort((a, b) => a - b);
  const payload = {
    generatedAt,
    backfill: true,
    asOf: d,
    backfillSources: ["Google News (7 days before)", "SEC EDGAR (14 days before)"],
    openaiEnabled: false,
    jevEngine: ENGINE_LABEL,
    timings: {
      jev: sorted.length
        ? { calls: sorted.length, meanMs: Math.round(sorted.reduce((s, x) => s + x, 0) / sorted.length), medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]), p95Ms: Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]), totalMs: Math.round(sorted.reduce((s, x) => s + x, 0)) }
        : null,
      openai: null,
    },
    tickers: records,
  };
  const path = fileFor(d);
  await writeFile(path + ".tmp", JSON.stringify(payload));
  await rename(path + ".tmp", path);
  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  const left = todo.length - n - 1;
  console.log(`[backfill] ${d} (${n + 1}/${todo.length}): ${records.length} tickers, ${judgeMs.length} judgments, ${mins} min. ` +
    (left ? `~${Math.round((left * (Date.now() - started)) / 60_000)} min left.` : "Done."));
}
console.log("[backfill] Finished. Run `npm run backtest` (or Refresh returns on the Performance page) to score the new runs.");
