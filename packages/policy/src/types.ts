import { z } from "zod";

/** A trade the strategy/LLM wants to make. The policy engine decides if it's allowed. */
export type TradeSide = "buy" | "sell"; // buy: reserve -> asset ; sell: asset -> reserve

export const TradeProposalSchema = z.object({
  asset: z.string().min(1).max(16).regex(/^[A-Z0-9]+$/),
  side: z.enum(["buy", "sell"]),
  sizeUsd: z.number().finite().positive(),
  expectedSlippageBps: z.number().finite().min(0).max(10_000),
  signalConfidence: z.number().finite().min(0).max(1),
  tokenRiskScore: z.number().finite().min(0).max(100),
  rationale: z.string(),
  proposedAt: z.string().datetime(),
  quoteId: z.string().min(1).optional(),
});

export interface TradeProposal extends z.infer<typeof TradeProposalSchema> {
  /** The non-reserve asset being entered/exited (e.g. "BNB"). */
  asset: string;
  side: TradeSide;
  /** Notional size in USD. */
  sizeUsd: number;
  /** Expected slippage for the quote, in basis points. */
  expectedSlippageBps: number;
  /** 0..1 confidence from the LLM's structured risk verdict. */
  signalConfidence: number;
  /** 0..100 token risk score from Trust Wallet (higher = riskier). */
  tokenRiskScore: number;
  /** Plain-English rationale from the LLM (for the audit trail / dashboard). */
  rationale: string;
  /** ISO timestamp the proposal was created. */
  proposedAt: string;
  /** Optional opaque quote id from Trust Wallet Agent Kit. */
  quoteId?: string;
}

export type ViolationCode =
  | "INVALID_PROPOSAL"
  | "KILL_SWITCH" // manual master-off (state or constitution)
  | "CONSTITUTION_EXPIRED"
  | "DRAWDOWN_BREACH" // terminal
  | "DAILY_LOSS_BREACH"
  | "ASSET_NOT_ALLOWED"
  | "TOKEN_RISK_TOO_HIGH"
  | "CONFIDENCE_TOO_LOW"
  | "COOLDOWN_ACTIVE"
  | "MAX_TRADES_REACHED"
  | "MIN_INTERVAL"
  | "SLIPPAGE_TOO_HIGH"
  | "BELOW_MIN_TRADE"
  | "ABOVE_MAX_TRADE"
  | "CONCENTRATION_EXCEEDED"
  | "EXPOSURE_EXCEEDED"
  | "INSUFFICIENT_RESERVE"
  | "INSUFFICIENT_POSITION"
  | "NATIVE_GAS_RESERVE"
  | "UNCLAMPABLE"; // size can't be reduced enough to satisfy minTradeUsd

export interface Violation {
  code: ViolationCode;
  /** `terminal` violations instruct the caller to engage the kill switch permanently. */
  severity: "block" | "terminal";
  message: string;
  observed: number | string;
  limit: number | string;
}

export interface Adjustment {
  reason: ViolationCode;
  field: "sizeUsd";
  from: number;
  to: number;
}

export interface PolicyDecision {
  allowed: boolean;
  decisionId: string;
  evaluatedAt: string;
  /** The original, unmodified proposal. */
  proposal: TradeProposal;
  /** The proposal actually cleared for execution (possibly clamped). `null` when denied. */
  effectiveProposal: TradeProposal | null;
  violations: Violation[];
  adjustments: Adjustment[];
  /** Caller MUST persist a kill-switch engagement when true. */
  engageKillSwitch: boolean;
  killSwitchReason: string | null;
  /** Human-readable, ordered audit trail — drives the dashboard timeline. */
  audit: string[];
}
