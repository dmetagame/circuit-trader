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
 * Trust Wallet Agent Kit adapter — maps the execution port onto the MCP tools exposed by
 * `twak serve` (verified against @trustwallet/cli v0.19.1, 2026-06-16).
 *
 * The local `twak serve` process auto-binds the agent wallet and does HMAC signing, so we
 * pass NO wallet address and NO chainId number — TWAK uses chain KEYS ("bsc") and token
 * symbols/addresses. Amounts are denominated in the FROM token (not USD), so USD sizing is
 * converted via `get_token_price`.
 *
 * VERIFIED read paths: get_swap_quote, get_token_price, check_token_risk.
 * ⚠️ PENDING a funded wallet to validate response shapes: `swap` (execution) and the
 *    holdings/portfolio aggregation — parsed defensively below; confirm with a tiny live swap
 *    before trusting drawdown accounting on mainnet.
 */

export interface TwakTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface TwakToolNames {
  quote: string;
  swap: string;
  tokenRisk: string;
  tokenPrice: string;
  holdings: string;
  nativeBalance: string;
}

export const DEFAULT_TOOL_NAMES: TwakToolNames = {
  quote: "get_swap_quote",
  swap: "swap",
  tokenRisk: "check_token_risk",
  tokenPrice: "get_token_price",
  holdings: "get_token_holdings",
  nativeBalance: "wallet_balance",
};

export interface TrustWalletWalletConfig {
  transport: TwakTransport;
  /** Chain key, e.g. "bsc". */
  chain?: string;
  /** Numeric chain id for the Wallet interface (BSC = 56). */
  chainId?: number;
  /** Stable reserve asset symbol positions exit into. */
  reserveAsset?: string;
  /** The chain's native symbol (risk-checkable by chain alone). */
  nativeSymbol?: string;
  /** Contract addresses for non-native allowlisted tokens (needed for per-token risk checks). */
  tokenAddresses?: Record<string, string>;
  toolNames?: Partial<TwakToolNames>;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const num = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const c = v.replace(/,/g, "").trim();
    if (c !== "" && Number.isFinite(Number(c))) return Number(c);
  }
  return fallback;
};
/** Parse the leading number out of strings like "0.00817101 BNB" or "5 USDT". */
const leadingNum = (v: unknown, fallback: number): number => {
  if (typeof v === "string") {
    const m = v.trim().match(/^[-+]?[\d.,]+/);
    if (m) return num(m[0], fallback);
  }
  return num(v, fallback);
};

function riskToScore(level: unknown, honeypot: unknown): number {
  if (honeypot === true) return 100;
  switch (String(level ?? "").toLowerCase()) {
    case "low":
      return 10;
    case "medium":
    case "moderate":
      return 55;
    case "high":
      return 85;
    case "critical":
      return 95;
    default:
      return 50; // unknown → treat as caution
  }
}

export class TrustWalletWallet implements Wallet {
  readonly chainId: number;
  readonly reserveAsset: string;
  private readonly t: TwakTransport;
  private readonly chain: string;
  private readonly nativeSymbol: string;
  private readonly tokenAddresses: Record<string, string>;
  private readonly tools: TwakToolNames;

  constructor(cfg: TrustWalletWalletConfig) {
    this.t = cfg.transport;
    this.chain = cfg.chain ?? "bsc";
    this.chainId = cfg.chainId ?? 56;
    this.reserveAsset = cfg.reserveAsset ?? "USDT";
    this.nativeSymbol = cfg.nativeSymbol ?? "BNB";
    this.tokenAddresses = cfg.tokenAddresses ?? {};
    this.tools = { ...DEFAULT_TOOL_NAMES, ...cfg.toolNames };
  }

  /** USD price for a symbol via get_token_price → { priceUsd }. */
  private async priceUsd(token: string): Promise<number> {
    const r = rec(await this.t.callTool(this.tools.tokenPrice, { chain: this.chain, token }));
    const p = num(r.priceUsd ?? r.price, NaN);
    if (Number.isNaN(p)) throw new Error(`no price for ${token} on ${this.chain}`);
    return p;
  }

