import { TrustWalletWallet, type TwakToolNames } from "circuit-trader-policy";
import { McpStdioTransport, stringEnv } from "./mcp-stdio.js";

/**
 * Wire a live Trust Wallet Agent Kit wallet by spawning its local MCP server (`twak serve`,
 * stdio). Verified against @trustwallet/cli v0.19.1 (2026-06-16): `serve` starts an MCP stdio
 * server that auto-binds the agent wallet and does HMAC signing. Credentials come from
 * `TWAK_ACCESS_ID` / `TWAK_HMAC_SECRET` (forwarded here) or the CLI keychain (`twak setup`).
 * No wallet address is passed — the server binds the local wallet itself.
 *
 * Note: spawning a CLI rules out Vercel serverless for the live trade loop — run the
 * orchestrator on a worker/VM. The simulated dashboard still deploys to Vercel.
 */
export interface TrustWalletConnectorOptions {
  /** Path/name of the twak binary. Default: $TWAK_BIN or "twak" on PATH. */
  command?: string;
  accessId?: string;
  hmacSecret?: string;
  /** Chain key, e.g. "bsc" (default). */
  chain?: string;
  chainId?: number;
  reserveAsset?: string;
  nativeSymbol?: string;
  /** Contract addresses for non-native allowlisted tokens (for per-token risk checks). */
  tokenAddresses?: Record<string, string>;
  toolNames?: Partial<TwakToolNames>;
  /** Extra args appended to `twak serve` (e.g. ["--password", "..."]). */
  extraServeArgs?: string[];
}

export function createTrustWalletWallet(opts: TrustWalletConnectorOptions = {}): {
  wallet: TrustWalletWallet;
  transport: McpStdioTransport;
} {
  const command = opts.command ?? process.env.TWAK_BIN ?? "twak";
  const accessId = opts.accessId ?? process.env.TWAK_ACCESS_ID;
  const hmacSecret = opts.hmacSecret ?? process.env.TWAK_HMAC_SECRET;

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
    ...(opts.chain ? { chain: opts.chain } : {}),
    ...(opts.chainId != null ? { chainId: opts.chainId } : {}),
    ...(opts.reserveAsset ? { reserveAsset: opts.reserveAsset } : {}),
    ...(opts.nativeSymbol ? { nativeSymbol: opts.nativeSymbol } : {}),
    ...(opts.tokenAddresses ? { tokenAddresses: opts.tokenAddresses } : {}),
    ...(opts.toolNames ? { toolNames: opts.toolNames } : {}),
  });

  return { wallet, transport };
}
