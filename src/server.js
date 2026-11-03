import express from "express";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { readCache, HISTORY_DIR } from "./cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const PORT = process.env.PORT || 3000;

const app = express();

// Read-only by design: this process never triggers the pipeline (which
// costs quota against TypeSafe and the free market/news APIs). Populate
// data/signals.json with `npm run pipeline`, on a schedule via cron.
app.get("/api/signals", async (_req, res) => {
  const cache = await readCache();
  if (!cache) {
    res.status(503).json({ error: "No signals yet. Run `npm run pipeline` to populate data/signals.json." });
    return;
  }
  res.json(cache);
});

// ---------- signal history (every saved pipeline run) ----------

const engineOf = (snap) => (String(snap.jevEngine || "").startsWith("JevK5") ? "JevK5" : "Jev");

// Snapshot files are a few hundred KB each, so parse each once and reuse it
// until its mtime changes.
const parsed = new Map(); // path -> { mtimeMs, snap }
async function loadSnap(path) {
  const { mtimeMs } = await stat(path);
  const hit = parsed.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.snap;
  const snap = JSON.parse(await readFile(path, "utf8"));
  parsed.set(path, { mtimeMs, snap });
  return snap;
}

// id -> path, one entry per distinct generatedAt (the same run can exist both
// in data/history/ and as data/signals.json).
async function historyIndex() {
  const byTime = new Map();
  let files = [];
  try {
    files = (await readdir(HISTORY_DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  for (const f of files) {
    try {
      const path = join(HISTORY_DIR, f);
      const snap = await loadSnap(path);
      if (snap?.generatedAt && !byTime.has(snap.generatedAt)) byTime.set(snap.generatedAt, { id: f.replace(/\.json$/, ""), path, snap });
    } catch (err) {
      console.warn(`[server] Skipping unreadable history file ${f}: ${err.message}`);
    }
  }
  try {
    const path = join(DATA_DIR, "signals.json");
    const snap = await loadSnap(path);
    if (snap?.generatedAt && !byTime.has(snap.generatedAt)) byTime.set(snap.generatedAt, { id: "current", path, snap });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return [...byTime.values()].sort((a, b) => a.snap.generatedAt.localeCompare(b.snap.generatedAt));
}

app.get("/api/history", async (_req, res, next) => {
  try {
    const list = (await historyIndex()).map(({ id, snap }) => {
      const counts = { bull: 0, neu: 0, bear: 0 };
      for (const t of snap.tickers ?? []) if (t.jev?.sig in counts) counts[t.jev.sig]++;
      return {
        id,
        generatedAt: snap.generatedAt,
        engine: engineOf(snap),
        jevEngine: snap.jevEngine ?? "TypeSafe/Jev",
        openaiEnabled: Boolean(snap.openaiEnabled),
        tickers: snap.tickers?.length ?? 0,
        counts,
      };
    });
    res.json(list);
  } catch (err) {
    next(err);
  }
});

app.get("/api/history/:id", async (req, res, next) => {
  try {
    // Only ids from the index are served, so the parameter never reaches the filesystem.
    const entry = (await historyIndex()).find((e) => e.id === req.params.id);
    if (!entry) {
      res.status(404).json({ error: "No such snapshot." });
      return;
    }
    res.json(entry.snap);
  } catch (err) {
    next(err);
  }
});

// ---------- backtest results + on-demand refresh ----------

app.get("/api/backtest", async (_req, res, next) => {
  try {
    res.type("json").send(await readFile(join(DATA_DIR, "backtest.json"), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      res.status(404).json({ error: "No backtest yet. Click “Refresh returns” or run `npm run backtest`." });
      return;
    }
    next(err);
  }
});

// The backtest only reads free price APIs (Yahoo, CoinGecko), so unlike the
// pipeline it is safe to start from the UI. One run at a time.
const job = { running: false, startedAt: null, finishedAt: null, exitCode: null, log: [] };
const pushLog = (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) job.log.push(line);
  if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
};

app.post("/api/backtest/run", (req, res) => {
  // Only this dashboard may start a run, not some other site open in the same browser.
  const origin = req.get("origin");
  if (origin && new URL(origin).host !== req.get("host")) {
    res.status(403).json({ error: "Cross-origin request refused." });
    return;
  }
  if (job.running) {
    res.status(409).json({ error: "A backtest is already running.", ...job });
    return;
  }
  Object.assign(job, { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, log: [] });
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "scripts/backtest.js"], { cwd: ROOT });
  child.stdout.on("data", pushLog);
  child.stderr.on("data", pushLog);
  const done = (code) => {
    if (!job.running) return;
    Object.assign(job, { running: false, finishedAt: new Date().toISOString(), exitCode: code });
  };
  child.on("error", (err) => {
    pushLog(`Failed to start backtest: ${err.message}`);
    done(-1);
  });
  child.on("close", done);
  res.status(202).json(job);
});

app.get("/api/backtest/status", (_req, res) => res.json(job));

app.use(express.static(join(ROOT, "public")));

app.listen(PORT, () => {
  console.log(`[server] Signals dashboard listening on http://localhost:${PORT}`);
  console.log(`[server] Performance view: http://localhost:${PORT}/performance.html`);
});
