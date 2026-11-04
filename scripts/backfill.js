// Backfill: replay the pipeline on past dates, so the backtest has history.
//
//   npm run backfill                 # weekly, 2026-04-01 → yesterday
//   npm run backfill -- --status     # what's done, what's left
// In PowerShell, call node directly (npm's shim drops flags after --):
//   node --env-file-if-exists=.env scripts/backfill.js --from 2026-05-01 --to 2026-06-30
//   node --env-file-if-exists=.env scripts/backfill.js --tickers AAPL,BTC --concurrency 2
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
// Stop it any time (Ctrl+C, closing the window, a crash, a reboot) and run
// it again to continue. Every fetched source list and every judgment is
// appended to data/backfill-cache/ the moment it exists, so a restart redoes
// nothing; finished dates are skipped. A run file is only written once every
// one of its judgments succeeded. If the judge stops answering (e.g.
// llama-server crashed), the backfill waits for it, then exits cleanly
// rather than saving incomplete runs.
//
// Speed: news for upcoming tickers is fetched while earlier ones are being
// judged, and up to --concurrency (default 4) judgments run at once. Start
// llama-server with at least that many slots (-np 4); see the README.
import { mkdir, writeFile, rename, readFile, readdir } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TICKERS, MAX_NEWS_PER_TICKER, MAX_ARTICLES_PER_TICKER, JEVK5_URL, JEVK5_TEMPERATURE } from "../src/config.js";
import { HISTORY_DIR } from "../src/cache.js";
import { getNewsForCompanyBetween } from "../src/sources/news.js";
import { getRecentFilings } from "../src/sources/secFilings.js";
import { judgeArticle, ENGINE_LABEL } from "../src/judge.js";
import { buildTickerRecord } from "../src/aggregate.js";
import { fetchJson, fetchJsonRetry429, sleep } from "../src/lib/httpJson.js";

const DAY = 86_400_000;
const NEWS_WINDOW_DAYS = 7;
const NEWS_SPACING_MS = Number(process.env.BACKFILL_NEWS_SPACING_MS) || 1_000;
const COIN_SPACING_MS = Number(process.env.CROWD_COIN_SPACING_MS) || 10_000;
const PRICE_CACHE_MAX_AGE_MS = 12 * 3_600_000;
// How long to wait for a judge that stopped answering before giving up.
const JUDGE_OUTAGE_MS = 3 * 60_000;
const CACHE_DIR = fileURLToPath(new URL("../data/backfill-cache/", import.meta.url));

// ---------- args ----------

function parseArgs(argv) {
  const out = { from: "2026-04-01", to: null, every: 7, tickers: null, allowHosted: false, concurrency: 4, status: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--from") out.from = next();
    else if (a === "--to") out.to = next();
    else if (a === "--every") out.every = { day: 1, week: 7 }[next()] ?? NaN;
    else if (a === "--tickers") out.tickers = next().split(",").map((s) => s.trim().toUpperCase());
    else if (a === "--concurrency") out.concurrency = Math.max(1, Number(next()) || 1);
    else if (a === "--allow-hosted") out.allowHosted = true;
    else if (a === "--status") out.status = true;
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
const fileFor = (d) => join(HISTORY_DIR, `backfill-${d}.json`);

// ---------- durable caches (append-only JSONL: a crash loses at most one line) ----------

function loadJsonl(name) {
  const map = new Map();
  const path = join(CACHE_DIR, name);
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const { k, v } = JSON.parse(line);
      map.set(k, v);
    } catch {
      // A line cut off by a hard stop; the item is simply redone.
    }
  }
  return map;
}
function appendJsonl(name, k, v) {
  appendFileSync(join(CACHE_DIR, name), JSON.stringify({ k, v }) + "\n");
}

// ---------- prices (cached to disk for 12h so restarts are quick) ----------

async function stockCloses(symbol, fromMs) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  const data = await fetchJson(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const r = data?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const out = {};
  // Bars are stamped at the 9:30 ET open, which is the same UTC date.
  for (let i = 0; i < ts.length; i++) if (Number.isFinite(closes[i])) out[iso(ts[i] * 1000)] = closes[i];
  return out;
}

async function coinDaily(id, fromMs) {
  const days = Math.min(365, Math.ceil((Date.now() - fromMs) / DAY) + 1);
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const data = await fetchJsonRetry429(url);
  const out = {};
  for (const [t, p] of data?.prices ?? []) out[iso(t)] = p;
  return out;
}

