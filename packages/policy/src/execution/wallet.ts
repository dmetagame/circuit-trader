import type { TradeSide } from "../types.js";

/**
 * The execution port. Everything above it (strategy, policy engine, orchestrator)
 * depends only on this interface — never on Trust Wallet specifics. Swap in the
 * SimulatedWallet for tests / paper-trading, or the Trust Wallet Agent Kit adapter
 * for real BNB-chain settlement, without touching the rest of the system.
 */

export interface QuoteRequest {
  asset: string;
  side: TradeSide;
  sizeUsd: number;
}

export interface QuoteResult {
  /** Expected slippage for this quote, in basis points. Feeds the strategy's proposal. */
  expectedSlippageBps: number;
  quoteId: string;
  /** Asset price in USD at quote time. */
  price: number;
}

export interface SwapOrder {
  asset: string;
  side: TradeSide;
  sizeUsd: number;
  /** Execution-level slippage guard (from the constitution). Fill must not exceed this. */
  maxSlippageBps: number;
  quoteId?: string;
}

export interface Fill {
  asset: string;
  side: TradeSide;
  /** USD notional actually transacted (spent on buy, received on sell). */
  filledUsd: number;
  /** Effective execution price in USD (after slippage). */
  price: number;
  slippageBps: number;
  txHash: string;
  executedAt: string;
}

export interface Portfolio {
  reserveUsd: number;
  /** asset -> position value in USD. */
  positions: Record<string, number>;
  equityUsd: number;
}

export interface Wallet {
  readonly chainId: number;
  readonly reserveAsset: string;
  /** Trust Wallet token risk score, 0..100 (higher = riskier). */
  getTokenRiskScore(asset: string): Promise<number>;
  getQuote(req: QuoteRequest): Promise<QuoteResult>;
  /** Execute the swap. The implementation must pass `maxSlippageBps` to the settlement layer. */
  executeSwap(order: SwapOrder, now: string): Promise<Fill>;
  getPortfolio(): Promise<Portfolio>;
}

/** A wallet error that guarantees no transaction was submitted. */
export class ExecutionRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutionRejectedError";
  }
}

/** Raised when a fill would exceed the constitution's slippage cap. */
export class SlippageExceededError extends ExecutionRejectedError {
  constructor(
    readonly observedBps: number,
    readonly maxBps: number,
  ) {
    super(`slippage ${observedBps}bps exceeds cap ${maxBps}bps`);
    this.name = "SlippageExceededError";
  }
}
