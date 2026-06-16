import { CmcMcpSource, type CmcTools } from "circuit-trader-policy";
import { McpHttpTransport } from "./mcp-transport.js";

/**
 * Wire a live CoinMarketCap Agent Hub market-data source.
 *
 * Endpoint + auth: https://mcp.coinmarketcap.com/mcp with header `X-CMC-MCP-API-KEY`
 * (free Basic key at pro.coinmarketcap.com). The actual MCP tool names live in
 * `DEFAULT_CMC_TOOLS` inside the policy package's CmcMcpSource — ⚠️ verify them against
 * the live server (list its tools) and override via `tools` if they differ.
 */
export interface CmcConnectorOptions {
  url?: string;
  apiKey?: string;
  tools?: Partial<CmcTools>;
  /** Which percent_change_* window to use as ROC. Default "7d". */
  rocWindow?: "1h" | "24h" | "7d" | "30d";
  /** Seed/override symbol -> CMC id. */
  ids?: Record<string, number>;
}

export const CMC_MCP_URL = "https://mcp.coinmarketcap.com/mcp";

export function createCmcMarketSource(opts: CmcConnectorOptions = {}): {
  source: CmcMcpSource;
  transport: McpHttpTransport;
} {
  const url = opts.url ?? process.env.CMC_MCP_URL ?? CMC_MCP_URL;
  const apiKey = opts.apiKey ?? process.env.CMC_MCP_API_KEY;
  if (!apiKey) {
    throw new Error("CMC_MCP_API_KEY is required (free Basic key at pro.coinmarketcap.com)");
  }

  const transport = new McpHttpTransport({
    url,
    headers: { "X-CMC-MCP-API-KEY": apiKey },
    clientName: "circuit-trader-cmc",
  });

  const source = new CmcMcpSource({
    transport,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.rocWindow ? { rocWindow: opts.rocWindow } : {}),
    ...(opts.ids ? { ids: opts.ids } : {}),
  });

  return { source, transport };
}
