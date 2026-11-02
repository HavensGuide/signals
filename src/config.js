// Curated ~100-name universe (stocks + crypto), hand-picked for broad sector
// coverage and high confidence the symbol is real and actively traded —
// not a live top-100-by-market-cap ranking. Extend/replace entries freely;
// nothing else in the pipeline needs to change.
export const TICKERS = [
  // Big tech / internet
  { s: "AAPL", n: "Apple", sec: "Consumer Tech", a: "stock" },
  { s: "MSFT", n: "Microsoft", sec: "Software", a: "stock" },
  { s: "GOOGL", n: "Alphabet", sec: "Internet", a: "stock" },
  { s: "AMZN", n: "Amazon", sec: "E-commerce", a: "stock" },
  { s: "META", n: "Meta Platforms", sec: "Social / Ads", a: "stock" },
  { s: "NFLX", n: "Netflix", sec: "Media", a: "stock" },
  { s: "UBER", n: "Uber Technologies", sec: "Internet", a: "stock" },
  { s: "ABNB", n: "Airbnb", sec: "Internet", a: "stock" },
  { s: "DIS", n: "Walt Disney", sec: "Media", a: "stock" },
  { s: "CMCSA", n: "Comcast", sec: "Media", a: "stock" },
  { s: "VZ", n: "Verizon", sec: "Telecom", a: "stock" },
  // Software / enterprise
  { s: "ORCL", n: "Oracle", sec: "Software", a: "stock" },
  { s: "ADBE", n: "Adobe", sec: "Software", a: "stock" },
  { s: "CRM", n: "Salesforce", sec: "Software", a: "stock" },
  { s: "NOW", n: "ServiceNow", sec: "Software", a: "stock" },
  { s: "INTU", n: "Intuit", sec: "Software", a: "stock" },
  { s: "IBM", n: "IBM", sec: "Software", a: "stock" },
  { s: "CSCO", n: "Cisco Systems", sec: "Networking", a: "stock" },
  { s: "SNOW", n: "Snowflake", sec: "Software", a: "stock" },
  { s: "PLTR", n: "Palantir Technologies", sec: "Software", a: "stock" },
  { s: "CRWD", n: "CrowdStrike", sec: "Cybersecurity", a: "stock" },
  { s: "PANW", n: "Palo Alto Networks", sec: "Cybersecurity", a: "stock" },
  { s: "SHOP", n: "Shopify", sec: "E-commerce", a: "stock" },
  // Semiconductors
  { s: "NVDA", n: "NVIDIA", sec: "Semiconductors", a: "stock" },
  { s: "AMD", n: "Advanced Micro Devices", sec: "Semiconductors", a: "stock" },
  { s: "INTC", n: "Intel", sec: "Semiconductors", a: "stock" },
  { s: "QCOM", n: "Qualcomm", sec: "Semiconductors", a: "stock" },
  { s: "TXN", n: "Texas Instruments", sec: "Semiconductors", a: "stock" },
  { s: "AVGO", n: "Broadcom", sec: "Semiconductors", a: "stock" },
  { s: "MU", n: "Micron Technology", sec: "Semiconductors", a: "stock" },
  { s: "AMAT", n: "Applied Materials", sec: "Semiconductors", a: "stock" },
  { s: "ARM", n: "Arm Holdings", sec: "Semiconductors", a: "stock" },
  // Fintech / payments / exchanges
  { s: "V", n: "Visa", sec: "Payments", a: "stock" },
  { s: "MA", n: "Mastercard", sec: "Payments", a: "stock" },
  { s: "PYPL", n: "PayPal", sec: "Payments", a: "stock" },
  { s: "SQ", n: "Block", sec: "Payments", a: "stock" },
  { s: "COIN", n: "Coinbase Global", sec: "Crypto Exchange", a: "stock" },
  { s: "SOFI", n: "SoFi Technologies", sec: "Fintech", a: "stock" },
  { s: "AXP", n: "American Express", sec: "Payments", a: "stock" },
  { s: "SCHW", n: "Charles Schwab", sec: "Financial Services", a: "stock" },
  { s: "MSTR", n: "MicroStrategy", sec: "Crypto Treasury", a: "stock" },
  // Banking
  { s: "JPM", n: "JPMorgan Chase", sec: "Banking", a: "stock" },
  { s: "BAC", n: "Bank of America", sec: "Banking", a: "stock" },
  { s: "WFC", n: "Wells Fargo", sec: "Banking", a: "stock" },
  { s: "GS", n: "Goldman Sachs", sec: "Banking", a: "stock" },
  { s: "MS", n: "Morgan Stanley", sec: "Banking", a: "stock" },
  { s: "C", n: "Citigroup", sec: "Banking", a: "stock" },
  { s: "BLK", n: "BlackRock", sec: "Asset Management", a: "stock" },
  // Healthcare / pharma
  { s: "UNH", n: "UnitedHealth Group", sec: "Healthcare", a: "stock" },
  { s: "JNJ", n: "Johnson & Johnson", sec: "Pharmaceuticals", a: "stock" },
  { s: "PFE", n: "Pfizer", sec: "Pharmaceuticals", a: "stock" },
  { s: "MRK", n: "Merck", sec: "Pharmaceuticals", a: "stock" },
  { s: "LLY", n: "Eli Lilly", sec: "Pharmaceuticals", a: "stock" },
  { s: "ABBV", n: "AbbVie", sec: "Pharmaceuticals", a: "stock" },
  { s: "ABT", n: "Abbott Laboratories", sec: "Healthcare", a: "stock" },
  { s: "TMO", n: "Thermo Fisher Scientific", sec: "Healthcare", a: "stock" },
  { s: "DHR", n: "Danaher", sec: "Healthcare", a: "stock" },
  { s: "CVS", n: "CVS Health", sec: "Healthcare", a: "stock" },
  // Consumer staples / retail
  { s: "PG", n: "Procter & Gamble", sec: "Consumer Staples", a: "stock" },
  { s: "KO", n: "Coca-Cola", sec: "Consumer Staples", a: "stock" },
  { s: "PEP", n: "PepsiCo", sec: "Consumer Staples", a: "stock" },
  { s: "WMT", n: "Walmart", sec: "Retail", a: "stock" },
  { s: "COST", n: "Costco Wholesale", sec: "Retail", a: "stock" },
  { s: "HD", n: "Home Depot", sec: "Retail", a: "stock" },
  { s: "LOW", n: "Lowe's", sec: "Retail", a: "stock" },
  { s: "TGT", n: "Target", sec: "Retail", a: "stock" },
  { s: "NKE", n: "Nike", sec: "Consumer Discretionary", a: "stock" },
  { s: "MCD", n: "McDonald's", sec: "Restaurants", a: "stock" },
  { s: "SBUX", n: "Starbucks", sec: "Restaurants", a: "stock" },
  // Industrials / aerospace / autos
  { s: "BA", n: "Boeing", sec: "Aerospace", a: "stock" },
  { s: "CAT", n: "Caterpillar", sec: "Industrials", a: "stock" },
  { s: "GE", n: "General Electric", sec: "Industrials", a: "stock" },
  { s: "HON", n: "Honeywell", sec: "Industrials", a: "stock" },
  { s: "UPS", n: "United Parcel Service", sec: "Logistics", a: "stock" },
  { s: "RTX", n: "RTX Corporation", sec: "Aerospace", a: "stock" },
  { s: "LMT", n: "Lockheed Martin", sec: "Aerospace", a: "stock" },
  { s: "UNP", n: "Union Pacific", sec: "Rail", a: "stock" },
  { s: "TSLA", n: "Tesla", sec: "Automotive", a: "stock" },
  { s: "F", n: "Ford Motor", sec: "Automotive", a: "stock" },
  { s: "GM", n: "General Motors", sec: "Automotive", a: "stock" },
  { s: "RIVN", n: "Rivian Automotive", sec: "Automotive", a: "stock" },
  // Energy
  { s: "XOM", n: "Exxon Mobil", sec: "Energy", a: "stock" },
  { s: "CVX", n: "Chevron", sec: "Energy", a: "stock" },
  { s: "COP", n: "ConocoPhillips", sec: "Energy", a: "stock" },
  { s: "SLB", n: "SLB", sec: "Energy Services", a: "stock" },
  // Utilities / materials / real estate
  { s: "NEE", n: "NextEra Energy", sec: "Utilities", a: "stock" },
  { s: "DUK", n: "Duke Energy", sec: "Utilities", a: "stock" },
  { s: "LIN", n: "Linde", sec: "Materials", a: "stock" },
  { s: "PLD", n: "Prologis", sec: "Real Estate", a: "stock" },
  { s: "AMT", n: "American Tower", sec: "Real Estate", a: "stock" },

  // Crypto
  { s: "BTC", n: "Bitcoin", sec: "Layer 1", a: "crypto", coingeckoId: "bitcoin" },
  { s: "ETH", n: "Ethereum", sec: "Layer 1", a: "crypto", coingeckoId: "ethereum" },
  { s: "SOL", n: "Solana", sec: "Layer 1", a: "crypto", coingeckoId: "solana" },
  { s: "XRP", n: "XRP", sec: "Payments", a: "crypto", coingeckoId: "ripple" },
  { s: "ADA", n: "Cardano", sec: "Layer 1", a: "crypto", coingeckoId: "cardano" },
  { s: "DOGE", n: "Dogecoin", sec: "Meme", a: "crypto", coingeckoId: "dogecoin" },
  { s: "TRX", n: "TRON", sec: "Layer 1", a: "crypto", coingeckoId: "tron" },
  { s: "AVAX", n: "Avalanche", sec: "Layer 1", a: "crypto", coingeckoId: "avalanche-2" },
  { s: "LINK", n: "Chainlink", sec: "Oracle Network", a: "crypto", coingeckoId: "chainlink" },
  { s: "DOT", n: "Polkadot", sec: "Layer 0", a: "crypto", coingeckoId: "polkadot" },
  { s: "LTC", n: "Litecoin", sec: "Layer 1", a: "crypto", coingeckoId: "litecoin" },
  { s: "BCH", n: "Bitcoin Cash", sec: "Layer 1", a: "crypto", coingeckoId: "bitcoin-cash" },
  { s: "XLM", n: "Stellar", sec: "Payments", a: "crypto", coingeckoId: "stellar" },
  { s: "NEAR", n: "NEAR Protocol", sec: "Layer 1", a: "crypto", coingeckoId: "near" },
  { s: "MATIC", n: "Polygon", sec: "Layer 2", a: "crypto", coingeckoId: "matic-network" },
  { s: "SUI", n: "Sui", sec: "Layer 1", a: "crypto", coingeckoId: "sui" },
  { s: "APT", n: "Aptos", sec: "Layer 1", a: "crypto", coingeckoId: "aptos" },
  { s: "UNI", n: "Uniswap", sec: "DeFi", a: "crypto", coingeckoId: "uniswap" },
  { s: "SHIB", n: "Shiba Inu", sec: "Meme", a: "crypto", coingeckoId: "shiba-inu" },
  { s: "HBAR", n: "Hedera", sec: "Layer 1", a: "crypto", coingeckoId: "hedera-hashgraph" },
];

