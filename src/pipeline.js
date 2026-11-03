import {
  TICKERS,
  MAX_NEWS_PER_TICKER,
  MAX_SEEKING_ALPHA_PER_TICKER,
  MAX_REDDIT_PER_TICKER,
  MAX_ARTICLES_PER_TICKER,
  REQUEST_SPACING_MS,
  CROWD_SEARCH_SPACING_MS,
  CROWD_COIN_SPACING_MS,
} from "./config.js";
import { getStockQuote, getCryptoQuotes } from "./sources/marketData.js";
import { getNewsForCompany } from "./sources/news.js";
import { getSeekingAlphaNews } from "./sources/seekingAlpha.js";
import { getRedditPosts } from "./sources/reddit.js";
import { getRecentFilings } from "./sources/secFilings.js";
import { judgeArticle, ENGINE_LABEL } from "./judge.js";
import { judgeArticleOpenAI, OPENAI_ENABLED } from "./judgeOpenAI.js";
import { buildTickerRecord } from "./aggregate.js";
import { getCrowdSignals } from "./sources/crowdSignal.js";
import { writeCache } from "./cache.js";
import { sleep } from "./lib/httpJson.js";

// Per-call engine latency, in ms. Only successful judgments are recorded — a
// timed-out request says nothing about how long a judgment takes.
function timeEngineCall(samples, run) {
  const start = performance.now();
  return run().then((result) => {
    samples.push(performance.now() - start);
    return result;
  });
}

// Run-level stats for the dashboard's engine-latency table.
function summarizeTimings(samples) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {
    calls: sorted.length,
    meanMs: Math.round(sum / sorted.length),
    medianMs: Math.round(quantile(0.5)),
    p95Ms: Math.round(quantile(0.95)),
    totalMs: Math.round(sum),
  };
}

function skipOnError(promise, label) {
  return promise.catch((err) => {
    console.warn(`[pipeline] ${label} skipped: ${err.message}`);
    return [];
  });
}

async function gatherArticles(tickerMeta) {
  if (tickerMeta.a === "crypto") {
    const [news, reddit] = await Promise.all([
      skipOnError(getNewsForCompany(`${tickerMeta.n} ${tickerMeta.s} crypto`, MAX_NEWS_PER_TICKER), `news/${tickerMeta.s}`),
      skipOnError(getRedditPosts(tickerMeta.n, "crypto", MAX_REDDIT_PER_TICKER), `reddit/${tickerMeta.s}`),
    ]);
    return [...news, ...reddit];
  }

  const [news, seekingAlpha, reddit, filings] = await Promise.all([
    skipOnError(getNewsForCompany(`${tickerMeta.n} stock`, MAX_NEWS_PER_TICKER), `news/${tickerMeta.s}`),
    skipOnError(getSeekingAlphaNews(tickerMeta.s, MAX_SEEKING_ALPHA_PER_TICKER), `seekingAlpha/${tickerMeta.s}`),
    skipOnError(getRedditPosts(tickerMeta.s, "stock", MAX_REDDIT_PER_TICKER), `reddit/${tickerMeta.s}`),
    skipOnError(getRecentFilings(tickerMeta.s), `secFilings/${tickerMeta.s}`),
  ]);
  return [...filings, ...news, ...seekingAlpha, ...reddit];
}

// Judges one article with both engines independently — a failure in one
// (e.g. an OpenAI rate limit) never blocks the other from being recorded.
async function judgeWithBothEngines(tickerMeta, article, engineTimings) {
  const input = {
    ticker: tickerMeta.s,
    company: tickerMeta.n,
    headline: article.headline,
    source: article.source,
  };

  try {
    article.jevJudgment = await timeEngineCall(engineTimings.jev, () => judgeArticle(input));
  } catch (err) {
    console.warn(`[pipeline] ${ENGINE_LABEL} judgment failed for ${tickerMeta.s} article "${article.headline}": ${err.message}`);
  }

  if (OPENAI_ENABLED) {
    try {
      article.openaiJudgment = await timeEngineCall(engineTimings.openai, () => judgeArticleOpenAI(input));
    } catch (err) {
      console.warn(`[pipeline] OpenAI judgment failed for ${tickerMeta.s} article "${article.headline}": ${err.message}`);
    }
  }

  return article;
}

