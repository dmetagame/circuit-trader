// LIVE: tiny 0.5 USDT -> BNB swap on BSC to validate executeSwap response parsing.
// Spends real funds. Snapshots portfolio before/after.
import { createTrustWalletWallet } from "../packages/connectors/dist/index.js";

const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const { wallet, transport } = createTrustWalletWallet({
  chain: "bsc", reserveAsset: "USDT", nativeSymbol: "BNB",
  tokenAddresses: { USDT: USDT_BSC },
});

const now = () => new Date().toISOString();
try {
  console.log("== portfolio BEFORE =="); console.log(await wallet.getPortfolio());

  console.log("\n== executeSwap buy 0.5 USDT -> BNB (maxSlippage 150bps) ==");
  const fill = await wallet.executeSwap(
    { asset: "BNB", side: "buy", sizeUsd: 0.5, maxSlippageBps: 150 },
    now(),
  );
  console.log(fill);

  console.log("\n== waiting 6s for settlement, then portfolio AFTER ==");
  await new Promise((r) => setTimeout(r, 6000));
  console.log(await wallet.getPortfolio());
} catch (e) {
  console.error("ERROR:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await transport.close();
}
