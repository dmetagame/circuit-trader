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
 * Trust Wallet Agent Kit adapter.
 *
 * TWAK is exposed over MCP (and a CLI). This adapter maps our execution port onto
 * TWAK tool calls through an injected `TwakTransport`, so it's testable with a mock
 * and the MCP wiring lives in one place.
 *
 * ⚠️ EXTERNAL SEAM — verify against the current Trust Wallet Agent Kit docs before going
 *    live: the default `toolNames` and the response field paths in `parse*` below are
 *    best-guess mappings. They're isolated here on purpose; nothing else in the codebase
 *    assumes TWAK's wire format. Confirm tool names, arg shapes, and response keys, then
 *    adjust `DEFAULT_TOOL_NAMES` / the parsers — no other file changes.
 */

export interface TwakTransport {
  /** Invoke an MCP tool and return its (already JSON-parsed) result. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface TwakToolNames {
  getQuote: string;
  swap: string;
  riskScore: string;
  portfolio: string;
}

export const DEFAULT_TOOL_NAMES: TwakToolNames = {
  getQuote: "get_swap_quote",
  swap: "execute_swap",
  riskScore: "get_token_risk_score",
  portfolio: "get_portfolio",
};

export interface TrustWalletWalletConfig {
  transport: TwakTransport;
  chainId?: number;
  reserveAsset?: string;
  walletAddress: string;
  toolNames?: Partial<TwakToolNames>;
}

const num = (v: unknown, fallback?: number): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (fallback !== undefined) return fallback;
  throw new Error(`expected number, got ${JSON.stringify(v)}`);
};
const str = (v: unknown, fallback?: string): string => {
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`expected string, got ${JSON.stringify(v)}`);
};
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export class TrustWalletWallet implements Wallet {
  readonly chainId: number;
  readonly reserveAsset: string;
  private readonly t: TwakTransport;
  private readonly address: string;
  private readonly tools: TwakToolNames;

  constructor(cfg: TrustWalletWalletConfig) {
    this.t = cfg.transport;
    this.chainId = cfg.chainId ?? 56;
    this.reserveAsset = cfg.reserveAsset ?? "USDT";
    this.address = cfg.walletAddress;
    this.tools = { ...DEFAULT_TOOL_NAMES, ...cfg.toolNames };
  }

  async getTokenRiskScore(asset: string): Promise<number> {
    const raw = rec(await this.t.callTool(this.tools.riskScore, { chainId: this.chainId, asset }));
    // TWAK exposes a risk score; map its scale to 0..100 here if it differs.
    return num(raw.riskScore ?? raw.score, 0);
  }

  async getQuote(req: QuoteRequest): Promise<QuoteResult> {
    const raw = rec(
      await this.t.callTool(this.tools.getQuote, {
        chainId: this.chainId,
        wallet: this.address,
        fromAsset: req.side === "buy" ? this.reserveAsset : req.asset,
        toAsset: req.side === "buy" ? req.asset : this.reserveAsset,
        amountUsd: req.sizeUsd,
      }),
    );
    return {
      expectedSlippageBps: Math.round(num(raw.slippageBps ?? raw.expectedSlippageBps, 0)),
      quoteId: str(raw.quoteId ?? raw.id, ""),
      price: num(raw.price, 0),
    };
  }

  async executeSwap(order: SwapOrder, now: string): Promise<Fill> {
    const raw = rec(
      await this.t.callTool(this.tools.swap, {
        chainId: this.chainId,
        wallet: this.address,
        fromAsset: order.side === "buy" ? this.reserveAsset : order.asset,
        toAsset: order.side === "buy" ? order.asset : this.reserveAsset,
        amountUsd: order.sizeUsd,
        maxSlippageBps: order.maxSlippageBps, // ask TWAK to revert past the cap
        quoteId: order.quoteId,
      }),
    );

    const slippageBps = Math.round(num(raw.slippageBps ?? raw.executedSlippageBps, 0));
    // Belt-and-suspenders: enforce the cap client-side too, in case TWAK doesn't.
    if (slippageBps > order.maxSlippageBps) {
      throw new SlippageExceededError(slippageBps, order.maxSlippageBps);
    }

    return {
      asset: order.asset,
      side: order.side as TradeSide,
      filledUsd: num(raw.filledUsd ?? raw.amountUsd, order.sizeUsd),
      price: num(raw.price ?? raw.executedPrice, 0),
      slippageBps,
      txHash: str(raw.txHash ?? raw.transactionHash, ""),
      executedAt: str(raw.executedAt, now),
    };
  }

  async getPortfolio(): Promise<Portfolio> {
    const raw = rec(await this.t.callTool(this.tools.portfolio, { chainId: this.chainId, wallet: this.address }));
    const balances = rec(raw.balancesUsd ?? raw.positions);

    let reserveUsd = num(raw.reserveUsd, 0);
    const positions: Record<string, number> = {};
    for (const [asset, v] of Object.entries(balances)) {
      const usd = num(v, 0);
      if (asset === this.reserveAsset) reserveUsd += usd;
      else if (usd > 0) positions[asset] = usd;
    }
    const positionsUsd = Object.values(positions).reduce((a, b) => a + b, 0);
    return { reserveUsd, positions, equityUsd: reserveUsd + positionsUsd };
  }
}