  async getTokenRiskScore(asset: string): Promise<number> {
    // check_token_risk: { chain } for the native coin, or { chain, tokenAddress } for an ERC-20.
    const args: Record<string, unknown> = { chain: this.chain };
    if (asset !== this.nativeSymbol) {
      const addr = this.tokenAddresses[asset];
      if (!addr) throw new Error(`no contract address configured for ${asset} (needed for risk check)`);
      args.tokenAddress = addr;
    }
    const r = rec(await this.t.callTool(this.tools.tokenRisk, args));
    return riskToScore(r.riskLevel, r.isHoneypot);
  }

  async getQuote(req: QuoteRequest): Promise<QuoteResult> {
    const price = await this.priceUsd(req.asset);
    const { fromToken, toToken, amount } = this.legs(req.side, req.asset, req.sizeUsd, price);

    const r = rec(
      await this.t.callTool(this.tools.quote, {
        fromChain: this.chain,
        fromToken,
        toChain: this.chain,
        toToken,
        amount: String(amount),
      }),
    );
    // priceImpact is a percent string ("0", "0.35"); convert to bps.
    const expectedSlippageBps = Math.round(num(r.priceImpact, 0) * 100);
    return {
      expectedSlippageBps,
      quoteId: typeof r.quoteId === "string" ? r.quoteId : "",
      price,
    };
  }

  async executeSwap(order: SwapOrder, now: string): Promise<Fill> {
    const price = await this.priceUsd(order.asset);
    const { fromToken, toToken, amount } = this.legs(order.side, order.asset, order.sizeUsd, price);

    const r = rec(
      await this.t.callTool(this.tools.swap, {
        fromChain: this.chain,
        fromToken,
        toChain: this.chain,
        toToken,
        amount: String(amount),
        slippage: String(order.maxSlippageBps / 100), // tool wants percent
      }),
    );

    if (r.success === false) throw new Error(`swap failed: ${String(r.error ?? r.message ?? "unknown")}`);

    const slippageBps = r.priceImpact != null ? Math.round(num(r.priceImpact, 0) * 100) : order.maxSlippageBps;
    if (slippageBps > order.maxSlippageBps) throw new SlippageExceededError(slippageBps, order.maxSlippageBps);

    // Output amount is in the TO token; USD notional = output * (reserve≈$1 on buy→USD via price on sell).
    const outAmount = leadingNum(r.output, NaN);
    const filledUsd =
      order.side === "buy"
        ? order.sizeUsd // spent ~sizeUsd of the reserve stablecoin
        : !Number.isNaN(outAmount)
          ? outAmount // received reserve (stablecoin ≈ USD)
          : order.sizeUsd;

    return {
      asset: order.asset,
      side: order.side as TradeSide,
      filledUsd: Math.round(filledUsd * 100) / 100,
      price,
      slippageBps,
      txHash: String(r.txHash ?? r.transactionHash ?? r.hash ?? ""),
      executedAt: typeof r.executedAt === "string" ? r.executedAt : now,
    };
  }

  async getPortfolio(): Promise<Portfolio> {
    // Aggregate the bound wallet's holdings into USD. Shapes vary by chain; parse defensively.
    const r = rec(await this.t.callTool(this.tools.holdings, { chain: this.chain }));
    const tokens = Array.isArray(r.tokens) ? r.tokens : [];

    let reserveUsd = 0;
    const positions: Record<string, number> = {};
    for (const row of tokens) {
      const tk = rec(row);
      const symbol = String(tk.symbol ?? tk.token ?? "");
      if (!symbol) continue;
      const usd = num(tk.valueUsd ?? tk.usdValue ?? tk.balanceUsd, NaN);
      const value = !Number.isNaN(usd) ? usd : num(tk.balance ?? tk.amount, 0) * num(tk.priceUsd, 0);
      if (symbol === this.reserveAsset) reserveUsd += value;
      else if (value > 0) positions[symbol] = (positions[symbol] ?? 0) + value;
    }

    const positionsUsd = Object.values(positions).reduce((a, b) => a + b, 0);
    return { reserveUsd, positions, equityUsd: reserveUsd + positionsUsd };
  }

  /** Map (side, asset, sizeUsd) → swap legs. Buy: reserve→asset (amount in reserve≈USD). Sell: asset→reserve (amount in asset units). */
  private legs(side: TradeSide, asset: string, sizeUsd: number, price: number): { fromToken: string; toToken: string; amount: number } {
    if (side === "buy") return { fromToken: this.reserveAsset, toToken: asset, amount: round6(sizeUsd) };
    return { fromToken: asset, toToken: this.reserveAsset, amount: round6(sizeUsd / price) };
  }
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
