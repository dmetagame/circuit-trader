import { TrustWalletWallet, type TwakToolNames } from "circuit-trader-policy";
import { McpStdioTransport, stringEnv } from "./mcp-stdio.js";

export const BSC_TOKEN_ADDRESSES: Record<string, string> = {
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  ETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
  CAKE: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
  TWT: "0x4B0F1812e5Df2A09796481Ff14017e6005508003",
};

/**
 * Wire a live Trust Wallet Agent Kit wallet by spawning its local MCP server (`twak serve`,
 * stdio). Verified against @trustwallet/cli v0.19.1 (2026-06-16): `serve` starts an MCP stdio
 * server that auto-binds the agent wallet and does HMAC signing. Credentials come from
 * `TWAK_ACCESS_ID` / `TWAK_HMAC_SECRET` (forwarded here) or the CLI keychain (`twak setup`).
 * The local wallet password should come from the OS keychain where possible; for headless
 * runners, `TWAK_WALLET_PASSWORD` is forwarded to `twak serve --password`.
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
  /** Bound wallet address; if omitted the adapter resolves it via the `address` tool. */
  address?: string;
  /** Local TWAK wallet password. Prefer keychain; env fallback is useful on headless VMs. */
  walletPassword?: string;
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
  const walletPassword = opts.walletPassword ?? process.env.TWAK_WALLET_PASSWORD;
  if (opts.extraServeArgs?.includes("--password")) {
    throw new Error("pass the wallet password via TWAK_WALLET_PASSWORD, not process arguments");
  }

  const env: Record<string, string> = {
    ...stringEnv({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      SHELL: process.env.SHELL,
      PWD: process.env.PWD,
      TMPDIR: process.env.TMPDIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_DATA_DIRS: process.env.XDG_DATA_DIRS,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
      TERM: process.env.TERM,
    }),
    ...(accessId ? { TWAK_ACCESS_ID: accessId } : {}),
    ...(hmacSecret ? { TWAK_HMAC_SECRET: hmacSecret } : {}),
    ...(walletPassword ? { TWAK_WALLET_PASSWORD: walletPassword } : {}),
  };

  const transport = new McpStdioTransport({
    command,
    args: ["--no-analytics", "serve", ...(opts.extraServeArgs ?? [])],
    env,
    clientName: "circuit-trader-twak",
  });

  const chain = opts.chain ?? "bsc";
  const tokenAddresses = {
    ...(chain === "bsc" ? BSC_TOKEN_ADDRESSES : {}),
    ...(opts.tokenAddresses ?? {}),
  };
  if (chain === "bsc") {
    for (const [symbol, address] of Object.entries(opts.tokenAddresses ?? {})) {
      const canonical = BSC_TOKEN_ADDRESSES[symbol];
      if (canonical && canonical.toLowerCase() !== address.toLowerCase()) {
        throw new Error(`refusing to override canonical BSC address for ${symbol}`);
      }
    }
  }

  const wallet = new TrustWalletWallet({
    transport,
    chain,
    ...(opts.chainId != null ? { chainId: opts.chainId } : {}),
    ...(opts.reserveAsset ? { reserveAsset: opts.reserveAsset } : {}),
    ...(opts.nativeSymbol ? { nativeSymbol: opts.nativeSymbol } : {}),
    tokenAddresses,
    ...(opts.address ? { address: opts.address } : {}),
    ...(opts.toolNames ? { toolNames: opts.toolNames } : {}),
  });

  return { wallet, transport };
}
