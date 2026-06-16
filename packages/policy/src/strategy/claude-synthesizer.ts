import Anthropic from "@anthropic-ai/sdk";
import type { RiskLevel, Synthesizer, SynthInput, Verdict } from "./synthesizer.js";

/**
 * Claude (Opus 4.8) synthesizer. The LLM is a RISK REVIEWER, not a trader: it may only
 * confirm the deterministic signal or veto it (recommend "hold" and/or lower confidence).
 * It cannot originate a different trade — the orchestrator enforces that too.
 *
 * Uses structured outputs (`output_config.format`) so the verdict is machine-readable
 * and auditable. JSON schema is hand-written to stay decoupled from the zod version.
 */

const VERDICT_FORMAT = {
  type: "json_schema",
  name: "verdict",
  schema: {
    type: "object",
    properties: {
      recommended_action: { type: "string", enum: ["buy", "sell", "hold"] },
      confidence: { type: "number" },
      risk_level: { type: "string", enum: ["low", "medium", "high"] },
      reasoning: { type: "string" },
    },
    required: ["recommended_action", "confidence", "risk_level", "reasoning"],
    additionalProperties: false,
  },
} as const;

const SYSTEM = `You are the risk reviewer for an autonomous crypto trading agent on BNB Chain.

A deterministic strategy has already produced a trade SIGNAL from price action. Your job is NOT to invent trades. You may only:
- CONFIRM the signal (recommended_action == the signal's action) with a confidence reflecting how well the soft context supports it, or
- VETO it (recommended_action = "hold", or a low confidence) when momentum/derivatives/narrative/token-risk context argues against acting.

Weigh: CMC trending-narrative sentiment, derivatives funding (crowded positioning), volume shifts, and the Trust Wallet token risk score. Higher token risk and crowded funding should lower confidence. Be conservative: when uncertain, lower confidence rather than confirming. Keep reasoning to 1-2 sentences.`;

const VETO_FALLBACK: Verdict = {
  recommendedAction: "hold",
  confidence: 0,
  riskLevel: "high",
  rationale: "LLM verdict unavailable; defaulting to no-trade.",
};

export interface ClaudeSynthesizerOptions {
  client?: Anthropic;
  model?: string;
  maxTokens?: number;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const isAction = (s: unknown): s is "buy" | "sell" | "hold" => s === "buy" || s === "sell" || s === "hold";
const isRisk = (s: unknown): s is RiskLevel => s === "low" || s === "medium" || s === "high";

export function claudeSynthesizer(opts: ClaudeSynthesizerOptions = {}): Synthesizer {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? "claude-opus-4-8";
  const maxTokens = opts.maxTokens ?? 1024;

  return {
    async synthesize({ asset, signal, context }: SynthInput): Promise<Verdict> {
      const prompt = [
        `Asset: ${asset}`,
        `Deterministic signal: ${signal.action} (strength ${signal.strength.toFixed(2)})`,
        `Signal reason: ${signal.reason}`,
        `Indicators: ${JSON.stringify(signal.indicators)}`,
        `Soft context: ${JSON.stringify(context)}`,
        ``,
        `Confirm or veto this signal.`,
      ].join("\n");

      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: VERDICT_FORMAT },
      });

      if (res.stop_reason === "refusal") return VETO_FALLBACK;
      const textBlock = res.content.find((b: Anthropic.ContentBlock) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") return VETO_FALLBACK;

      let parsed: unknown;
      try {
        parsed = JSON.parse(textBlock.text);
      } catch {
        return VETO_FALLBACK;
      }

      const v = parsed as Record<string, unknown>;
      if (!isAction(v.recommended_action) || !isRisk(v.risk_level) || typeof v.reasoning !== "string") {
        return VETO_FALLBACK;
      }

      return {
        recommendedAction: v.recommended_action,
        confidence: clamp01(typeof v.confidence === "number" ? v.confidence : 0),
        riskLevel: v.risk_level,
        rationale: v.reasoning,
      };
    },
  };
}
