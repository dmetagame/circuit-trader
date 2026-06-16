import { TrustWalletWallet, type TwakToolNames } from "circuit-trader-policy";
import { McpStdioTransport, stringEnv } from "./mcp-stdio.js";

/**
 * Wire a live Trust Wallet Agent Kit wallet by spawning its local MCP server (`twak serve`,
 * stdio). Verified against @trustwallet/cli v0.19.1 (2026-06-16): `serve` starts an MCP stdio
 * server; credentials come from `TWAK_ACCESS_ID` / `TWAK_HMAC_SECRET` (or the CLI keychain via
 * `twak setup`). The CLI does the HMAC signing — this process never holds the signing secret
 * in a header.
 *
 * ⚠️ STILL TO VERIFY (needs valid creds to connect): the exact MCP tool names `twak serve`
 * exposes and their response shapes. They're isolated in the policy package's
 * `DEFAULT_TOOL_NAMES` + TrustWalletWallet parsers — connect once with creds, run tools/list,
 * and override `toolNames` / adjust parsers in one place.
 *
 * Note: spawning a CLI rules out Vercel serverless for the live trade loop — run the
 * orchestrator on a worker/VM that can launch `twak`. The dashboard (simulated wallet) still
 * deploys to Vercel fine.
 */
export interface TrustWalletConnectorOptions {
  walletAddress?: string;
  /** Path/name of the twak binary. Default: $TWAK_BIN or "twak" on PATH. */
  command?: string;
  accessId?: string;
  hmacSecret?: string;
  chainId?: number;
  reserveAsset?: string;
  toolNames?: Partial<TwakToolNames>;
  /** Extra args appended to `twak serve` (e.g. ["--password", "..."]). */
  extraServeArgs?: string[];
}

export function createTrustWalletWallet(opts: TrustWalletConnectorOptions = {}): {
  wallet: TrustWalletWallet;
  transport: McpStdioTransport;
} {
  const command = opts.command ?? process.env.TWAK_BIN ?? "twak";

  const walletAddress = opts.walletAddress ?? process.env.AGENT_WALLET_ADDRESS;
  if (!walletAddress) throw new Error("AGENT_WALLET_ADDRESS is required (the dedicated agent wallet)");

  const accessId = opts.accessId ?? process.env.TWAK_ACCESS_ID;
  const hmacSecret = opts.hmacSecret ?? process.env.TWAK_HMAC_SECRET;

  // Pass creds (when provided) through to the child; otherwise the CLI falls back to its keychain.
  const env: Record<string, string> = {
    ...stringEnv(process.env),
    ...(accessId ? { TWAK_ACCESS_ID: accessId } : {}),
    ...(hmacSecret ? { TWAK_HMAC_SECRET: hmacSecret } : {}),
  };

  const transport = new McpStdioTransport({
    command,
    args: ["--no-analytics", "serve", ...(opts.extraServeArgs ?? [])],
    env,
    clientName: "circuit-trader-twak",
  });

  const wallet = new TrustWalletWallet({
    transport,
    walletAddress,
    ...(opts.chainId != null ? { chainId: opts.chainId } : {}),
    ...(opts.reserveAsset ? { reserveAsset: opts.reserveAsset } : {}),
    ...(opts.toolNames ? { toolNames: opts.toolNames } : {}),
  });

  return { wallet, transport };
}
