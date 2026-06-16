import { TrustWalletWallet, type TwakToolNames } from "circuit-trader-policy";
import { McpHttpTransport } from "./mcp-transport.js";

/**
 * Wire a live Trust Wallet Agent Kit wallet over its MCP server.
 *
 * ⚠️ EXTERNAL SEAM — verify against the current Trust Wallet Agent Kit docs:
 *   - `TWAK_MCP_URL`: the Agent Kit MCP endpoint. If you run TWAK as a LOCAL MCP server
 *     (stdio) rather than hosted HTTP, swap `McpHttpTransport` for a stdio transport — the
 *     `{ callTool }` shape is identical, so nothing downstream changes.
 *   - Auth header: defaulted to `Authorization: Bearer <TWAK_API_KEY>`. Confirm the real
 *     header name/scheme and adjust below.
 *   - Tool names: `DEFAULT_TOOL_NAMES` in the policy package's TrustWalletWallet; override
 *     via `toolNames` if they differ.
 */
export interface TrustWalletConnectorOptions {
  walletAddress?: string;
  url?: string;
  apiKey?: string;
  chainId?: number;
  reserveAsset?: string;
  toolNames?: Partial<TwakToolNames>;
}

export function createTrustWalletWallet(opts: TrustWalletConnectorOptions = {}): {
  wallet: TrustWalletWallet;
  transport: McpHttpTransport;
} {
  const url = opts.url ?? process.env.TWAK_MCP_URL;
  if (!url) throw new Error("TWAK_MCP_URL is required (Trust Wallet Agent Kit MCP endpoint)");

  const walletAddress = opts.walletAddress ?? process.env.AGENT_WALLET_ADDRESS;
  if (!walletAddress) throw new Error("AGENT_WALLET_ADDRESS is required (the dedicated agent wallet)");

  const apiKey = opts.apiKey ?? process.env.TWAK_API_KEY;
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const transport = new McpHttpTransport({ url, headers, clientName: "circuit-trader-twak" });

  const wallet = new TrustWalletWallet({
    transport,
    walletAddress,
    ...(opts.chainId != null ? { chainId: opts.chainId } : {}),
    ...(opts.reserveAsset ? { reserveAsset: opts.reserveAsset } : {}),
    ...(opts.toolNames ? { toolNames: opts.toolNames } : {}),
  });

  return { wallet, transport };
}