async function loadPrices(tickers, fromMs) {
  const path = join(CACHE_DIR, "prices.json");
  let cache = { fetchedAt: 0, fromMs: Infinity, series: {} };
  try {
    cache = JSON.parse(await readFile(path, "utf8"));
  } catch {}
  const fresh = Date.now() - cache.fetchedAt < PRICE_CACHE_MAX_AGE_MS && cache.fromMs <= fromMs;
  const missing = tickers.filter((t) => !fresh || !cache.series[t.s]);
  if (missing.length === 0) {
    console.log("[backfill] Using cached price history.");
    return cache.series;
  }
  if (!fresh) cache = { fetchedAt: Date.now(), fromMs, series: {} };
  console.log(`[backfill] Loading price history for ${missing.length} tickers…`);
  for (const t of missing) {
    try {
      cache.series[t.s] = t.a === "stock" ? await stockCloses(t.s, fromMs) : await coinDaily(t.coingeckoId, fromMs);
    } catch (err) {
      console.warn(`[backfill] No price history for ${t.s}: ${err.message}`);
    }
    await sleep(t.a === "stock" ? 250 : COIN_SPACING_MS);
  }
  await writeFile(path, JSON.stringify(cache));
  return cache.series;
}

function prevKey(series, date) {
  let best = null;
  for (const k of Object.keys(series)) if (k < date && (!best || k > best)) best = k;
  return best;
}

// ---------- sources as of a date (cached per ticker+date) ----------

