import type { Signal, SignalAction } from "./signals.js";

export type RiskLevel = "low" | "medium" | "high";

/** Soft, slow-moving context — the CMC fields the LLM is good at weighing. */
export interface SoftContext {
  /** Derivatives funding rate (%). Large positive = crowded longs. */
  fundingRatePct?: number;
  /** -1..1 sentiment from CMC trending narratives / news. */
  narrativeScore?: number;
  /** 24h volume change (%). */
  volumeChangePct?: number;
  /** Trust Wallet token risk score, 0..100 (higher = riskier). */
  tokenRiskScore: number;
}

export interface SynthInput {
  asset: string;
  signal: Signal;
  context: SoftContext;
}

/** The LLM's (or fallback's) structured judgement on the deterministic signal. */
export interface Verdict {
  recommendedAction: SignalAction;
  confidence: number; // 0..1
  riskLevel: RiskLevel;
  rationale: string;
}

/** Pluggable verdict source. Default impl is deterministic so the pipeline runs without an API. */
export interface Synthesizer {
  synthesize(input: SynthInput): Promise<Verdict>;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

function riskFromScore(score: number): RiskLevel {
  if (score < 25) return "low";
  if (score < 50) return "medium";
  return "high";
}

/**
 * Deterministic synthesizer — no LLM. Confirms the signal's direction and derives
 * confidence from conviction nudged by soft context. Use as the default and as a
 * fallback when the LLM is unavailable. Never invents a different direction.
 */
export const deterministicSynthesizer: Synthesizer = {
  async synthesize({ signal, context }: SynthInput): Promise<Verdict> {
    let confidence = signal.strength;
    const notes: string[] = [signal.reason];

    if (context.narrativeScore != null) {
      const aligned =
        (signal.action === "buy" && context.narrativeScore > 0) ||
        (signal.action === "sell" && context.narrativeScore < 0);
      if (aligned) {
        confidence += 0.1 * Math.abs(context.narrativeScore);
        notes.push(`narrative aligned (${context.narrativeScore.toFixed(2)})`);
      } else if (context.narrativeScore !== 0) {
        confidence -= 0.05 * Math.abs(context.narrativeScore);
        notes.push(`narrative diverges (${context.narrativeScore.toFixed(2)})`);
      }
    }

    if (context.fundingRatePct != null && Math.abs(context.fundingRatePct) > 0.1) {
      confidence -= 0.05;
      notes.push(`extreme funding ${context.fundingRatePct.toFixed(3)}% (caution)`);
    }

    return {
      recommendedAction: signal.action,
      confidence: clamp01(confidence),
      riskLevel: riskFromScore(context.tokenRiskScore),
      rationale: notes.join("; "),
    };
  },
};
