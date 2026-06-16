/**
 * Market data port. The orchestrator depends on this, not on CoinMarketCap specifics.
 * `tokenRiskScore` is intentionally NOT here — that comes from the Wallet (Trust Wallet);
 * this source supplies price history + the soft CMC context the LLM weighs.
 */
export interface MarketSignals {
  asset: string;
  /** Recent closes, oldest -> newest. */
  closes: number[];
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
  quotesHistorical: string;
  trending: string;
  derivatives: string;
}

/**
 * ⚠️ EXTERNAL SEAM — verify against the current CoinMarketCap Agent Hub MCP docs
 *    (https://mcp.coinmarketcap.com/mcp). These default tool names and the response
 *    field paths in `getMarketData` are best-guess mappings, isolated here on purpose.
 *    Confirm the actual tool names + result shapes, then adjust these and the parsers —
 *    no other file changes.
 */
export const DEFAULT_CMC_TOOLS: CmcTools = {
  quotesHistorical: "cryptocurrency_quotes_historical",
  trending: "cryptocurrency_trending_latest",
  derivatives: "derivatives_funding_rate",
};

export interface CmcMcpSourceConfig {
  transport: McpTransport;
  tools?: Partial<CmcTools>;
  /** How many historical closes to request. */
  lookback?: number;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : fallback;
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export class CmcMcpSource implements MarketDataSource {
  private readonly t: McpTransport;
  private readonly tools: CmcTools;
  private readonly lookback: number;

  constructor(cfg: CmcMcpSourceConfig) {
    this.t = cfg.transport;
    this.tools = { ...DEFAULT_CMC_TOOLS, ...cfg.tools };
    this.lookback = cfg.lookback ?? 40;
  }

  async getMarketData(asset: string): Promise<MarketSignals> {
    const closes = await this.fetchCloses(asset);
    const out: MarketSignals = { asset, closes };

    // Soft context is best-effort: a missing/changed tool must not break the price path.
    try {
      const n = await this.fetchNarrativeScore(asset);
      if (n != null) out.narrativeScore = n;
    } catch {
      /* soft signal unavailable */
    }
    try {
      const f = await this.fetchFundingRatePct(asset);
      if (f != null) out.fundingRatePct = f;
    } catch {
      /* soft signal unavailable */
    }
    return out;
  }

  private async fetchCloses(asset: string): Promise<number[]> {
    const raw = rec(await this.t.callTool(this.tools.quotesHistorical, { symbol: asset, count: this.lookback, interval: "1h" }));
    // Accept several shapes: {closes:[...]}, {data:[{close|price}]}, {quotes:[{quote:{USD:{close}}}]}
    if (Array.isArray(raw.closes)) return (raw.closes as unknown[]).map((x) => numOr(x, NaN)).filter((x) => !Number.isNaN(x));
    const rows = arr(raw.data ?? raw.quotes);
    const closes = rows
      .map((row) => {
        const r = rec(row);
        const usd = rec(rec(r.quote).USD);
        return numOr(r.close ?? r.price ?? usd.close ?? usd.price, NaN);
      })
      .filter((x) => !Number.isNaN(x));
    if (closes.length === 0) throw new Error(`no closes parsed for ${asset}`);
    return closes;
  }

  private async fetchNarrativeScore(asset: string): Promise<number | null> {
    const raw = rec(await this.t.callTool(this.tools.trending, { symbol: asset }));
    if (raw.narrativeScore != null) return numOr(raw.narrativeScore, 0);
    if (raw.sentimentScore != null) return numOr(raw.sentimentScore, 0);
    return null;
  }

  private async fetchFundingRatePct(asset: string): Promise<number | null> {
    const raw = rec(await this.t.callTool(this.tools.derivatives, { symbol: asset }));
    if (raw.fundingRatePct != null) return numOr(raw.fundingRatePct, 0);
    if (raw.fundingRate != null) return numOr(raw.fundingRate, 0) * 100;
    return null;
  }
}
