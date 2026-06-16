import type { SignalInputs } from "../strategy/signals.js";

/**
 * Market data port. The orchestrator depends on this, not on CoinMarketCap specifics.
 * `tokenRiskScore` is intentionally NOT here — that comes from the Wallet (Trust Wallet);
 * this source supplies the signal inputs + the soft CMC context the LLM weighs.
 *
 * A source may return EITHER a raw `closes` series (the orchestrator computes indicators) OR
 * precomputed `indicators` (e.g. CoinMarketCap's technical-analysis tool — no warmup). If
 * both are present, indicators win.
 */
export interface MarketSignals {
  asset: string;
  /** Recent closes, oldest -> newest. Empty when `indicators` is supplied. */
  closes: number[];
  /** Precomputed signal inputs (SMA-fast/slow, RSI, ROC, ...). Preferred when present. */
  indicators?: SignalInputs;
  /** Latest spot price in USD (informational). */
  priceUsd?: number;
  fundingRatePct?: number;
  /** -1..1 sentiment from CMC trending narratives / news. */
  narrativeScore?: number;
  volumeChangePct?: number;
}

export interface MarketDataSource {
  getMarketData(asset: string): Promise<MarketSignals>;
}

/** Deterministic source for tests / offline paper-trading. */
export class FixtureMarketSource implements MarketDataSource {
  constructor(private readonly fixtures: Record<string, MarketSignals>) {}
  async getMarketData(asset: string): Promise<MarketSignals> {
    const f = this.fixtures[asset];
    if (!f) throw new Error(`no fixture for ${asset}`);
    return f;
  }
}

// --- CoinMarketCap Agent Hub (MCP) adapter ---

export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface CmcTools {
  /** Server-side SMA/EMA/RSI/MACD per asset. */
  technicalAnalysis: string;
  /** Latest quote: price + percent_change_* + volume_change_24h. */
  quotesLatest: string;
  /** Fuzzy symbol/name -> {id} resolution. */
  search: string;
}

/**
 * Verified against the live CoinMarketCap Agent Hub MCP (mcp.coinmarketcap.com) on 2026-06-16.
 * The server exposes precomputed technical analysis (no historical-OHLC tool), so the live
 * path consumes indicators directly rather than reconstructing candles. Tools take a numeric
 * CMC `id`, not a symbol.
 */
export const DEFAULT_CMC_TOOLS: CmcTools = {
  technicalAnalysis: "get_crypto_technical_analysis",
  quotesLatest: "get_crypto_quotes_latest",
  search: "search_cryptos",
};

/** CMC numeric ids for common BNB-chain assets (avoids a search round-trip). */
export const CMC_IDS: Record<string, number> = {
  BTC: 1,
  ETH: 1027,
  USDT: 825,
  USDC: 3408,
  BNB: 1839,
  CAKE: 7186,
  TWT: 5964,
  XRP: 52,
  SOL: 5426,
};

export interface CmcMcpSourceConfig {
  transport: McpTransport;
  tools?: Partial<CmcTools>;
  /** Which percent_change_* window to use as ROC. Default "7d". */
  rocWindow?: "1h" | "24h" | "7d" | "30d";
  /** Seed/override symbol -> CMC id. */
  ids?: Record<string, number>;
}

const numOr = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // CMC formats large numbers with thousands separators, e.g. "1,685.01".
    const cleaned = v.replace(/,/g, "").trim();
    if (cleaned !== "" && Number.isFinite(Number(cleaned))) return Number(cleaned);
  }
  return fallback;
};
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const firstRow = (v: unknown): Record<string, unknown> => (Array.isArray(v) ? rec(v[0]) : rec(v));

export class CmcMcpSource implements MarketDataSource {
  private readonly t: McpTransport;
  private readonly tools: CmcTools;
  private readonly rocWindow: "1h" | "24h" | "7d" | "30d";
  private readonly ids: Record<string, number>;

  constructor(cfg: CmcMcpSourceConfig) {
    this.t = cfg.transport;
    this.tools = { ...DEFAULT_CMC_TOOLS, ...cfg.tools };
    this.rocWindow = cfg.rocWindow ?? "7d";
    this.ids = { ...CMC_IDS, ...(cfg.ids ?? {}) };
  }

  async getMarketData(asset: string): Promise<MarketSignals> {
    const id = await this.resolveId(asset);

    const ta = rec(await this.t.callTool(this.tools.technicalAnalysis, { id: String(id) }));
    const ma = rec(ta.moving_averages);
    const rsiObj = rec(ta.rsi);

    const quote = firstRow(await this.t.callTool(this.tools.quotesLatest, { id: String(id) }));

    const smaFast = numOr(ma.simple_moving_average_7_day, NaN);
    const smaSlow = numOr(ma.simple_moving_average_30_day, NaN);
    const rsiVal = numOr(rsiObj.rsi14 ?? rsiObj.rsi7, NaN);
    if (Number.isNaN(smaFast) || Number.isNaN(smaSlow) || Number.isNaN(rsiVal)) {
      throw new Error(`CMC technical analysis incomplete for ${asset} (id ${id})`);
    }

    const roc = numOr(quote[`percent_change_${this.rocWindow}`], 0);
    const turningUp = numOr(quote.percent_change_24h, 0) > 0;

    const indicators: SignalInputs = { smaFast, smaSlow, rsi: rsiVal, roc, zscore: 0, turningUp };

    const out: MarketSignals = { asset, closes: [], indicators };
    const price = numOr(quote.price, NaN);
    if (!Number.isNaN(price)) out.priceUsd = price;
    const vol = numOr(quote.volume_change_24h, NaN);
    if (!Number.isNaN(vol)) out.volumeChangePct = vol;
    return out;
  }

  private async resolveId(asset: string): Promise<number> {
    const known = this.ids[asset];
    if (known != null) return known;
    const res = await this.t.callTool(this.tools.search, { query: asset, limit: 1 });
    const row = firstRow(res);
    const id = numOr(row.id, NaN);
    if (Number.isNaN(id)) throw new Error(`could not resolve CMC id for ${asset}`);
    this.ids[asset] = id;
    return id;
  }
}
