/**
 * The statistics `aqa eval` reports (ADR-008 §7), written out so the numbers in
 * a report can be checked by hand.
 *
 * Three things, and no more: an interval for a rate, a paired test for two
 * arms over the same stories, and precision / recall for a set of values.
 */

export interface Rate {
  /** How many had the property. */
  k: number;
  /** Out of how many. */
  n: number;
  /** k / n, or null when n is 0: no cases is not a rate of zero. */
  rate: number | null;
  /** Wilson 95% interval, or null when n is 0. */
  low: number | null;
  high: number | null;
}

/** z for a two-sided 95% interval. */
const Z = 1.959963984540054;

/**
 * A rate with its Wilson score interval. Chosen over the plain ±1.96·se
 * interval because the evaluation has tens of cases, not thousands, and rates
 * near 0 and 1 — where the plain interval runs outside [0, 1] or collapses to
 * a point.
 *
 *   centre = (p + z²/2n) / (1 + z²/n)
 *   half   = z · sqrt(p(1−p)/n + z²/4n²) / (1 + z²/n)
 */
export function rate(k: number, n: number): Rate {
  if (n <= 0) return { k, n: 0, rate: null, low: null, high: null };
  const p = k / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    k,
    n,
    rate: p,
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}

/**
 * McNemar's exact test for paired outcomes: `helped` stories did better with
 * the feature on, `hurt` did worse; stories that did the same say nothing and
 * are left out. Under "no difference" a discordant story is as likely to fall
 * either way, so the two-sided p is the binomial tail, doubled:
 *
 *   p = min(1, 2 · Σ_{i ≤ min(b,c)} C(b+c, i) · 0.5^(b+c))
 *
 * With no discordant story there is nothing to test: p is 1.
 */
export function mcnemarExact(helped: number, hurt: number): number {
  const n = helped + hurt;
  if (n === 0) return 1;
  const m = Math.min(helped, hurt);
  let term = Math.pow(0.5, n);
  let tail = term;
  for (let i = 1; i <= m; i++) {
    term = (term * (n - i + 1)) / i;
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

export interface Prf {
  /** Found and right. */
  tp: number;
  /** Found, and not among the expected values. */
  fp: number;
  /** Expected, and not found. */
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

/** Precision, recall and F1; null where the denominator is zero. */
export function prf(tp: number, fp: number, fn: number): Prf {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : precision !== null && recall !== null
        ? 0
        : null;
  return { tp, fp, fn, precision, recall, f1 };
}

/** The mean of the numbers that are there; null when none are. */
export function mean(values: ReadonlyArray<number | null | undefined>): number | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
