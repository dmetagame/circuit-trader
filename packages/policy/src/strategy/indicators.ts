/**
 * Pure technical indicators. All take a `closes` array ordered oldest -> newest and
 * operate on the trailing window. No external deps, no state — deterministic by design.
 */

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation. */
export function stddev(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function last(xs: number[]): number {
  return xs[xs.length - 1] as number;
}

/** Simple moving average over the last `period` closes. */
export function sma(closes: number[], period: number): number {
  return mean(closes.slice(-period));
}

/** Rate of change (%) between the latest close and the close `period` bars ago. */
export function roc(closes: number[], period: number): number {
  const nowVal = last(closes);
  const thenVal = closes[closes.length - 1 - period] as number;
  if (thenVal === 0) return 0;
  return ((nowVal - thenVal) / thenVal) * 100;
}

/**
 * RSI (Cutler's variant — simple averages over the last `period` deltas). Deterministic
 * and sufficient for a hackathon strategy. Returns 0..100; 50 when there is no movement.
 */
export function rsi(closes: number[], period: number): number {
  const window = closes.slice(-(period + 1));
  if (window.length < 2) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < window.length; i++) {
    const delta = (window[i] as number) - (window[i - 1] as number);
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Z-score of the latest close vs the trailing `period` window. 0 when the window is flat. */
export function zscore(closes: number[], period: number): number {
  const window = closes.slice(-period);
  const sd = stddev(window);
  if (sd === 0) return 0;
  return (last(closes) - mean(window)) / sd;
}
