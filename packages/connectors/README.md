# @circuit-trader/connectors

Live MCP transports that turn the policy package's **ports** into real network adapters. Keeps all network + secrets out of `packages/policy` (which stays pure, deterministic, and offline-testable).

- `McpHttpTransport` — official MCP client over Streamable HTTP, exposed as the tiny `{ callTool(name, args) }` shape both ports expect. Lazy-connects, memoizes, `unwrapToolResult` normalizes MCP results (structuredContent → JSON text → raw).
- `createCmcMarketSource()` — CoinMarketCap Agent Hub → `CmcMcpSource`. Endpoint `https://mcp.coinmarketcap.com/mcp`, header `X-CMC-MCP-API-KEY` (`CMC_MCP_API_KEY`).
- `createTrustWalletWallet({ address })` — Trust Wallet Agent Kit → `TrustWalletWallet`.
  Spawns local `twak serve` over stdio and forwards `TWAK_ACCESS_ID` / `TWAK_HMAC_SECRET`
  when present. Use the TWAK keychain for the wallet password, or `TWAK_WALLET_PASSWORD`
  on headless VMs. The live runner must run on a VM/worker, not Vercel serverless.
  Defaults include BSC addresses for USDT, USDC, ETH, CAKE, and TWT.

```ts
import { createCmcMarketSource, createTrustWalletWallet } from "@circuit-trader/connectors";
import { runTick, claudeSynthesizer, DEFAULT_STRATEGY } from "circuit-trader-policy";

const { source, transport: cmc } = createCmcMarketSource();
const { wallet, transport: twak } = createTrustWalletWallet({ address: walletAddress });

const tick = await runTick({ constitution, state, wallet, market: source, synthesizer: claudeSynthesizer(),
  config: { strategy: DEFAULT_STRATEGY, sizing: { baseTradeUsd: 4, minStrengthToTrade: 0.2 }, assets: ["BNB", "ETH", "CAKE"] },
  now: new Date().toISOString() });

await cmc.close(); await twak.close();
```

## Verify before mainnet

Both live seams are isolated:

1. **CMC tool names** — `DEFAULT_CMC_TOOLS` in policy's `CmcMcpSource`. Override via
   `createCmcMarketSource({ tools })` if the server changes.
2. **Trust Wallet** — `DEFAULT_TOOL_NAMES` in policy's `TrustWalletWallet`. Run
   `npm run build:connectors && node scripts/validate-twak.mjs`, then a tiny
   `node scripts/live-swap.mjs` before the competition window.
