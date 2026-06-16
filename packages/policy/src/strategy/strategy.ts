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

/**
 * Run the full strategy pipeline for one asset:
 *   deterministic signal -> LLM/heuristic verdict -> sized TradeProposal.
 *
 * The signal owns the direction. The synthesizer can confirm or VETO: if it disagrees
 * with the signal's direction, confidence is capped low so the policy engine's
 * `minSignalConfidence` gate denies the trade. The LLM can never flip a trade.
 */
export async function proposeTrade({
  market,
  strategy,
  sizing,
  synthesizer = deterministicSynthesizer,
  now,
  quote,
  disagreementConfidenceCap = 0.25,
}: ProposeArgs): Promise<StrategyOutput> {
  const signal = generateSignal(market.closes, strategy, market.asset);

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
    asset: market.asset,
    signal,
    context: {
      fundingRatePct: market.fundingRatePct,
      narrativeScore: market.narrativeScore,
      volumeChangePct: market.volumeChangePct,
      tokenRiskScore: market.tokenRiskScore,
    },
  });

  const agrees = verdict.recommendedAction === signal.action;
  const confidence = agrees ? verdict.confidence : Math.min(verdict.confidence, disagreementConfidenceCap);

  const proposal: TradeProposal = {
    asset: market.asset,
    side: signal.action, // "buy" | "sell" (hold already returned)
    sizeUsd: round(sizing.baseTradeUsd * signal.strength, 2),
    expectedSlippageBps: quote?.expectedSlippageBps ?? 0,
    signalConfidence: round(confidence, 4),
    tokenRiskScore: market.tokenRiskScore,
    rationale: `${verdict.rationale} | signal: ${signal.reason}`,
    proposedAt: now,
    ...(quote?.quoteId ? { quoteId: quote.quoteId } : {}),
  };

  const note = agrees
    ? `proposing ${signal.action} (verdict confirmed)`
    : `LLM vetoed: recommended ${verdict.recommendedAction} vs signal ${signal.action} → confidence capped at ${confidence}`;

  return { signal, verdict, proposal, note };
}