async function newsWithRetry(query, afterMs, beforeMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getNewsForCompanyBetween(query, MAX_NEWS_PER_TICKER, afterMs, beforeMs);
    } catch (err) {
      if (attempt >= 3) throw err;
      const wait = [429, 503].includes(err.status) ? 60_000 * (attempt + 1) : 5_000 * (attempt + 1);
      console.warn(`[backfill] Google News: ${err.message}; retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

const secCache = new Map();

// Returns { articles, fetched } — `fetched` is false on a cache hit, so the
// caller only pauses between real network requests.
async function sourcesAsOf(t, dateD, sinceMs, sourceCache) {
  const key = `${t.s}|${dateD}`;
  if (sourceCache.has(key)) {
    return { articles: sourceCache.get(key).map((a) => ({ ...a, publishedAt: new Date(a.publishedAt) })), fetched: false };
  }
  const before = dayMs(dateD);
  const after = before - NEWS_WINDOW_DAYS * DAY;
  const query = t.a === "crypto" ? `${t.n} ${t.s} crypto` : `${t.n} stock`;
  const tasks = [newsWithRetry(query, after, before)];
  if (t.a === "stock") tasks.push(getRecentFilings(t.s, { asOfMs: before, cache: secCache, sinceMs }));
  const results = await Promise.allSettled(tasks);
  const articles = [];
  let complete = true;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") articles.push(...r.value);
    else {
      complete = false;
      console.warn(`[backfill] ${i === 0 ? "news" : "SEC"}/${t.s} on ${dateD} failed: ${r.reason.message}`);
    }
  });
  const top = articles.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_ARTICLES_PER_TICKER);
  // Only cache complete fetches, so a transient failure is retried next run.
  if (complete) {
    const stored = top.map((a) => ({ headline: a.headline, source: a.source, publishedAt: a.publishedAt.toISOString() }));
    sourceCache.set(key, stored);
    appendJsonl("sources.jsonl", key, stored);
  }
  return { articles: top, fetched: true };
}

// ---------- judging: bounded concurrency, cached, outage-aware ----------

function limiter(n) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < n && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      fn().then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

class JudgeDown extends Error {}
let judgeDownSince = null;

async function judgeCached(t, a, judgmentCache, stats) {
  const key = JSON.stringify([ENGINE_LABEL, JEVK5_TEMPERATURE, t.s, t.n, a.headline, a.source]);
  if (judgmentCache.has(key)) {
    stats.cached++;
    return judgmentCache.get(key);
  }
  for (;;) {
    if (stopping) throw new JudgeDown("stopping");
    const started = performance.now();
    try {
      const j = await judgeArticle({ ticker: t.s, company: t.n, headline: a.headline, source: a.source });
      stats.ms.push(performance.now() - started);
      judgeDownSince = null;
      judgmentCache.set(key, j);
      appendJsonl("judgments.jsonl", key, j);
      return j;
    } catch (err) {
      // Any failure is treated as the judge being unavailable: wait and
      // retry, and give up on the whole run (not just this item) if it lasts.
      judgeDownSince ??= Date.now();
      if (Date.now() - judgeDownSince > JUDGE_OUTAGE_MS) {
        throw new JudgeDown(`The ${ENGINE_LABEL} judge has been failing for ${Math.round(JUDGE_OUTAGE_MS / 60_000)} min (last error: ${err.message}).`);
      }
      if (!stats.warned) {
        console.warn(`[backfill] Judge error (${err.message}); retrying for up to ${Math.round(JUDGE_OUTAGE_MS / 60_000)} min…`);
        stats.warned = true;
      }
      await sleep(5_000);
    }
  }
}

// ---------- stop handling ----------

let stopping = false;
function onStop() {
  if (stopping) process.exit(130); // second Ctrl+C: leave immediately
  stopping = true;
  console.log("\n[backfill] Stopping… every fetched source and judgment so far is saved. Run the same command again to continue.");
  setTimeout(() => process.exit(130), 1_500).unref();
}
process.on("SIGINT", onStop);
process.on("SIGTERM", onStop);
process.on("SIGBREAK", onStop); // Windows: Ctrl+Break
process.on("SIGHUP", onStop); // Windows: console window closed

// ---------- main ----------

const args = parseArgs(process.argv.slice(2));
await mkdir(CACHE_DIR, { recursive: true });
await mkdir(HISTORY_DIR, { recursive: true });

const fromMs = dayMs(args.from);
const priceFrom = fromMs - 10 * DAY;

// Trading calendar from SPY (cached with the other prices).
const tickers = args.tickers ? TICKERS.filter((t) => args.tickers.includes(t.s)) : TICKERS;
if (tickers.length === 0) {
  console.error("[backfill] None of --tickers are in the ticker list (src/config.js).");
  process.exit(1);
}
const prices = await loadPrices([{ s: "SPY", a: "stock" }, ...(args.status ? [] : tickers)], priceFrom);
const tradingDays = Object.keys(prices.SPY ?? {}).sort();
const firstTarget = fromMs + (args.every === 7 ? (8 - new Date(fromMs).getUTCDay()) % 7 : 0) * DAY;
const dates = [];
for (let t = firstTarget; iso(t) <= args.to; t += args.every * DAY) {
  const d = tradingDays.find((x) => x >= iso(t));
  if (d && d <= args.to && !dates.includes(d)) dates.push(d);
}
const done = new Set((await readdir(HISTORY_DIR)).filter((f) => f.startsWith("backfill-")).map((f) => f.slice(9, 19)));
const todo = dates.filter((d) => !done.has(d));

const judgmentCache = loadJsonl("judgments.jsonl");
const sourceCache = loadJsonl("sources.jsonl");

if (args.status) {
  console.log(`[backfill] ${dates.length} dates ${dates[0] ?? "—"} → ${dates.at(-1) ?? "—"}: ${dates.length - todo.length} done, ${todo.length} to go.`);
  console.log(`[backfill] Saved progress: ${sourceCache.size} ticker-dates of sources, ${judgmentCache.size} judgments.`);
  if (todo.length) console.log(`[backfill] Next: ${todo.slice(0, 5).join(", ")}${todo.length > 5 ? ", …" : ""}`);
  process.exit(0);
}

if (!ENGINE_LABEL.startsWith("JevK5") && !args.allowHosted) {
  console.error(`[backfill] The judge engine is ${ENGINE_LABEL}, which is hosted and metered. Set JUDGE_ENGINE=jevk5 in .env (local, free), or pass --allow-hosted to use it anyway.`);
  process.exit(1);
}
try {
  await judgeArticle({ ticker: "AAPL", company: "Apple Inc.", headline: "Apple reports quarterly results", source: "Reuters" });
} catch (err) {
  console.error(`[backfill] The ${ENGINE_LABEL} judge isn't answering: ${err.message}`);
  console.error("[backfill] Start llama-server first (see the README's \"Local engine: JevK5\").");
  process.exit(1);
}
if (ENGINE_LABEL.startsWith("JevK5")) {
  try {
    const slots = (await (await fetch(JEVK5_URL + "/props")).json())?.total_slots;
    if (slots && slots < args.concurrency) {
      console.warn(`[backfill] llama-server has ${slots} slot(s) but --concurrency is ${args.concurrency}; extra requests will queue. Start it with -np ${args.concurrency} for full speed.`);
    }
  } catch {}
}

console.log(`[backfill] Engine: ${ENGINE_LABEL}, ${args.concurrency} at a time. ${tickers.length} tickers, ${dates.length} dates ${dates[0] ?? "—"} → ${dates.at(-1) ?? "—"}; ${dates.length - todo.length} done, ${todo.length} to go.`);
console.log(`[backfill] Saved progress found: ${sourceCache.size} ticker-dates of sources, ${judgmentCache.size} judgments. Ctrl+C stops safely at any time.`);
if (todo.length === 0) process.exit(0);

// Fetch stage: walks every (date, ticker) in order on its own, at most
// LOOKAHEAD items ahead of the judging stage, pausing only after real requests.
const LOOKAHEAD = 40;
const jobs = todo.flatMap((d) => tickers.map((t) => ({ d, t })));
const fetched = jobs.map(() => { let resolve; const p = new Promise((r) => (resolve = r)); return { p, resolve }; });
let judgedUpTo = 0;
(async () => {
  for (let i = 0; i < jobs.length && !stopping; i++) {
    while (i - judgedUpTo > LOOKAHEAD && !stopping) await sleep(200);
    const { d, t } = jobs[i];
    try {
      const r = await sourcesAsOf(t, d, fromMs - 20 * DAY, sourceCache);
      fetched[i].resolve(r.articles);
      if (r.fetched) await sleep(NEWS_SPACING_MS);
    } catch (err) {
      console.warn(`[backfill] Sources for ${t.s} on ${d} failed: ${err.message}`);
      fetched[i].resolve([]);
    }
  }
})();

const limit = limiter(args.concurrency);
const t0 = Date.now();
let datesDone = 0;
try {
  for (const [n, d] of todo.entries()) {
    const started = Date.now();
    const stats = { ms: [], cached: 0, warned: false };
    const generatedAt = new Date(dayMs(d) + 19.5 * 3_600_000).toISOString();
    const atMs = Date.parse(generatedAt);

    const recordFor = async (t, idx) => {
      const px = prices[t.s];
      // Entry: D's close (stocks) or the next UTC midnight (crypto); change vs the bar before.
      const entryKey = t.a === "stock" ? d : iso(dayMs(d) + DAY);
      const price = px?.[entryKey];
      const articles = await fetched[idx].p;
      judgedUpTo = Math.max(judgedUpTo, idx);
      if (!Number.isFinite(price)) {
        console.warn(`[backfill] ${t.s}: no price for ${entryKey}; skipped on ${d}.`);
        return null;
      }
      await Promise.all(articles.map((a) => limit(async () => { a.jevJudgment = await judgeCached(t, a, judgmentCache, stats); })));
      const prev = prevKey(px, entryKey);
      const quote = { price, changePct: prev ? (price / px[prev] - 1) * 100 : null, name: t.n };
      const rec = buildTickerRecord(t, quote, articles, { openaiEnabled: false, jevLabel: ENGINE_LABEL });
      rec.src = articles.map((a) => ({ so: a.source, h: a.headline, t: ageAt(a.publishedAt, atMs), jevTag: a.jevJudgment?.sentiment ?? null, openaiTag: null }));
      return rec;
    };
    const base = n * tickers.length;
    const records = (await Promise.all(tickers.map((t, i) => recordFor(t, base + i)))).filter(Boolean);
    if (stopping) break;

    const sorted = [...stats.ms].sort((a, b) => a - b);
    const sum = sorted.reduce((s, x) => s + x, 0);
    const payload = {
      generatedAt,
      backfill: true,
      asOf: d,
      backfillSources: ["Google News (7 days before)", "SEC EDGAR (14 days before)"],
      openaiEnabled: false,
      jevEngine: ENGINE_LABEL,
      timings: {
        jev: sorted.length ? { calls: sorted.length, meanMs: Math.round(sum / sorted.length), medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]), p95Ms: Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]), totalMs: Math.round(sum) } : null,
        openai: null,
      },
      tickers: records,
    };
    const path = fileFor(d);
    await writeFile(path + ".tmp", JSON.stringify(payload));
    await rename(path + ".tmp", path);
    datesDone++;
    const mins = (Date.now() - started) / 60_000;
    const perDate = (Date.now() - t0) / datesDone;
    const left = todo.length - n - 1;
    console.log(`[backfill] ${d} (${n + 1}/${todo.length}): ${records.length} tickers, ${stats.ms.length} judged + ${stats.cached} from saved progress, ${mins.toFixed(1)} min. ` +
      (left ? `~${Math.round((left * perDate) / 60_000)} min left.` : "All dates done."));
  }
} catch (err) {
  if (!(err instanceof JudgeDown)) throw err;
  if (!stopping) {
    console.error(`[backfill] ${err.message}`);
    console.error("[backfill] Stopped without saving the unfinished date. Progress is kept: restart llama-server and run the same command to continue.");
    process.exit(2);
  }
}
if (stopping) process.exit(130);
console.log("[backfill] Finished. Run `npm run backtest` (or Refresh returns on the Performance page) to score the new runs.");
process.exit(0);

function ageAt(publishedAt, atMs) {
  const hours = Math.round((atMs - publishedAt.getTime()) / 3_600_000);
  if (hours < 1) return "just now";
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
