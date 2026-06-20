import type { TradeSide } from "../types.js";
import {
  ExecutionRejectedError,
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
 * VERIFIED LIVE (funded BSC wallet, 2026-06-17): get_swap_quote, get_token_price,
 * check_token_risk, get_address, get_balance.
 *
 * Portfolio note: `get_token_holdings` returns `[]` unless the address is indexed by the
 * Trust Wallet backend (and that index lags), so it is NOT reliable for drawdown accounting.
 * We instead value the reserve + native + allowlisted tokens directly via `get_balance`,
 * which returns on-chain USD (`amounts.totalInFiat`) with no backend-index dependency.
 * ⚠️ STILL PENDING: `swap` (execution) response shape — confirm with a tiny live swap.
 */

export interface TwakTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface TwakToolNames {
  walletStatus: string;
  switchWalletMode: string;
  quote: string;
  swap: string;
  tokenRisk: string;
  tokenPrice: string;
  /** On-chain USD-valued balance for native or a given tokenAddress. */
  balance: string;
  /** Resolve the bound wallet's address for a chain. */
  address: string;
}

export const DEFAULT_TOOL_NAMES: TwakToolNames = {
  walletStatus: "get_wallet_status",
  switchWalletMode: "switch_wallet_mode",
  quote: "get_swap_quote",
  swap: "swap",
  tokenRisk: "check_token_risk",
  tokenPrice: "get_token_price",
  balance: "get_balance",
  address: "get_address",
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
  /** Bound wallet address. If omitted, resolved lazily via the `address` tool and cached. */
  address?: string;
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
  private readonly expectedAddress: string | null;
  private resolvedAddress: string | null = null;
  private walletModeReady = false;

  constructor(cfg: TrustWalletWalletConfig) {
    this.t = cfg.transport;
    this.chain = cfg.chain ?? "bsc";
    this.chainId = cfg.chainId ?? 56;
    this.reserveAsset = cfg.reserveAsset ?? "USDT";
    this.nativeSymbol = cfg.nativeSymbol ?? "BNB";
    this.tokenAddresses = cfg.tokenAddresses ?? {};
    this.tools = { ...DEFAULT_TOOL_NAMES, ...cfg.toolNames };
    this.expectedAddress = cfg.address ?? null;
  }

  /** Resolve (and cache) the bound wallet address for this chain. */
  private async boundAddress(): Promise<string> {
    await this.ensureWalletMode();
    if (this.resolvedAddress) return this.resolvedAddress;
    const r = rec(await this.t.callTool(this.tools.address, { chain: this.chain }));
    const a = String(r.address ?? "");
    if (!a) throw new Error(`could not resolve bound wallet address on ${this.chain}`);
    if (this.expectedAddress && a.toLowerCase() !== this.expectedAddress.toLowerCase()) {
      throw new Error(`bound TWAK wallet ${a} does not match configured wallet ${this.expectedAddress}`);
    }
    this.resolvedAddress = a;
    return a;
  }

  /**
   * TWAK may start in an explicit "unbound" session even when a local wallet exists.
   * Bind the local agent wallet once before any operation that needs a wallet address
   * or signing authority.
   */
  private async ensureWalletMode(): Promise<void> {
    if (this.walletModeReady) return;

    const before = rec(await this.t.callTool(this.tools.walletStatus, {}));
    const state = String(before.state ?? "");
    if (state === "local" || state === "wc-connected") {
      this.walletModeReady = true;
      return;
    }

    await this.t.callTool(this.tools.switchWalletMode, { mode: "local" });
    const after = rec(await this.t.callTool(this.tools.walletStatus, {}));
    const next = String(after.state ?? "");
    if (next !== "local" && next !== "wc-connected") {
      throw new Error(`wallet mode not bound after switch_wallet_mode: ${next || "unknown"}`);
    }
    this.walletModeReady = true;
  }

  /** On-chain USD value of a symbol's balance via get_balance → amounts.totalInFiat. */
  private async balanceUsd(asset: string, address: string): Promise<number> {
    const args: Record<string, unknown> = { chain: this.chain, address };
    if (asset !== this.nativeSymbol) {
      const addr = this.tokenAddresses[asset];
      if (!addr) return 0; // can't value an unknown token without its contract
      args.tokenAddress = addr;
    }
    const r = rec(await this.t.callTool(this.tools.balance, args));
    const amounts = rec(r.amounts);
    const value = num(amounts.totalInFiat ?? amounts.availableInFiat, NaN);
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid balance response for ${asset} on ${this.chain}`);
    return value;
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
    const priceImpact = num(r.priceImpact, NaN);
    if (!Number.isFinite(priceImpact) || priceImpact < 0) throw new Error(`quote missing valid price impact for ${req.asset}`);
    const expectedSlippageBps = Math.round(priceImpact * 100);
    return {
      expectedSlippageBps,
      quoteId: typeof r.quoteId === "string" ? r.quoteId : "",
      price,
    };
  }

  async executeSwap(order: SwapOrder, now: string): Promise<Fill> {
    let price: number;
    try {
      await this.boundAddress();
      price = await this.priceUsd(order.asset);
    } catch (error) {
      throw new ExecutionRejectedError("swap preparation failed before submission", { cause: error });
    }
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

    const txHash = String(r.txHash ?? r.transactionHash ?? r.hash ?? "");
    if (r.success === false) {
      if (/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw new Error("swap response reported failure with a transaction hash");
      throw new ExecutionRejectedError(`swap rejected: ${String(r.error ?? r.message ?? "unknown")}`);
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      throw new Error("swap response did not include a valid transaction hash");
    }

    // Output amount is in the TO token; USD notional = output * (reserve≈$1 on buy→USD via price on sell).
    const outAmount = leadingNum(r.output, NaN);

    // Prefer the tool's reported priceImpact; the live `swap` tool often omits it, so derive
    // realized slippage from the fill itself (expected vs actual output) rather than assuming the cap.
    let slippageBps: number;
    if (r.priceImpact != null) {
      slippageBps = Math.round(num(r.priceImpact, 0) * 100);
    } else {
      const expectedOut = order.side === "buy" ? order.sizeUsd / price : order.sizeUsd;
      slippageBps =
        !Number.isNaN(outAmount) && expectedOut > 0
          ? Math.max(0, Math.round((1 - outAmount / expectedOut) * 10_000))
          : order.maxSlippageBps;
    }
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
      txHash,
      executedAt: typeof r.executedAt === "string" ? r.executedAt : now,
    };
  }

  async getPortfolio(): Promise<Portfolio> {
    // Value the reserve + native + allowlisted tokens directly on-chain via get_balance.
    // (get_token_holdings depends on a lagging backend index and can't be trusted for drawdown.)
    const address = await this.boundAddress();
    const symbols = new Set<string>([this.reserveAsset, this.nativeSymbol, ...Object.keys(this.tokenAddresses)]);

    let reserveUsd = 0;
    const positions: Record<string, number> = {};
    for (const symbol of symbols) {
      const usd = await this.balanceUsd(symbol, address);
      if (symbol === this.reserveAsset) reserveUsd += usd;
      else if (usd > 0) positions[symbol] = (positions[symbol] ?? 0) + usd;
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
