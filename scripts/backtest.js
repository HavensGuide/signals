// Backtest: did past signals line up with what prices did next?
//
//   npm run backtest
//
// Reads every saved run in data/history/ (plus the current data/signals.json),
// fetches the prices that followed each run, and prints:
//   1. a Spearman correlation matrix between the signals and forward returns
//   2. per signal: hit rate and the average return after bull vs bear calls
// It also writes data/backtest.html (a colour-coded version) and
// data/backtest.json (every row, for your own analysis).
//
// Forward returns are measured from the price recorded at the moment the
// signals were computed, so there is no look-ahead. They are market-adjusted:
// each ticker's return minus the average of its asset class (stocks or crypto)
// over the same window, so a market-wide rally doesn't count as skill.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TICKERS } from "../src/config.js";
import { HISTORY_DIR, snapshotFileName } from "../src/cache.js";
import { fetchJson, fetchJsonRetry429, sleep } from "../src/lib/httpJson.js";
import { spearman, mean } from "../src/stats.js";

const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const DAY = 86_400_000;
// Horizons: stocks in trading sessions, crypto (trades every day) in days,
// paired so each column covers about the same stretch of calendar time.
// "to date" is the return from signal time to the latest price available, so a
// snapshot gets scored as soon as any price after it exists (the fixed
// horizons stay blank until their full window has passed).
const HORIZONS = [
  { label: "1d", sessions: 1, days: 1 },
  { label: "1w", sessions: 5, days: 7 },
  { label: "2w", sessions: 10, days: 14 },
  { label: "4w", sessions: 20, days: 28 },
  { label: "to date", latest: true },
];
// Crypto "to date" needs at least this long after the signal, so a backtest
// run minutes after the pipeline doesn't score noise.
const MIN_TO_DATE_MS = 3_600_000;
const COIN_SPACING_MS = process.env.CROWD_COIN_SPACING_MS
  ? Math.max(0, Number(process.env.CROWD_COIN_SPACING_MS) || 0)
  : 10_000;
const SIGN = { bull: 1, bear: -1, neu: 0 };

// ---------- snapshots ----------

