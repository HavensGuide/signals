import { fetchJson, fetchJsonRetry429, sleep } from "../lib/httpJson.js";

// Third per-ticker signal — deliberately NOT another model judgment. It comes
// from free, keyless, popular public sources that produce their own directional
// read, so the dashboard triangulates model judgment (Jev, OpenAI) against
// externally-produced opinion:
//   stocks → TradingView's aggregate rating (sell-side analysts + technical
//            indicators blended into a −1…+1 score; their own buckets are
//            ≤−0.5 Strong Sell … ≥+0.5 Strong Buy, Neutral inside ±0.1)
//   crypto → CoinGecko's community bull/bear votes on the coin page
//            (sentiment_votes_up_percentage; even split ≈ 50)
// Both endpoints are what the sites' own UIs call — public and keyless, but
// unofficial. Any failure here degrades to "no crowd signal for this ticker"
// and never fails the pipeline run.

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// symbol-search rejects requests without a browser Origin header.
const TV_SEARCH_HEADERS = { "User-Agent": BROWSER_UA, Origin: "https://www.tradingview.com" };

function tvLabel(rating) {
  if (rating >= 0.5) return "Strong Buy";
  if (rating >= 0.1) return "Buy";
  if (rating > -0.1) return "Neutral";
  if (rating > -0.5) return "Sell";
  return "Strong Sell";
}

// The scanner only accepts exchange-prefixed symbols ("NASDAQ:AAPL"), so each
// bare ticker is first resolved through TradingView's symbol search. First
// exact stock match is in practice the US primary listing.
async function resolveTvTicker(symbol) {
  const url =
    `https://symbol-search.tradingview.com/symbol_search/v3/?text=${encodeURIComponent(symbol)}&start=0`;
  const data = await fetchJson(url, { headers: TV_SEARCH_HEADERS });
  const hit = (data.symbols || []).find(
    (s) => s.type === "stock" && String(s.symbol).toLowerCase() === symbol.toLowerCase(),
  );
  return hit ? `${hit.exchange}:${hit.symbol}` : null;
}

// One batched POST rates every resolved symbol, so the whole stock universe
// costs one scanner call after the per-symbol exchange lookups.
async function getTradingViewRatings(symbols, spacingMs) {
  const resolved = [];
  for (const sym of symbols) {
    try {
      const tvSymbol = await resolveTvTicker(sym);
      if (tvSymbol) resolved.push({ sym, tvSymbol });
    } catch (err) {
      console.warn(`[crowd] TradingView symbol lookup failed for ${sym}: ${err.message}`);
    }
    await sleep(spacingMs);
  }
  if (resolved.length === 0) return new Map();

  const scan = await fetchJson("https://scanner.tradingview.com/america/scan", {
    method: "POST",
    headers: { "User-Agent": BROWSER_UA, "Content-Type": "application/json" },
    body: JSON.stringify({
      filter: [{ left: "name", operation: "nempty" }],
      symbols: { tickers: resolved.map((r) => r.tvSymbol) },
      columns: ["name", "Recommend.All"],
      range: [0, resolved.length],
    }),
  });

  const symByTvSymbol = new Map(resolved.map((r) => [r.tvSymbol, r.sym]));
  const ratings = new Map();
  for (const row of scan.data || []) {
    const sym = symByTvSymbol.get(row.s);
    const rating = row.d?.[1];
    if (sym && typeof rating === "number") ratings.set(sym, rating);
  }
  return ratings;
}

async function getCoinGeckoBullPct(coingeckoId) {
  const url =
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coingeckoId)}` +
    "?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false";
  const data = await fetchJsonRetry429(url, { headers: { "User-Agent": BROWSER_UA } });
  return typeof data.sentiment_votes_up_percentage === "number"
    ? data.sentiment_votes_up_percentage
    : null;
}

// Returns Map<tickerSymbol, { sig, cv, summary, provider }>. Missing entries
// mean "no crowd signal this run" (lookup failure or unlisted asset).
export async function getCrowdSignals(
  tickerMetas,
  { searchSpacingMs = 1_000, coinSpacingMs = 10_000 } = {},
) {
  const out = new Map();

  try {
    const ratings = await getTradingViewRatings(
      tickerMetas.filter((t) => t.a === "stock").map((t) => t.s),
      searchSpacingMs,
    );
    for (const [sym, rating] of ratings) {
      out.set(sym, {
        sig: rating >= 0.1 ? "bull" : rating <= -0.1 ? "bear" : "neu",
        cv: Math.round(Math.abs(rating) * 100),
        provider: "TradingView",
        summary:
          `TradingView aggregate rating: ${tvLabel(rating)} (${rating.toFixed(2)} on a −1…+1 ` +
          "sell-to-buy scale, blending sell-side analyst ratings and technical indicators).",
      });
    }
  } catch (err) {
    console.warn(`[crowd] TradingView ratings skipped: ${err.message}`);
  }

  for (const meta of tickerMetas.filter((t) => t.a === "crypto")) {
    try {
      const up = await getCoinGeckoBullPct(meta.coingeckoId);
      if (up !== null) {
        out.set(meta.s, {
          sig: up >= 55 ? "bull" : up <= 45 ? "bear" : "neu",
          cv: Math.round(Math.abs(up - 50) * 2),
          provider: "CoinGecko votes",
          summary:
            `CoinGecko community votes: ${up.toFixed(0)}% bullish vs ${(100 - up).toFixed(0)}% ` +
            "bearish, from retail visitors voting on the coin's page.",
        });
      }
    } catch (err) {
      console.warn(`[crowd] CoinGecko votes skipped for ${meta.s}: ${err.message}`);
    }
    await sleep(coinSpacingMs);
  }

  return out;
}
