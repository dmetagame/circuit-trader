import type { TradeProposal } from "../types.js";
import { generateSignal, type Signal, type StrategyConfig } from "./signals.js";
import { deterministicSynthesizer, type Synthesizer, type Verdict } from "./synthesizer.js";

/** Market data for one asset. `closes` are ordered oldest -> newest. */
export interface AssetMarketData {
  asset: string;
  closes: number[];
  fundingRatePct?: number;
  narrativeScore?: number;
  volumeChangePct?: number;
  /** Trust Wallet token risk score, 0..100. */
  tokenRiskScore: number;
}

export interface SizingConfig {
  /** USD size at full conviction (strength = 1.0). The policy engine clamps to limits. */
  baseTradeUsd: number;
  /** Below this deterministic strength, don't even propose. */
  minStrengthToTrade: number;
}

/** A pre-trade quote (from Trust Wallet Agent Kit) carrying expected execution quality. */
export interface Quote {
  expectedSlippageBps: number;
  quoteId?: string;
}

/** Soft context the synthesizer weighs (the slow-moving CMC signals). */
export interface SoftSignals {
  fundingRatePct?: number;
  narrativeScore?: number;
  volumeChangePct?: number;
}

export interface StrategyOutput {
  signal: Signal;
  verdict: Verdict | null;
  /** Ready for the policy engine; `null` when the strategy chose not to trade. */
  proposal: TradeProposal | null;
  note: string;
}

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export interface BuildProposalArgs {
  /** The already-decided signal (from closes or precomputed indicators). */
  signal: Signal;
  asset: string;
  tokenRiskScore: number;
  soft?: SoftSignals;
  sizing: SizingConfig;
  synthesizer?: Synthesizer;
  now: string;
  quote?: Quote;
  disagreementConfidenceCap?: number;
}

/**
 * Turn a decided signal into a sized, vetted proposal — the half of the pipeline shared by
 * the closes path and the precomputed-indicator (live CMC) path.
 *
 * The signal owns the direction. The synthesizer can confirm or VETO: if it disagrees with
 * the signal's direction, confidence is capped low so the policy engine's `minSignalConfidence`
 * gate denies the trade. The LLM can never flip a trade.
 */
export async function buildProposalFromSignal({
  signal,
  asset,
  tokenRiskScore,
  soft = {},
  sizing,
  synthesizer = deterministicSynthesizer,
  now,
  quote,
  disagreementConfidenceCap = 0.25,
}: BuildProposalArgs): Promise<StrategyOutput> {
  if (signal.action === "hold") {
    return { signal, verdict: null, proposal: null, note: `no trade: ${signal.reason}` };
  }
  if (signal.strength < sizing.minStrengthToTrade) {
    return {
      signal,
      verdict: null,
      proposal: null,
      note: `no trade: strength ${signal.strength.toFixed(2)} < min ${sizing.minStrengthToTrade}`,
    };
  }

  const verdict = await synthesizer.synthesize({
    asset,
    signal,
    context: {
      fundingRatePct: soft.fundingRatePct,
      narrativeScore: soft.narrativeScore,
      volumeChangePct: soft.volumeChangePct,
      tokenRiskScore,
    },
  });

  const agrees = verdict.recommendedAction === signal.action;
  const confidence = agrees ? verdict.confidence : Math.min(verdict.confidence, disagreementConfidenceCap);

  const proposal: TradeProposal = {
    asset,
    side: signal.action, // "buy" | "sell" (hold already returned)
    sizeUsd: round(sizing.baseTradeUsd * signal.strength, 2),
    expectedSlippageBps: quote?.expectedSlippageBps ?? 0,
    signalConfidence: round(confidence, 4),
    tokenRiskScore,
    rationale: `${verdict.rationale} | signal: ${signal.reason}`,
    proposedAt: now,
    ...(quote?.quoteId ? { quoteId: quote.quoteId } : {}),
  };

  const note = agrees
    ? `proposing ${signal.action} (verdict confirmed)`
    : `LLM vetoed: recommended ${verdict.recommendedAction} vs signal ${signal.action} → confidence capped at ${confidence}`;

  return { signal, verdict, proposal, note };
}

export interface ProposeArgs {
  market: AssetMarketData;
  strategy: StrategyConfig;
  sizing: SizingConfig;
  /** Defaults to the no-LLM deterministic synthesizer. */
  synthesizer?: Synthesizer;
  now: string;
  quote?: Quote;
  /** Confidence ceiling applied when the LLM disagrees with the signal (veto, not override). */
  disagreementConfidenceCap?: number;
}

/**
 * Convenience: run the closes-based pipeline end to end for one asset
 * (generateSignal → buildProposalFromSignal). The orchestrator and live path call
 * `buildProposalFromSignal` directly with a signal from whatever source.
 */
export async function proposeTrade({
  market,
  strategy,
  sizing,
  synthesizer,
  now,
  quote,
  disagreementConfidenceCap,
}: ProposeArgs): Promise<StrategyOutput> {
  const signal = generateSignal(market.closes, strategy, market.asset);
  return buildProposalFromSignal({
    signal,
    asset: market.asset,
    tokenRiskScore: market.tokenRiskScore,
    soft: { fundingRatePct: market.fundingRatePct, narrativeScore: market.narrativeScore, volumeChangePct: market.volumeChangePct },
    sizing,
    ...(synthesizer ? { synthesizer } : {}),
    now,
    ...(quote ? { quote } : {}),
    ...(disagreementConfidenceCap != null ? { disagreementConfidenceCap } : {}),
  });
}
