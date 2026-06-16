import { last, roc, rsi, sma, zscore } from "./indicators.js";

/** How the deterministic strategy generates signals. Separate from the risk constitution. */
export interface StrategyConfig {
  smaFastPeriod: number;
  smaSlowPeriod: number;
  rsiPeriod: number;
  rocPeriod: number;
  zscorePeriod: number;
  /** RSI at/above this is "overbought" → protective sell / blocks momentum entry. */
  rsiOverbought: number;
  /** RSI at/below this is "oversold" → enables a mean-reversion buy. */
  rsiOversold: number;
  /** Minimum ROC (%) to confirm a momentum entry. */
  rocBuyThresholdPct: number;
  /** Don't enter momentum buys when price is this many std-devs extended. */
  zscoreEntryMax: number;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  smaFastPeriod: 7,
  smaSlowPeriod: 25,
  rsiPeriod: 14,
  rocPeriod: 7,
  zscorePeriod: 20,
  rsiOverbought: 70,
  rsiOversold: 30,
  rocBuyThresholdPct: 1,
  zscoreEntryMax: 2.5,
};

export type SignalAction = "buy" | "sell" | "hold";

export interface SignalIndicators {
  smaFast: number;
  smaSlow: number;
  rsi: number;
  roc: number;
  zscore: number;
}

export interface Signal {
  asset: string;
  action: SignalAction;
  /** 0..1 deterministic conviction. */
  strength: number;
  reason: string;
  indicators: SignalIndicators | null;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Deterministic momentum + mean-reversion strategy.
 *
 * - SELL (protective, takes priority): trend breaks down OR RSI overbought.
 * - BUY (momentum): uptrend + ROC confirmation + not overbought + not over-extended.
 * - BUY (mean-reversion): oversold and turning up.
 * - HOLD otherwise.
 *
 * Direction is decided here; the LLM downstream can only confirm or veto it.
 */
export function generateSignal(closes: number[], cfg: StrategyConfig, asset: string): Signal {
  const need = Math.max(cfg.smaSlowPeriod, cfg.rsiPeriod + 1, cfg.rocPeriod + 1, cfg.zscorePeriod, 2);
  if (closes.length < need) {
    return { asset, action: "hold", strength: 0, reason: `insufficient data (<${need} closes)`, indicators: null };
  }

  const smaFast = sma(closes, cfg.smaFastPeriod);
  const smaSlow = sma(closes, cfg.smaSlowPeriod);
  const rsiVal = rsi(closes, cfg.rsiPeriod);
  const rocVal = roc(closes, cfg.rocPeriod);
  const z = zscore(closes, cfg.zscorePeriod);
  const indicators: SignalIndicators = { smaFast, smaSlow, rsi: rsiVal, roc: rocVal, zscore: z };

  const gap = smaSlow !== 0 ? (smaFast - smaSlow) / smaSlow : 0; // signed crossover gap
  const trendUp = smaFast > smaSlow;
  const trendDown = smaFast < smaSlow;
  const overbought = rsiVal >= cfg.rsiOverbought;
  const oversold = rsiVal <= cfg.rsiOversold;
  const turningUp = last(closes) > (closes[closes.length - 2] as number);

  const momentumBuy = trendUp && rocVal >= cfg.rocBuyThresholdPct && !overbought && z <= cfg.zscoreEntryMax;
  const meanRevBuy = oversold && turningUp;
  const sell = trendDown || overbought;

  const reasons: string[] = [];

  if (sell) {
    const obStr = overbought ? (rsiVal - cfg.rsiOverbought) / (100 - cfg.rsiOverbought) : 0;
    const trStr = trendDown ? clamp01(-gap / 0.05) : 0;
    if (overbought) reasons.push(`RSI ${rsiVal.toFixed(1)} >= overbought ${cfg.rsiOverbought}`);
    if (trendDown) reasons.push(`SMA${cfg.smaFastPeriod} below SMA${cfg.smaSlowPeriod} (trend down)`);
    return { asset, action: "sell", strength: clamp01(Math.max(obStr, trStr)), reason: reasons.join("; "), indicators };
  }

  if (momentumBuy || meanRevBuy) {
    let strength = 0;
    if (momentumBuy) {
      const r = clamp01(rocVal / (cfg.rocBuyThresholdPct * 3));
      const g = clamp01(gap / 0.05);
      strength = Math.max(strength, clamp01(0.6 * r + 0.4 * g));
      reasons.push(`momentum: ROC ${rocVal.toFixed(2)}%, SMA${cfg.smaFastPeriod}>SMA${cfg.smaSlowPeriod}`);
    }
    if (meanRevBuy) {
      const depth = clamp01((cfg.rsiOversold - rsiVal) / cfg.rsiOversold);
      strength = Math.max(strength, clamp01(0.5 + 0.5 * depth));
      reasons.push(`mean-reversion: RSI ${rsiVal.toFixed(1)} oversold & turning up`);
    }
    return { asset, action: "buy", strength, reason: reasons.join("; "), indicators };
  }

  return { asset, action: "hold", strength: 0, reason: "no entry/exit condition met", indicators };
}
