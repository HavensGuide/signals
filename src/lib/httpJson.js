const DEFAULT_TIMEOUT_MS = 10_000;

// Shared fetch wrapper: enforces a timeout (public APIs occasionally hang
// rather than error) and surfaces non-2xx responses as errors with the
// status attached, so callers can decide whether to skip a single ticker
// instead of crashing the whole pipeline run.
export async function fetchText(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, method, body });
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
}

// fetchJson, retried once after `waitMs` on a 429. For CoinGecko's keyless
// API, whose rate-limit window resets within about a minute.
export async function fetchJsonRetry429(url, opts, waitMs = 60_000) {
  try {
    return await fetchJson(url, opts);
  } catch (err) {
    if (err.status !== 429) throw err;
    console.warn(`[http] 429 from ${new URL(url).host}; retrying once in ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    return fetchJson(url, opts);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
