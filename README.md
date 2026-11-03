# Signals

A dashboard that scans a curated ~110-name list of stocks & crypto and
surfaces an aggregate bullish/bearish/neutral signal per ticker, derived
from news, filings, and social sources — with the source articles shown
alongside the signal so it's explainable, not a black box.

## Judgment engine: TypeSafe / Jev

Signal extraction runs on [TypeSafe](https://docs.typesafe.ai)'s Jev model
— a fast/cheap "System One" judgment model, not a forecaster. Pattern:
**ML feature extraction** (see TypeSafe's use-case map) — per article, ask
typed questions (`Choice`: sentiment direction, `Score`: conviction, `Noul`:
"mentions regulatory action") and aggregate the typed answers per ticker
into the dashboard's signal + conviction score. Implemented in
`src/judge.js` (Jev calls, via `@typesafe-ai/sdk`) and `src/aggregate.js`
(the composition/aggregation logic) — see "Real pipeline" below for the
exact call shape and how it differs from the original plan for the
synthesized summary.

Docs entry points: `https://docs.typesafe.ai/llms.txt` (index),
`/primitives.md` (Choice/Score/Noul question types + SDK call shape),
`/concepts/use-case-map.md` (feature-extraction pattern + financial-crime
use case).

## UI

`public/index.html` is the shipped dashboard — a card-style row list with a
judging-speed table up top (Jev vs OpenAI per-article latency from the
run's `timings`), plus a right-side sliding detail panel that opens with the
synthesized one-line summary above the raw source list. Rows carry three
signals — Jev, optional OpenAI, and the crowd signal (`TradingView` /
`CoinGecko votes`) — with "differ" flags against Jev. It fetches live data
from `/api/signals` (backed by `data/signals.json`); all externally-sourced
text (headlines, outlet names) is HTML-escaped before rendering (see
Security notes).

## Data shape (real pipeline output, `data/signals.json`)

```js
{ generatedAt, openaiEnabled,
  timings: { jev: { calls, meanMs, medianMs, p95Ms, totalMs },
             openai /* same shape, or null if OPENAI_API_KEY unset */ },
  tickers: [
    { s, n, sec, a /* 'stock'|'crypto' */, p /* price */, c /* %chg */,
      jev: { sig /* 'bull'|'bear'|'neu' */, cv /* 0-100 conviction */,
             summary /* one-line plain-English readout, code-composed */,
             regulatoryFlag /* true if any source trips the regulatory Noul */ },
      openai: /* same shape as `jev`, or null if OPENAI_API_KEY is unset */,
      crowd: { sig, cv, summary, provider /* 'TradingView'|'CoinGecko votes' */ } | null,
      src: [{ so /* source name */, h /* headline */, t /* time-ago */,
              jevTag /* 'bull'|'bear'|'neu' */, openaiTag /* same, or null */ }] } ] }
```

`jev` and `openai` are two independent aggregations of judgments over the
*same* `src` list — see "TypeSafe vs OpenAI comparison" below. `timings`
records per-call engine latency for the dashboard's speed table (successful
judgments only — a timed-out request says nothing about judgment speed).
`crowd` is the third signal: an externally-produced read from a free public
source, passed through as-is rather than aggregated from per-article
judgments.

## Real pipeline — built, free data sources only

Everything except Jev, the optional OpenAI comparison, and (optionally)
Reddit runs against fully free, keyless public endpoints — no paid tier, no
account. Reddit's anonymous read API was retired (confirmed: anonymous
requests now get a login-wall 403), so it needs a free OAuth app instead —
see below.

- **Stock quotes**: Yahoo Finance's public chart endpoint
  (`query1.finance.yahoo.com/v8/finance/chart/<TICKER>`).
- **Crypto quotes**: CoinGecko's public `/simple/price` endpoint, one batched
  call for every coin per run (retried once after 60s on a 429).
- **News**: Google News RSS search per company (`news.google.com/rss/search`).
- **Seeking Alpha** (`src/sources/seekingAlpha.js`): per-symbol RSS
  (`seekingalpha.com/api/sa/combined/<TICKER>.xml`), stocks only. Their feed
  description restricts it to "personal, non-commercial use" — worth
  re-checking if this project is ever deployed for others rather than run
  locally.
- **Reddit** (`src/sources/reddit.js`, optional): r/stocks or
  r/CryptoCurrency search via `oauth.reddit.com`. Requires a free "script"
  app (`reddit.com/prefs/apps` → `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`
  in `.env`) using the OAuth2 client-credentials grant — no user password
  needed. Skipped entirely if those vars are unset.
- **Crowd signal** (`src/sources/crowdSignal.js`): the third, non-LLM
  signal. Stocks get TradingView's aggregate rating (sell-side analysts +
  technicals blended into a −1…+1 score) via their keyless symbol-search and
  screener-scan endpoints — one batched POST rates the whole universe.
  Crypto gets CoinGecko's community bull/bear votes
  (`sentiment_votes_up_percentage`). Both are the endpoints the sites' own
  UIs call — public and keyless but unofficial, so they can break without
  notice; any failure just degrades to "no crowd signal for this ticker".
  The lookups are paced (`CROWD_SEARCH_SPACING_MS`,
  `CROWD_COIN_SPACING_MS` in `.env`) to stay under CoinGecko's keyless
  rate limits.