async function loadSnapshots() {
  const byTime = new Map();
  let files = [];
  try {
    files = (await readdir(HISTORY_DIR)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  for (const f of files) {
    const snap = JSON.parse(await readFile(join(HISTORY_DIR, f), "utf8"));
    byTime.set(snap.generatedAt, snap);
  }
  // The current cache too, in case it predates history archiving.
  try {
    const cur = JSON.parse(await readFile(join(DATA_DIR, "signals.json"), "utf8"));
    if (!byTime.has(cur.generatedAt)) {
      byTime.set(cur.generatedAt, cur);
      console.log(`[backtest] Including data/signals.json (${snapshotFileName(cur.generatedAt)}), not yet in history.`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return [...byTime.values()].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
}

// Short engine name for the `jev` slot of a snapshot, so TypeSafe/Jev and
// JevK5 never share a column.
const engineOf = (snap) => (String(snap.jevEngine || "").startsWith("JevK5") ? "JevK5" : "Jev");

// ---------- prices ----------

// Yahoo daily bars: [{ close time (ms), close }], completed sessions only.
async function stockBars(symbol, fromMs) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  const data = await fetchJson(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const r = data?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    // Daily bars are stamped at the 9:30 ET open; the regular session closes 6.5h later.
    const closeAt = ts[i] * 1000 + 6.5 * 3_600_000;
    if (Number.isFinite(closes[i]) && closeAt <= Date.now()) bars.push({ t: closeAt, p: closes[i] });
  }
  return bars;
}

// CoinGecko price points: [{ t, p }], hourly when the range is ≤ 90 days.
async function coinPoints(coingeckoId, fromMs) {
  const days = Math.min(365, Math.ceil((Date.now() - fromMs) / DAY) + 1);
  const url =
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coingeckoId)}/market_chart` +
    `?vs_currency=usd&days=${days}`;
  const data = await fetchJsonRetry429(url);
  return (data?.prices ?? []).map(([t, p]) => ({ t, p }));
}

function stockExit(bars, at, sessions) {
  const after = bars.filter((b) => b.t > at);
  // Session 0 is the first close after the snapshot; horizon h is h closes later.
  return after[sessions]?.p ?? null;
}

function coinExit(points, at, days) {
  const target = at + days * DAY;
  if (target > Date.now()) return null;
  let best = null;
  for (const pt of points) {
    if (best === null || Math.abs(pt.t - target) < Math.abs(best.t - target)) best = pt;
  }
  // With hourly or daily data the nearest point is within a day; anything
  // further means a gap in the series.
  return best && Math.abs(best.t - target) <= DAY ? best.p : null;
}

// Latest price after the signal: { t, p } or null. Stocks: the most recent
// completed close after the snapshot. Crypto: the most recent point, if it is
// at least MIN_TO_DATE_MS after the snapshot.
function latestExit(px, at) {
  const last = px.series.at(-1);
  if (!last) return null;
  const minGap = px.kind === "stock" ? 0 : MIN_TO_DATE_MS;
  return last.t > at + minGap ? last : null;
}

async function fetchPrices(snapshots) {
  const from = Date.parse(snapshots[0].generatedAt) - 3 * DAY;
  const symbols = new Map(); // symbol -> asset class
  for (const s of snapshots) for (const t of s.tickers) symbols.set(t.s, t.a);
  const coinIds = new Map(TICKERS.filter((t) => t.a === "crypto").map((t) => [t.s, t.coingeckoId]));

  const prices = new Map();
  const stocks = [...symbols].filter(([, a]) => a === "stock").map(([s]) => s);
  const coins = [...symbols].filter(([, a]) => a === "crypto").map(([s]) => s);
  console.log(`[backtest] Fetching prices: ${stocks.length} stocks (Yahoo), ${coins.length} coins (CoinGecko, ~${Math.round((coins.length * COIN_SPACING_MS) / 60_000)} min)…`);

  for (const s of stocks) {
    try {
      prices.set(s, { kind: "stock", series: await stockBars(s, from) });
    } catch (err) {
      console.warn(`[backtest] No prices for ${s}: ${err.message}`);
    }
    await sleep(250);
  }
  for (const s of coins) {
    const id = coinIds.get(s);
    if (!id) {
      console.warn(`[backtest] No CoinGecko id for ${s}; skipped.`);
      continue;
    }
    try {
      prices.set(s, { kind: "crypto", series: await coinPoints(id, from) });
    } catch (err) {
      console.warn(`[backtest] No prices for ${s}: ${err.message}`);
    }
    await sleep(COIN_SPACING_MS);
  }
  return prices;
}

// ---------- rows ----------

const signed = (sig) => (sig ? SIGN[sig.sig] * sig.cv : null);

function buildRows(snapshots, prices) {
  const rows = [];
  for (const snap of snapshots) {
    const at = Date.parse(snap.generatedAt);
    const engine = engineOf(snap);
    for (const t of snap.tickers) {
      const row = {
        snapshot: snap.generatedAt,
        s: t.s,
        a: t.a,
        p: Number.isFinite(t.p) ? t.p : null,
        sig: { [engine]: t.jev?.sig ?? null, OpenAI: t.openai?.sig ?? null, Crowd: t.crowd?.sig ?? null },
        cv: { [engine]: t.jev?.cv ?? null, OpenAI: t.openai?.cv ?? null, Crowd: t.crowd?.cv ?? null },
        f: {
          [engine]: signed(t.jev),
          OpenAI: signed(t.openai),
          TradingView: t.crowd?.provider === "TradingView" ? signed(t.crowd) : null,
          "CoinGecko votes": t.crowd?.provider === "CoinGecko votes" ? signed(t.crowd) : null,
          "Regulatory flag": t.jev ? (t.jev.regulatoryFlag ? 1 : 0) : null,
          "Day change %": Number.isFinite(t.c) ? t.c : null,
          Sources: t.src?.length ?? null,
        },
        ret: {},
        excess: {},
        exit: {},
        toDateAt: null,
      };
      const px = prices.get(t.s);
      for (const h of HORIZONS) {
        let exit = null;
        if (px && Number.isFinite(t.p) && t.p > 0) {
          if (h.latest) {
            const last = latestExit(px, at);
            if (last) {
              exit = last.p;
              row.toDateAt = new Date(last.t).toISOString();
            }
          } else {
            exit = px.kind === "stock" ? stockExit(px.series, at, h.sessions) : coinExit(px.series, at, h.days);
          }
        }
        row.exit[h.label] = exit;
        row.ret[h.label] = exit === null ? null : (exit / t.p - 1) * 100;
      }
      rows.push(row);
    }
  }
  // Market-adjust: subtract the snapshot's asset-class average for each horizon.
  for (const h of HORIZONS) {
    const groups = new Map();
    for (const r of rows) {
      if (r.ret[h.label] === null) continue;
      const k = r.snapshot + "|" + r.a;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r.ret[h.label]);
    }
    for (const r of rows) {
      const g = groups.get(r.snapshot + "|" + r.a);
      r.excess[h.label] = r.ret[h.label] === null || !g || g.length < 3 ? null : r.ret[h.label] - mean(g);
    }
  }
  return rows;
}

// ---------- analysis ----------

function correlationMatrix(rows) {
  const featureNames = [...new Set(rows.flatMap((r) => Object.keys(r.f)))].filter((name) =>
    rows.some((r) => r.f[name] !== null),
  );
  const returnNames = HORIZONS.map((h) => h.label).filter((l) => rows.some((r) => r.excess[l] !== null));
  const cols = [
    ...featureNames.map((n) => ({ name: n, get: (r) => r.f[n] })),
    ...returnNames.map((l) => ({ name: `Fwd ${l} (mkt-adj)`, get: (r) => r.excess[l] })),
  ];
  const vals = cols.map((c) => rows.map((r) => c.get(r) ?? NaN));
  const cells = cols.map((_, i) => cols.map((_, j) => (i === j ? null : spearman(vals[i], vals[j]))));
  return { cols: cols.map((c) => c.name), cells, returnNames };
}

function hitRates(rows, returnNames) {
  const engines = [...new Set(rows.flatMap((r) => Object.keys(r.sig)))];
  const out = [];
  for (const e of engines) {
    for (const l of returnNames) {
      const judged = rows.filter((r) => r.sig[e] && r.excess[l] !== null);
      if (judged.length === 0) continue;
      const directional = judged.filter((r) => r.sig[e] !== "neu");
      const hits = directional.filter((r) => Math.sign(r.excess[l]) === SIGN[r.sig[e]]).length;
      const avg = (s) => mean(judged.filter((r) => r.sig[e] === s).map((r) => r.excess[l]));
      const count = (s) => judged.filter((r) => r.sig[e] === s).length;
      out.push({
        engine: e,
        horizon: l,
        n: directional.length,
        hitRate: directional.length ? hits / directional.length : null,
        bull: avg("bull"), nBull: count("bull"),
        neu: avg("neu"), nNeu: count("neu"),
        bear: avg("bear"), nBear: count("bear"),
      });
    }
  }
  return out;
}

// ---------- output ----------

const f2 = (x) => (x === null || x === undefined ? "—" : (x >= 0 ? "+" : "") + x.toFixed(2));
const pad = (s, n) => String(s).padStart(n);

function printMatrix({ cols, cells }) {
  const short = cols.map((c) => c.replace(" (mkt-adj)", "").replace("Fwd to date", "Fwd now").replace("CoinGecko votes", "CoinGecko").replace("Regulatory flag", "Regul.").replace("Day change %", "Day chg"));
  const w = 10;
  console.log("\nSpearman correlation (* = 95% interval excludes 0; n = pairs)\n");
  console.log(pad("", 13) + short.map((c) => pad(c.slice(0, w - 1), w)).join(""));
  cells.forEach((row, i) => {
    console.log(
      short[i].slice(0, 12).padEnd(13) +
        row.map((c) => pad(c === null ? "·" : f2(c.r) + (c.lo > 0 || c.hi < 0 ? "*" : " "), w)).join(""),
    );
  });
}

function printHits(hits) {
  console.log("\nSignal vs market-adjusted forward return (% points)\n");
  console.log("Engine".padEnd(12) + pad("Horizon", 8) + pad("n", 5) + pad("Hit rate", 10) + pad("Bull avg", 10) + pad("Neu avg", 10) + pad("Bear avg", 10) + pad("Bull−Bear", 11));
  for (const h of hits) {
    const spread = h.bull !== null && h.bear !== null ? h.bull - h.bear : null;
    console.log(
      h.engine.padEnd(12) + pad(h.horizon, 8) + pad(h.n, 5) +
        pad(h.hitRate === null ? "—" : (h.hitRate * 100).toFixed(0) + "%", 10) +
        pad(f2(h.bull), 10) + pad(f2(h.neu), 10) + pad(f2(h.bear), 10) + pad(f2(spread), 11),
    );
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function html({ cols, cells }, hits, snapshots, rows) {
  const color = (r) => {
    const a = Math.min(1, Math.abs(r));
    return r >= 0 ? `rgba(31,122,77,${a * 0.85})` : `rgba(178,48,48,${a * 0.85})`;
  };
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = cells
    .map((row, i) =>
      `<tr><th>${esc(cols[i])}</th>` +
      row.map((c) => c === null
        ? '<td class="diag"></td>'
        : `<td style="background:${color(c.r)}" title="n=${c.n}, 95% CI ${c.lo.toFixed(2)} to ${c.hi.toFixed(2)}">${c.r.toFixed(2)}${c.lo > 0 || c.hi < 0 ? "*" : ""}<small>n=${c.n}</small></td>`).join("") +
      "</tr>")
    .join("");
  const hitRows = hits
    .map((h) => `<tr><td>${esc(h.engine)}</td><td>${h.horizon}</td><td>${h.n}</td><td>${h.hitRate === null ? "—" : (h.hitRate * 100).toFixed(0) + "%"}</td>` +
      `<td>${f2(h.bull)} <small>(${h.nBull})</small></td><td>${f2(h.neu)} <small>(${h.nNeu})</small></td><td>${f2(h.bear)} <small>(${h.nBear})</small></td>` +
      `<td>${h.bull !== null && h.bear !== null ? f2(h.bull - h.bear) : "—"}</td></tr>`)
    .join("");
  const withRet = rows.filter((r) => Object.values(r.excess).some((v) => v !== null)).length;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signals Backtest</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6860;--line:#e4e1d8}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#9a978e;--line:#33322e}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:1100px;margin:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}p{color:var(--muted);max-width:75ch}
.wrap{overflow-x:auto}table{border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:center;white-space:nowrap}th{font-weight:600;font-size:12px}
td small{display:block;font-size:10px;opacity:.75}td.diag{background:var(--line)}
.hits td{text-align:right}.hits td:first-child{text-align:left}
</style></head><body>
<h1>Signals backtest</h1>
<p>${snapshots.length} snapshot(s): ${snapshots.map((s) => esc(s.generatedAt.slice(0, 16).replace("T", " ")) + " UTC (" + esc(engineOf(s)) + ")").join(", ")}. ${withRet} ticker-snapshots have at least one forward return.
Signals are signed: bullish = +conviction, bearish = −conviction, neutral = 0. Forward returns are measured from the price at signal time and market-adjusted (minus the stock or crypto average over the same window).</p>
<h2>Spearman correlation</h2>
<p>Green = move together, red = opposite. * = the 95% interval excludes zero. Hover a cell for n and its interval. Tickers in the same sector move together, so the real uncertainty is wider than these intervals, and with one snapshot every column is a single market episode.</p>
<div class="wrap"><table><tr><th></th>${head}</tr>${body}</table></div>
<h2>Signal vs what happened next</h2>
<p>Hit rate: share of bullish/bearish calls whose market-adjusted return had the same sign (50% = coin flip; neutral calls excluded). Averages are market-adjusted % returns after each kind of call, with counts in brackets.</p>
<div class="wrap"><table class="hits"><tr><th>Engine</th><th>Horizon</th><th>n</th><th>Hit rate</th><th>Bull avg</th><th>Neutral avg</th><th>Bear avg</th><th>Bull − Bear</th></tr>${hitRows}</table></div>
</body></html>`;
}

// ---------- main ----------

const snapshots = await loadSnapshots();
if (snapshots.length === 0) {
  console.error("[backtest] No snapshots found. Run `npm run pipeline` first.");
  process.exit(1);
}
console.log(`[backtest] ${snapshots.length} snapshot(s): ${snapshots.map((s) => `${s.generatedAt} (${engineOf(s)})`).join(", ")}`);

const prices = await fetchPrices(snapshots);
const rows = buildRows(snapshots, prices);
const matrix = correlationMatrix(rows);
if (matrix.returnNames.length === 0) {
  console.log("\n[backtest] No forward returns yet — the snapshots are too recent. Run the pipeline regularly and try again in a few days.");
}
printMatrix(matrix);
const hits = hitRates(rows, matrix.returnNames);
printHits(hits);
console.log(
  "\nRead with care: with one or two snapshots each column is a single market episode, and tickers in the\n" +
    "same sector move together, so treat * as 'worth watching', not proof. More snapshots → more trustworthy.",
);

const snapshotMeta = snapshots.map((s) => ({ generatedAt: s.generatedAt, engine: engineOf(s), jevEngine: s.jevEngine ?? null }));
await writeFile(
  join(DATA_DIR, "backtest.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), horizons: HORIZONS.map((h) => h.label), snapshots: snapshotMeta, rows, matrix, hits }),
);
await writeFile(join(DATA_DIR, "backtest.html"), html(matrix, hits, snapshots, rows));
console.log("\n[backtest] Wrote data/backtest.html (open it in a browser) and data/backtest.json.");
