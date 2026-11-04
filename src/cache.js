import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_PATH } from "./config.js";

const path = fileURLToPath(CACHE_PATH);

export async function readCache() {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeCache(payload) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2));
  // Rename so readers never see a half-written file.
  await rename(tmpPath, path);
  await archiveSnapshot(payload);
}

// Every run is also kept as data/history/<generatedAt>.json — the dashboard
// only needs the latest, but a backtest (scripts/backtest.js) needs the
// signals as they were on each past date, before prices moved.
export const HISTORY_DIR = fileURLToPath(new URL("../data/history/", CACHE_PATH));

export function snapshotFileName(generatedAt) {
  // Colons aren't allowed in Windows file names.
  return generatedAt.replace(/\.\d+Z$/, "Z").replace(/:/g, "-") + ".json";
}

async function archiveSnapshot(payload) {
  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(join(HISTORY_DIR, snapshotFileName(payload.generatedAt)), JSON.stringify(payload));
}
