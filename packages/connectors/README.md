# @circuit-trader/connectors

Live MCP transports that turn the policy package's **ports** into real network adapters. Keeps all network + secrets out of `packages/policy` (which stays pure, deterministic, and offline-testable).

- `McpHttpTransport` — official MCP client over Streamable HTTP, exposed as the tiny `{ callTool(name, args) }` shape both ports expect. Lazy-connects, memoizes, `unwrapToolResult` normalizes MCP results (structuredContent → JSON text → raw).
- `createCmcMarketSource()` — CoinMarketCap Agent Hub → `CmcMcpSource`. Endpoint `https://mcp.coinmarketcap.com/mcp`, header `X-CMC-MCP-API-KEY` (`CMC_MCP_API_KEY`).
- `createTrustWalletWallet({ walletAddress })` — Trust Wallet Agent Kit → `TrustWalletWallet`. `TWAK_MCP_URL` + `TWAK_API_KEY`, `AGENT_WALLET_ADDRESS`.

```ts
import { createCmcMarketSource, createTrustWalletWallet } from "@circuit-trader/connectors";
import { runTick, claudeSynthesizer, DEFAULT_STRATEGY } from "circuit-trader-policy";

const { source, transport: cmc } = createCmcMarketSource();
const { wallet, transport: twak } = createTrustWalletWallet({ walletAddress });

const tick = await runTick({ constitution, state, wallet, market: source, synthesizer: claudeSynthesizer(),
  config: { strategy: DEFAULT_STRATEGY, sizing: { baseTradeUsd: 4, minStrengthToTrade: 0.2 }, assets: ["BNB", "ETH", "CAKE"] },
  now: new Date().toISOString() });

await cmc.close(); await twak.close();
```

## ⚠️ Verify before mainnet

Two seams need confirming against live docs (both isolated, no other code changes):
1. **CMC tool names** — `DEFAULT_CMC_TOOLS` in policy's `CmcMcpSource`. List the live server's tools and override via `createCmcMarketSource({ tools })` if they differ.
2. **Trust Wallet** — `DEFAULT_TOOL_NAMES` in policy's `TrustWalletWallet`, the auth header scheme (defaulted to `Authorization: Bearer`), and whether TWAK is hosted HTTP (use `McpHttpTransport`) or a local stdio MCP server (swap in a stdio transport — same `{ callTool }` shape).
