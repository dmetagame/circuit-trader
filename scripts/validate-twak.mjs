// Live read-path validation of the TWAK adapter against the funded BSC wallet.
// Spins up `twak serve` via the connector, then checks the shapes the orchestrator depends on.
import { createTrustWalletWallet } from "../packages/connectors/dist/index.js";

const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

const { wallet, transport } = createTrustWalletWallet({
  chain: "bsc",
  reserveAsset: "USDT",
  nativeSymbol: "BNB",
  tokenAddresses: { USDT: USDT_BSC },
});

try {
  console.log("== wallet.getPortfolio() ==");
  console.log(await wallet.getPortfolio());

  console.log("\n== wallet.getTokenRiskScore('BNB') ==");
  console.log(await wallet.getTokenRiskScore("BNB"));

  console.log("\n== wallet.getQuote(buy 0.5 USDT -> BNB) ==");
  console.log(await wallet.getQuote({ asset: "BNB", side: "buy", sizeUsd: 0.5 }));
} catch (e) {
  console.error("ERROR:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await transport.close();
}
