import type { TradeSide } from "../types.js";
import {
  SlippageExceededError,
  type Fill,
  type Portfolio,
  type QuoteRequest,
  type QuoteResult,
  type SwapOrder,
  type Wallet,
} from "./wallet.js";

/**
 * Deterministic in-memory wallet. Tracks reserve in USD and positions in token UNITS,
 * so a price move drives equity/drawdown realistically — exactly what powers the
 * luck-proof demo (`setPrice()` to trigger a drawdown on cue) and offline paper-trading.
 */
export interface SimulatedWalletOptions {
  chainId?: number;
  reserveAsset?: string;
  reserveUsd: number;
  /** asset -> USD price. */
  prices: Record<string, number>;
  /** asset -> token units already held (optional). */
  positionsUnits?: Record<string, number>;
  /** asset -> Trust Wallet risk score (0..100). Defaults to `defaultRiskScore`. */
  riskScores?: Record<string, number>;
  defaultRiskScore?: number;
  /** Slippage applied to every fill, in bps. */
  slippageBps?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class SimulatedWallet implements Wallet {
  readonly chainId: number;
  readonly reserveAsset: string;
  private reserveUsd: number;
  private prices: Record<string, number>;
  private units: Record<string, number>;
  private riskScores: Record<string, number>;
  private defaultRiskScore: number;
  private slippageBps: number;
  private nonce = 0;

  constructor(opts: SimulatedWalletOptions) {
    this.chainId = opts.chainId ?? 56;
    this.reserveAsset = opts.reserveAsset ?? "USDT";
    this.reserveUsd = opts.reserveUsd;
    this.prices = { ...opts.prices };
    this.units = { ...(opts.positionsUnits ?? {}) };
    this.riskScores = { ...(opts.riskScores ?? {}) };
    this.defaultRiskScore = opts.defaultRiskScore ?? 10;
    this.slippageBps = opts.slippageBps ?? 20;
  }

  /** Move the market — drives equity/drawdown. Use to trigger the demo's "circuit breaker" beat. */
  setPrice(asset: string, price: number): void {
    this.prices[asset] = price;
  }

  setSlippageBps(bps: number): void {
    this.slippageBps = bps;
  }

  private priceOf(asset: string): number {
    const p = this.prices[asset];
    if (p == null) throw new Error(`no price for ${asset}`);
    return p;
  }

  async getTokenRiskScore(asset: string): Promise<number> {
    return this.riskScores[asset] ?? this.defaultRiskScore;
  }

  async getQuote(req: QuoteRequest): Promise<QuoteResult> {
    return {
      expectedSlippageBps: this.slippageBps,
      quoteId: `sim-${req.asset}-${req.side}-${++this.nonce}`,
      price: this.priceOf(req.asset),
    };
  }

  async executeSwap(order: SwapOrder, now: string): Promise<Fill> {
    if (this.slippageBps > order.maxSlippageBps) {
      throw new SlippageExceededError(this.slippageBps, order.maxSlippageBps);
    }
    const mid = this.priceOf(order.asset);
    const slip = this.slippageBps / 10_000;
    const held = this.units[order.asset] ?? 0;

    let filledUsd: number;
    let effPrice: number;

    if (order.side === "buy") {
      effPrice = mid * (1 + slip); // pay up
      const spend = Math.min(order.sizeUsd, this.reserveUsd);
      const boughtUnits = spend / effPrice;
      this.reserveUsd -= spend;
      this.units[order.asset] = held + boughtUnits;
      filledUsd = spend;
    } else {
      effPrice = mid * (1 - slip); // receive less
      const wantUnits = order.sizeUsd / mid;
      const soldUnits = Math.min(wantUnits, held);
      const proceeds = soldUnits * effPrice;
      this.reserveUsd += proceeds;
      this.units[order.asset] = held - soldUnits;
      filledUsd = proceeds;
    }

    return {
      asset: order.asset,
      side: order.side as TradeSide,
      filledUsd: round2(filledUsd),
      price: round2(effPrice),
      slippageBps: this.slippageBps,
      txHash: fakeTxHash(`${order.asset}|${order.side}|${order.sizeUsd}|${now}|${this.nonce}`),
      executedAt: now,
    };
  }

  async getPortfolio(): Promise<Portfolio> {
    const positions: Record<string, number> = {};
    for (const [asset, u] of Object.entries(this.units)) {
      if (u > 0) positions[asset] = round2(u * this.priceOf(asset));
    }
    const positionsUsd = Object.values(positions).reduce((a, b) => a + b, 0);
    return {
      reserveUsd: round2(this.reserveUsd),
      positions,
      equityUsd: round2(this.reserveUsd + positionsUsd),
    };
  }
}

/** Deterministic pseudo tx hash for simulated fills (FNV-1a → padded hex). Not cryptographic. */
function fakeTxHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "0x" + (h >>> 0).toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}
