// Small statistics helpers. All of them tolerate empty input by returning 0/null
// rather than NaN, so the analytics layer never leaks NaN into the API.

export function sum(values) {
  let total = 0;
  for (const v of values) total += Number(v) || 0;
  return total;
}

export function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].map(Number).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1));
}

/** Coefficient of variation — how erratic a series is, independent of scale. */
export function cv(values) {
  const m = mean(values);
  if (!m) return 0;
  return stdev(values) / Math.abs(m);
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].map(Number).sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Median absolute deviation — an outlier-resistant spread measure. */
export function mad(values) {
  if (!values.length) return 0;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * Robust z-score. Uses MAD (scaled to be comparable with a standard deviation)
 * so that a single freak day does not hide the next one. Falls back to the
 * classic z-score when MAD collapses to zero on very flat series.
 */
export function robustZ(value, values) {
  if (values.length < 4) return 0;
  const m = median(values);
  const scale = mad(values) * 1.4826;
  if (scale > 1e-9) return (value - m) / scale;
  const sd = stdev(values);
  return sd > 1e-9 ? (value - mean(values)) / sd : 0;
}

/**
 * Spread as a fraction of the typical value, using the same outlier-resistant
 * scale as robustZ. Near zero means the series is essentially constant — at
 * which point a z-score carries no information and any real change matters.
 */
export function relativeSpread(values) {
  if (values.length < 2) return null;
  const centre = Math.abs(median(values));
  if (centre < 1e-9) return null;
  const scale = mad(values) * 1.4826 || stdev(values);
  return scale / centre;
}

/** Percentage change from a to b, null when the base is zero. */
export function pctChange(a, b) {
  if (!a) return b ? null : 0;
  return ((b - a) / Math.abs(a)) * 100;
}

/** Least-squares slope of y over its own index — the per-step trend. */
export function slope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (values[i] - ym);
    den += (i - xm) ** 2;
  }
  return den ? num / den : 0;
}

export function round(value, places = 2) {
  const f = 10 ** places;
  return Math.round((Number(value) || 0) * f) / f;
}
