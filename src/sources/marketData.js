import { fetchJson, fetchJsonRetry429 } from "../lib/httpJson.js";

// Free, keyless quote endpoints. Both are unofficial-but-widely-used public
// APIs (no API key, no paid tier) rather than a documented contract, so we
// read defensively and let a single bad ticker fail without the pipeline.

export async function getStockQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  const data = await fetchJson(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") {
    throw new Error(`No quote data for ${ticker}`);
  }
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  const price = meta.regularMarketPrice;
  const changePct =
    typeof meta.regularMarketChangePercent === "number"
      ? meta.regularMarketChangePercent
      : prevClose
        ? ((price - prevClose) / prevClose) * 100
        : 0;
  return {
    price,
    changePct,
    name: meta.longName || meta.shortName || ticker,
  };
}

// All crypto quotes in one request: /simple/price takes a comma-separated id
// list, so the whole crypto universe costs one call against CoinGecko's
// keyless rate limit instead of one per coin. Returns Map<coingeckoId, quote>;
// ids CoinGecko doesn't return are simply absent.
export async function getCryptoQuotes(coingeckoIds) {
  const out = new Map();
  if (coingeckoIds.length === 0) return out;
  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=" +
    coingeckoIds.map(encodeURIComponent).join(",") +
    "&vs_currencies=usd&include_24hr_change=true";
  const data = await fetchJsonRetry429(url);
  for (const id of coingeckoIds) {
    const entry = data?.[id];
    if (entry && typeof entry.usd === "number") {
      out.set(id, { price: entry.usd, changePct: entry.usd_24h_change ?? 0 });
    }
  }
  return out;
}