async function gatherForTicker(tickerMeta, engineTimings, crowdSignals, cryptoQuotes) {
  let quote;
  if (tickerMeta.a === "crypto") {
    quote = cryptoQuotes.get(tickerMeta.coingeckoId);
    if (!quote) throw new Error(`No CoinGecko quote for ${tickerMeta.coingeckoId}`);
  } else {
    quote = await getStockQuote(tickerMeta.s);
  }

  const articles = (await gatherArticles(tickerMeta))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_ARTICLES_PER_TICKER);

  for (const article of articles) {
    await judgeWithBothEngines(tickerMeta, article, engineTimings);
  }

  return buildTickerRecord(tickerMeta, quote, articles, {
    openaiEnabled: OPENAI_ENABLED,
    jevLabel: ENGINE_LABEL,
    crowdSignal: crowdSignals.get(tickerMeta.s) ?? null,
  });
}

// `tickerList` defaults to the full universe; pass a subset for cheap dev runs.
export async function runPipeline(tickerList = TICKERS) {
  console.log(`[pipeline] Judgment engine: ${ENGINE_LABEL}`);
  if (OPENAI_ENABLED) {
    console.log("[pipeline] OpenAI comparison enabled — this doubles per-article judgment calls and cost.");
  }

  const engineTimings = { jev: [], openai: [] };

  // Every crypto price in one CoinGecko call, made before the crowd-vote
  // lookups use up the keyless rate limit. Per-coin calls inside the ticker
  // loop ran into 429s whenever REQUEST_SPACING_MS was short.
  let cryptoQuotes = new Map();
  try {
    cryptoQuotes = await getCryptoQuotes(
      tickerList.filter((t) => t.a === "crypto").map((t) => t.coingeckoId),
    );
  } catch (err) {
    console.warn(`[pipeline] Crypto quotes unavailable, crypto tickers will be skipped: ${err.message}`);
  }

  console.log("[pipeline] Fetching crowd signals (TradingView ratings, CoinGecko votes)…");
  const crowdSignals = await getCrowdSignals(tickerList, {
    searchSpacingMs: CROWD_SEARCH_SPACING_MS,
    coinSpacingMs: CROWD_COIN_SPACING_MS,
  });
  console.log(`[pipeline] Crowd signals resolved for ${crowdSignals.size}/${tickerList.length} tickers.`);

  const results = [];
  for (const tickerMeta of tickerList) {
    try {
      const record = await gatherForTicker(tickerMeta, engineTimings, crowdSignals, cryptoQuotes);
      results.push(record);
      const openaiNote = record.openai ? `, OpenAI: ${record.openai.sig}/${record.openai.cv}` : "";
      const crowdNote = record.crowd ? `, ${record.crowd.provider}: ${record.crowd.sig}/${record.crowd.cv}` : "";
      console.log(`[pipeline] ${tickerMeta.s}: ${ENGINE_LABEL} ${record.jev.sig}/${record.jev.cv}${openaiNote}${crowdNote} (${record.src.length} sources)`);
    } catch (err) {
      console.error(`[pipeline] Skipping ${tickerMeta.s}: ${err.message}`);
    }
    await sleep(REQUEST_SPACING_MS);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    openaiEnabled: OPENAI_ENABLED,
    // Which engine produced the `jev` fields ("TypeSafe/Jev" or "JevK5 (local)").
    jevEngine: ENGINE_LABEL,
    timings: {
      jev: summarizeTimings(engineTimings.jev),
      openai: OPENAI_ENABLED ? summarizeTimings(engineTimings.openai) : null,
    },
    tickers: results,
  };
  await writeCache(payload);
  console.log(`[pipeline] Wrote ${results.length}/${tickerList.length} tickers to cache.`);
  return payload;
}
