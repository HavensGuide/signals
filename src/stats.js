// Small, dependency-free statistics for the backtest. Kept separate from
// scripts/backtest.js so the math can be checked on its own.

// Average ranks (1-based), ties sharing the mean of their positions.
export function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null; // a constant column has no correlation
  return sxy / Math.sqrt(sxx * syy);
}

// Spearman's rho over the pairs where both values are present.
// Returns { r, n, lo, hi } with a 95% Fisher-z interval, or null.
export function spearman(xs, ys) {
  const px = [];
  const py = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      px.push(xs[i]);
      py.push(ys[i]);
    }
  }
  const n = px.length;
  const r = pearson(ranks(px), ranks(py));
  if (r === null) return null;
  if (n < 4) return { r, n, lo: -1, hi: 1 };
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
  const se = 1 / Math.sqrt(n - 3);
  return { r, n, lo: Math.tanh(z - 1.96 * se), hi: Math.tanh(z + 1.96 * se) };
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