- **Filings**: SEC's own `data.sec.gov/submissions/CIK…` API, resolved from
  the official `company_tickers.json` ticker→CIK map. Form 4s (insider
  trades) get their actual transaction detail fetched and summarized —
  e.g. "Jane Doe (CFO) net disposed of 12,000 shares (open-market sale)" —
  instead of just "a Form 4 was filed" (`src/sources/secFilings.js`). SEC's
  fair-access policy requires a descriptive `User-Agent` (not a secret) —
  set `SEC_USER_AGENT` in `.env`.
- **Tried and dropped**: MarketWatch and Reuters no longer expose free
  per-ticker RSS (tested live: MarketWatch's redirects to a 404, Reuters'
  feed 301s to a dead endpoint); CNBC's RSS is general business news, not
  per-company, so it wasn't useful for this per-ticker pipeline. For a
  TipRanks-style analyst signal: TipRanks' own API returns 403 (Cloudflare)
  and Bloomberg has no free API at all; Yahoo's analyst-rating endpoint now
  demands a cookie+crumb handshake that rate-limits (429) — hence
  TradingView's scanner for the stock crowd signal.
- **Judgment engine**: TypeSafe/Jev, called server-side only
  (`src/judge.js`). Per article, one `systemOne` request asks three
  independent questions — a `Choice` for sentiment direction (bull/bear/
  neutral), a `Score` for how market-moving the headline is (→ conviction),
  and a `Noul` for "does this mention regulatory action" — and the answers
  are combined into the ticker's `sig`/`cv`/`regulatoryFlag` in code
  (`src/aggregate.js`), per TypeSafe's own guidance to keep composition and
  thresholds in reviewable code rather than another model call.
- **Correction to the original plan above**: Jev returns typed judgments and
  probabilities, not generated prose, so it can't produce the dashboard's
  synthesized summary directly. That summary is instead assembled
  deterministically in code from the aggregated judgments (majority signal,
  agreement ratio, and the highest-confidence anchor headline) — see
  `synthesize`-equivalent logic in `src/aggregate.js`.

Per ticker, all sources are merged and capped at `MAX_ARTICLES_PER_TICKER`
(8, most-recent-first) before any Jev calls — adding sources broadens what's
considered without letting per-ticker Jev cost grow unbounded.

## Local engine: JevK5 (optional)