// Per-source caps, kept modest because every article costs a Jev call.
// MAX_ARTICLES_PER_TICKER is the hard ceiling applied *after* merging all
// sources, so adding more sources broadens what's considered without
// letting per-ticker cost grow unbounded.
export const MAX_NEWS_PER_TICKER = 4;
export const MAX_SEEKING_ALPHA_PER_TICKER = 2;
export const MAX_REDDIT_PER_TICKER = 2;
export const MAX_FILINGS_PER_TICKER = 2;
export const MAX_ARTICLES_PER_TICKER = 8;

export const FILING_LOOKBACK_DAYS = 14;
export const RELEVANT_FILING_FORMS = new Set(["8-K", "10-Q", "10-K", "4", "SC 13D", "SC 13G"]);

// Integer env override: parsed value when set and valid, else the fallback.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Positive float env override, same rules as envInt.
function envFloat(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Pause between tickers, overridable via REQUEST_SPACING_MS in .env. Each
// ticker fires a burst of up to MAX_ARTICLES_PER_TICKER × 2 judge calls
// (Jev + OpenAI) plus its quote/news fetches back-to-back; 30s between
// tickers keeps that burst rate low enough to stay clear of 429s.
// Full-universe runs are slow by design (~2h at this setting) — pass a
// subset to runPipeline() for dev runs.
// With a local JevK5 and no OpenAI, there is no hosted judge left to rate-limit
// us — only the free quote/news/filing fetches — so the default drops to 5s.
export const REQUEST_SPACING_MS = envInt(
  "REQUEST_SPACING_MS",
  (process.env.JUDGE_ENGINE || "").toLowerCase() === "jevk5" && !process.env.OPENAI_API_KEY ? 5_000 : 30_000,
);

// Crowd-source pacing, separate from the per-ticker pause: TradingView's
// symbol search is a light endpoint (~95 lookups, 1s apart is polite), while
// CoinGecko's keyless /coins/{id} tolerates only a handful of calls per
// minute before it starts returning 429s.
export const CROWD_SEARCH_SPACING_MS = envInt("CROWD_SEARCH_SPACING_MS", 1_000);
export const CROWD_COIN_SPACING_MS = envInt("CROWD_COIN_SPACING_MS", 10_000);

export const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT || "signals-dashboard/0.1 (contact: set SEC_USER_AGENT in .env)";

// Reddit's read-only search API now requires a free "script" app
// (reddit.com/prefs/apps) — no payment, but no longer truly keyless like
// the other sources. If unset, the pipeline skips Reddit entirely.
export const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
export const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
export const REDDIT_USER_AGENT =
  process.env.REDDIT_USER_AGENT || "signals-dashboard/0.1 (set REDDIT_USER_AGENT in .env)";

export const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;

// Which engine fills the dashboard's `jev` slot: "typesafe" (hosted Jev, the
// default) or "jevk5" (a local JevK5 GGUF behind llama.cpp's llama-server —
// see src/judgeJevK5.js).
export const JUDGE_ENGINE = (process.env.JUDGE_ENGINE || "typesafe").toLowerCase();
export const JEVK5_URL = (process.env.JEVK5_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
// Calibration temperature for the letter readout. It belongs to the weights,
// not the quantization: 1.22 for JevK5 v0.3 4B (every v0.3 4B GGUF, Q4_K_M
// included), 1.316 for JevK5-9B v0.3.3, 1.049 for 9B v0.3, 1.532 for 4B v0.2,
// 1.42 for 2B v0.2 (from the JevK5 README / CHANGELOG).
export const JEVK5_TEMPERATURE = envFloat("JEVK5_TEMPERATURE", 1.22);
// How many next-token log-probabilities to request; must cover the letters.
export const JEVK5_TOP_K = envInt("JEVK5_TOP_K", 40);

// Optional comparison engine: judges the exact same articles as Jev, using
// the same output shape, so the two can be compared side by side. Unlike
// everything else in this project, OpenAI is a paid API — this path is
// opt-in and skipped entirely if unset. Defaults to OpenAI's flagship model
// (verified against their live docs — "our most capable model, built for
// the hardest end-to-end work") rather than a cheap/fast tier, since the
// point of this comparison is Jev (cheap+fast, purpose-built for narrow
// judgments) vs. OpenAI's strongest general model, not a same-tier
// matchup. Model naming moves fast; check OpenAI's current docs and
// override via .env rather than trusting this default to still be current.
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-6-astra";

export const CACHE_PATH = new URL("../data/signals.json", import.meta.url);