Set `JUDGE_ENGINE=jevk5` in `.env` to swap TypeSafe's hosted Jev for
[JevK5](https://github.com/allebee/jevk5), an independent Apache-2.0
open-weight Jev alternative (Qwen3.5-4B or 9B plus a distilled LoRA; not
affiliated with TypeSafe). It answers the same `choice`/`score`/`noul`
question types the same way — a probability per option from one forward
pass, nothing generated — so its results fill the dashboard's `jev` slot
unchanged, labelled "JevK5 (local)". No API key, no quota.

Serve a GGUF from [alibiserikbay/JevK5-GGUF](https://huggingface.co/alibiserikbay/JevK5-GGUF)
with llama.cpp (needs a build recent enough for Qwen3.5's hybrid layers):

```sh
llama-server -m jevk5-4b-v0.3-Q4_K_M.gguf -c 8192 -ngl 99 --port 8090
```

then set `JUDGE_ENGINE=jevk5` (and `JEVK5_URL` if not `http://127.0.0.1:8090`)
and run `npm run pipeline` as usual.

`src/judgeJevK5.js` is a port of JevK5's own llama.cpp client
(`jevk5/gguf.py` + `jevk5/prompt.py`, v0.3.x). It sends the pinned prompt,
byte for byte, as token ids via `/tokenize` + `/completion`, reads the answer
letters' log-probabilities (`n_probs`), and renormalises them under the
model's calibration temperature (`JEVK5_TEMPERATURE`, 1.22 for v0.3 4B).
Each question is its own request (3 per article), where Jev batches all three
into one `systemOne` call.

Things to know, from JevK5's own README and model card:

- **Quantization:** the v0.3 4B Q4_K_M matches bf16 on 221 of JevBench's 231
  public items (Q8_0: 229, Q5_K_M: 224). Use Q8_0 or Q5_K_M if they fit.
- **Measured quality is general-purpose**, not financial: JevBench v1.4 ranks
  JevK5 v0.2 second of 76 (Jev first), and the v0.3 4B scores 0.784 on the
  public hard tier. Nobody has measured it on headline sentiment, so treat the
  first runs as a comparison against Jev, not a drop-in guarantee.
- **English only.** Inputs over 16,384 tokens are refused (headlines are far
  below that; `-c 8192` is plenty).
- **Speed:** ~0.6 s per short decision on CPU alone or an M1 Pro (4B), ~13 ms
  on an H100; consumer GPUs are unmeasured. The dashboard's judging-speed table
  records the real numbers for your machine.
- With no hosted judge to rate-limit, `REQUEST_SPACING_MS` defaults to 5s
  (unless OpenAI is on) — the remaining spacing protects the free news/quote
  endpoints.

## TypeSafe vs OpenAI comparison (optional)

Set `OPENAI_API_KEY` in `.env` to also judge every article with an OpenAI
model (`src/judgeOpenAI.js`), so each ticker gets two independently
aggregated views over the *identical* source list — the dashboard shows
both, tags disagreements, and the detail panel shows each engine's own
summary and per-source tags. Unset, `openai` is simply `null` everywhere
and the dashboard shows Jev's result only.

**This is not an apples-to-apples methodology comparison, and that matters
for reading the results honestly:**

- TypeSafe's `Choice`/`Score` return a real probability distribution from a
  model architected specifically to produce calibrated judgments — that's
  the whole "System One" design.
- The OpenAI side is a general chat model given a system prompt describing
  the same three questions (sentiment / conviction level / regulatory
  probability) via structured outputs (`openai.responses.parse` +
  `zodTextFormat`), and asked to *self-report* its own confidence in a JSON
  field. That's an introspective guess, not a distribution — treat OpenAI's
  "confidence" as a materially weaker signal than Jev's.

The third, crowd signal (`src/sources/crowdSignal.js`) is a different class
entirely — not a judgment engine at all. TradingView's rating is a blend of
sell-side analyst calls and technical indicators; CoinGecko's votes are raw
retail sentiment. Neither reads the article list, so disagreement between
Jev and the crowd signal isn't an error — it's model-vs-market triangulation.

Also worth knowing before running this: **OpenAI is a paid API**, unlike
every other integration in this project. It's opt-in for exactly that
reason. Enabling it roughly doubles per-article judgment calls (one to Jev,
one to OpenAI) and their cost/latency. `OPENAI_MODEL` (`.env`) defaults to
OpenAI's flagship model (`gpt-6-astra` at the time of writing — verified
against their live docs, not guessed) rather than a cheap/fast tier: the
point of this comparison is Jev (cheap, fast, purpose-built for narrow
judgments) against OpenAI's strongest general-purpose model, not a
same-cost-tier matchup. OpenAI's model lineup moves fast, so check their
current docs before trusting this default to still be current, and swap in
a cheaper model via `.env` if cost matters more than the strongest showing.

### Running it

```sh
npm install
cp .env.example .env   # add your TYPESAFE_API_KEY and SEC_USER_AGENT
                         # (optionally OPENAI_API_KEY for the comparison)
npm run pipeline        # fetches quotes/news/filings, judges via Jev,
                         # writes data/signals.json
`data/signals.json` is **committed as demo data** — a snapshot of a full
run, so a fresh clone gets a populated dashboard immediately (regenerating
it needs an API key and ~a minute per ticker). It's still generated
output: the snapshot goes stale (check the footer's "updated" timestamp), and every
full `npm run pipeline` run will leave the file modified locally — commit
the refresh or `git checkout` it away. Re-run on a schedule (e.g. cron) to
keep a live deployment fresh; the server itself is read-only and never
triggers the pipeline, so it never spends TypeSafe/API quota on its own.

The ticker universe (`src/config.js`) is a curated ~110 names across
sectors (stocks + crypto) — a hand-picked list, not a live top-100-by-
market-cap ranking. A full run makes several HTTP calls and up to 8 Jev
calls per ticker, with a deliberate 30s pause between tickers
(`REQUEST_SPACING_MS`, override in `.env`) so the per-ticker burst of judge
calls stays clear of 429s — expect a full-universe run to take on the order
of two hours and real Jev quota.

For quick iteration you can also run a subset straight from code:
`runPipeline([tickerMeta, …])` accepts any slice of `TICKERS`.

## Backtest (`npm run backtest`)

Every pipeline run is also saved to `data/history/<generatedAt>.json`, so the
signals as they stood on each date are kept. `data/history/` is tracked in git,
seeded with the 2026-09-18 demo snapshot (TypeSafe/Jev + OpenAI + crowd). Commit new
snapshots to keep the record, or git-ignore the folder if you'd rather not.

`npm run backtest` (`scripts/backtest.js`) loads every snapshot and fetches
the prices that followed it: Yahoo daily closes for stocks and CoinGecko for
crypto, both keyless. It then reports:

- **Spearman correlation matrix** between the signals and forward returns.
  Signals are signed: bullish = +conviction, bearish = −conviction, neutral = 0.
  The columns are Jev / JevK5 (never mixed), OpenAI, TradingView, CoinGecko votes,
  the regulatory flag, the day's % change at signal time, and source count. The
  forward returns are ~1 day, ~1 week, ~2 weeks and ~4 weeks (1/5/10/20 trading
  sessions for stocks, 1/7/14/28 days for crypto). Each cell carries n and a 95%
  Fisher-z interval.
- **Hit rate and average return per call**: the share of bullish/bearish calls
  followed by a market-adjusted move in that direction, plus the average return
  after bull, neutral and bear calls, and the bull−bear spread.

Returns are measured from the price recorded when the signals were computed
(no look-ahead). They are market-adjusted: the ticker's return minus the
average of its asset class over the same window. Output is printed and also written to
`data/backtest.html` (colour-coded heatmap) and `data/backtest.json` (every
row).

**How far to trust it:** with only a snapshot or two, every column is one
market episode, and tickers in the same sector move together. The intervals
are optimistic, so a * means "worth watching", not proof. The test gets
meaningful once the pipeline has run on a schedule for weeks (daily via cron or
Windows Task Scheduler). A horizon only shows up once enough time has passed
since a snapshot. CoinGecko lookups are paced by `CROWD_COIN_SPACING_MS`
(about 3–4 min for 20 coins).

### Security notes

- `TYPESAFE_API_KEY` and `OPENAI_API_KEY` are read from the environment
  (`.env`, git-ignored) and never sent to or read by the browser —
  `TypeSafeClient` itself refuses to run in a browser context, which
  matches this architecture: all model calls (`src/judge.js`,
  `src/judgeOpenAI.js`) live on the server.
- News headlines and outlet names are live, external, untrusted text. The
  dashboard (`public/index.html`) HTML-escapes every externally-sourced
  string before it touches `innerHTML`.
- No secrets or `node_modules` are committed — see `.gitignore` and
  `.env.example`. The committed demo snapshot contains third-party
  headlines; re-check the Seeking Alpha usage restriction before ever
  turning this into a hosted service.

## Not yet built (next steps discussed)

- Signal-credibility weighting (a Seeking Alpha article vs. a Reddit post
  currently count equally in the aggregation) — flagged as a risk, not yet
  addressed
- Other feature ideas raised but not built: alerts on signal flips,
  per-ticker accuracy (the backtest above is cross-sectional), sector heatmap, multi-timeframe signals
