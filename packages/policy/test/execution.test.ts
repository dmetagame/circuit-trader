import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SimulatedWallet,
  SlippageExceededError,
  TrustWalletWallet,
  evaluate,
  initState,
  markHighWater,
  recordExecution,
  engageKillSwitch,
  parseConstitution,
  proposeTrade,
  type Constitution,
  type RuntimeState,
  type StrategyConfig,
  type TwakTransport,
} from "../src/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(join(__dirname, "../src/example.constitution.json"), "utf8"));
const NOW = "2026-06-16T12:00:00.000Z";

describe("SimulatedWallet", () => {
  it("quotes, buys, and reflects the position in the portfolio", async () => {
    const w = new SimulatedWallet({ reserveUsd: 100, prices: { BNB: 600 }, slippageBps: 20 });
    const q = await w.getQuote({ asset: "BNB", side: "buy", sizeUsd: 30 });
    expect(q.price).toBe(600);

    const fill = await w.executeSwap({ asset: "BNB", side: "buy", sizeUsd: 30, maxSlippageBps: 75 }, NOW);
    expect(fill.filledUsd).toBe(30);
    expect(fill.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const pf = await w.getPortfolio();
    expect(pf.reserveUsd).toBe(70);
    expect(pf.positions.BNB).toBeGreaterThan(29); // ~30 minus slippage drag
    expect(pf.equityUsd).toBeCloseTo(70 + (pf.positions.BNB ?? 0), 2);
  });

  it("rejects a fill that exceeds the slippage cap", async () => {
    const w = new SimulatedWallet({ reserveUsd: 100, prices: { BNB: 600 }, slippageBps: 200 });
    await expect(
      w.executeSwap({ asset: "BNB", side: "buy", sizeUsd: 10, maxSlippageBps: 75 }, NOW),
    ).rejects.toBeInstanceOf(SlippageExceededError);
  });

  it("a price drop reduces equity (drives drawdown — the demo trigger)", async () => {
    const w = new SimulatedWallet({ reserveUsd: 50, prices: { BNB: 600 }, positionsUnits: { BNB: 0.1 } });
    expect((await w.getPortfolio()).equityUsd).toBeCloseTo(110, 2); // 50 + 0.1*600
    w.setPrice("BNB", 300);
    expect((await w.getPortfolio()).equityUsd).toBeCloseTo(80, 2); // 50 + 0.1*300
  });

  it("returns token risk scores", async () => {
    const w = new SimulatedWallet({ reserveUsd: 100, prices: { SCAM: 1 }, riskScores: { SCAM: 90 } });
    expect(await w.getTokenRiskScore("SCAM")).toBe(90);
  });
});

describe("TrustWalletWallet (adapter over a mock MCP transport — live twak serve tools)", () => {
  // Shapes mirror the real `twak serve` MCP tools (verified 2026-06-16).
  const USDT_ADDR = "0x55d398326f99059fF775485246999027B3197955";
  const transport: TwakTransport = {
    async callTool(name, args) {
      switch (name) {
        case "get_wallet_status":
          return { state: "local", walletType: "local" };
        case "switch_wallet_mode":
          return { state: "local", mode: args.mode };
        case "get_token_price":
          return { success: true, token: "BNB", chain: "bsc", priceUsd: 600 };
        case "get_swap_quote":
          return { success: true, input: "5 USDT", output: "0.00819 BNB", provider: "LiquidMesh", priceImpact: "0.35", steps: 1 };
        case "swap":
          return { success: true, txHash: "0x" + "ab".repeat(32), output: "0.00819 BNB", priceImpact: "0.35" };
        case "check_token_risk":
          return { success: true, symbol: "BNB", riskLevel: "low", isHoneypot: false };
        case "get_address":
          return { chain: "bsc", address: "0x" + "1".repeat(40) };
        case "get_balance":
          // Native (no tokenAddress) -> BNB position; tokenAddress -> USDT reserve.
          return args.tokenAddress
            ? { slug: "Tether-USD", amounts: { total: "80000000000000000000", totalInFiat: "80" } }
            : { slug: "bnb", amounts: { total: "33000000000000000", totalInFiat: "20" } };
        default:
          throw new Error(`unexpected tool ${name}`);
      }
    },
  };
  const w = new TrustWalletWallet({ transport, chain: "bsc", tokenAddresses: { USDT: USDT_ADDR } });

  it("maps quote / swap / risk / portfolio through the transport", async () => {
    const q = await w.getQuote({ asset: "BNB", side: "buy", sizeUsd: 5 });
    expect(q).toMatchObject({ expectedSlippageBps: 35, price: 600 }); // priceImpact 0.35% -> 35 bps

    const fill = await w.executeSwap({ asset: "BNB", side: "buy", sizeUsd: 5, maxSlippageBps: 75 }, NOW);
    expect(fill.filledUsd).toBe(5); // buy spends ~sizeUsd of the reserve
    expect(fill.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    expect(await w.getTokenRiskScore("BNB")).toBe(10); // riskLevel "low" -> 10

    const pf = await w.getPortfolio();
    expect(pf.reserveUsd).toBe(80);
    expect(pf.positions.BNB).toBe(20);
    expect(pf.equityUsd).toBe(100);
  });

  it("switches TWAK to the local wallet when the session starts unbound", async () => {
    const calls: string[] = [];
    let status = "unbound";
    const t: TwakTransport = {
      async callTool(name, args) {
        calls.push(name);
        switch (name) {
          case "get_wallet_status":
            return { state: status };
          case "switch_wallet_mode":
            expect(args).toMatchObject({ mode: "local" });
            status = "local";
            return { state: "local" };
          case "get_address":
            return { chain: "bsc", address: "0x" + "2".repeat(40) };
          case "get_balance":
            return args.tokenAddress
              ? { amounts: { totalInFiat: "12" } }
              : { amounts: { totalInFiat: "3" } };
          default:
            throw new Error(`unexpected tool ${name}`);
        }
      },
    };
    const local = new TrustWalletWallet({ transport: t, chain: "bsc", tokenAddresses: { USDT: USDT_ADDR } });
    const pf = await local.getPortfolio();
    expect(pf.equityUsd).toBe(15);
    expect(calls).toEqual(["get_wallet_status", "switch_wallet_mode", "get_wallet_status", "get_address", "get_balance", "get_balance"]);
  });

  it("maps a honeypot token to max risk", async () => {
    const t: TwakTransport = {
      async callTool() {
        return { success: true, riskLevel: "high", isHoneypot: true };
      },
    };
    const hw = new TrustWalletWallet({ transport: t, chain: "bsc", tokenAddresses: { SCAM: "0x" + "9".repeat(40) } });
    expect(await hw.getTokenRiskScore("SCAM")).toBe(100);
  });

  it("enforces the slippage cap client-side even if the swap reports worse fill", async () => {
    const greedy: TwakTransport = {
      async callTool(name) {
        if (name === "get_wallet_status") return { state: "local" };
        if (name === "get_token_price") return { priceUsd: 600 };
        return { success: true, txHash: "0x" + "cd".repeat(32), output: "0.0081 BNB", priceImpact: "5" }; // 500 bps
      },
    };
    const gw = new TrustWalletWallet({ transport: greedy, chain: "bsc" });
    await expect(
      gw.executeSwap({ asset: "BNB", side: "buy", sizeUsd: 5, maxSlippageBps: 75 }, NOW),
    ).rejects.toBeInstanceOf(SlippageExceededError);
  });

  it("derives realized slippage from output when the live swap omits priceImpact", async () => {
    // The live `swap` tool returns txHash + output but no priceImpact (verified 2026-06-17).
    // Expected out for $5 at $500 = 0.01 BNB; a 0.0098 fill = 200bps realized -> over a 75bps cap.
    const noImpact: TwakTransport = {
      async callTool(name) {
        if (name === "get_wallet_status") return { state: "local" };
        if (name === "get_token_price") return { priceUsd: 500 };
        return { success: true, txHash: "0x" + "ef".repeat(32), output: "0.0098 BNB" };
      },
    };
    const w2 = new TrustWalletWallet({ transport: noImpact, chain: "bsc" });
    await expect(
      w2.executeSwap({ asset: "BNB", side: "buy", sizeUsd: 5, maxSlippageBps: 75 }, NOW),
    ).rejects.toBeInstanceOf(SlippageExceededError);

    // A tight fill (0.00999 BNB = 10bps) clears the same cap and reports the realized slippage.
    const tight: TwakTransport = {
      async callTool(name) {
        if (name === "get_wallet_status") return { state: "local" };
        if (name === "get_token_price") return { priceUsd: 500 };
        return { success: true, txHash: "0x" + "12".repeat(32), output: "0.00999 BNB" };
      },
    };
    const w3 = new TrustWalletWallet({ transport: tight, chain: "bsc" });
    const fill = await w3.executeSwap({ asset: "BNB", side: "buy", sizeUsd: 5, maxSlippageBps: 75 }, NOW);
    expect(fill.slippageBps).toBe(10);
    expect(fill.filledUsd).toBe(5);
  });
});

describe("FULL LOOP: market → strategy → policy → execution → state", () => {
  const CFG: StrategyConfig = {
    smaFastPeriod: 5,
    smaSlowPeriod: 10,
    rsiPeriod: 14,
    rocPeriod: 5,
    zscorePeriod: 10,
    rsiOverbought: 95,
    rsiOversold: 30,
    rocBuyThresholdPct: 0.5,
    zscoreEntryMax: 3,
  };
  const noisyUp = (n: number): number[] => {
    const deltas = [3, 3, -1];
    const closes = [100];
    for (let i = 0; i < n - 1; i++) closes.push((closes[closes.length - 1] as number) + (deltas[i % 3] as number));
    return closes;
  };
  const constitution = (o: Partial<Constitution> = {}): Constitution => parseConstitution({ ...RAW, ...o });

  it("executes a cleared trade and updates state from the wallet", async () => {
    const c = constitution();
    const wallet = new SimulatedWallet({ reserveUsd: 100, prices: { BNB: 600 }, riskScores: { BNB: 15 }, slippageBps: 20 });

    let state: RuntimeState = initState(100, NOW);

    // 1. Gather inputs from the wallet (risk score) + a quote.
    const tokenRiskScore = await wallet.getTokenRiskScore("BNB");
    const quote = await wallet.getQuote({ asset: "BNB", side: "buy", sizeUsd: 5 });

    // 2. Strategy proposes (high-confidence synthesizer stub so it clears the confidence gate).
    const out = await proposeTrade({
      market: { asset: "BNB", closes: noisyUp(40), tokenRiskScore },
      strategy: CFG,
      sizing: { baseTradeUsd: 8, minStrengthToTrade: 0.1 },
      synthesizer: { async synthesize() { return { recommendedAction: "buy", confidence: 0.9, riskLevel: "low", rationale: "ok" }; } },
      now: NOW,
      quote: { expectedSlippageBps: quote.expectedSlippageBps, quoteId: quote.quoteId },
    });
    expect(out.proposal).not.toBeNull();

    // 3. Policy gate.
    const decision = evaluate({ constitution: c, state, proposal: out.proposal!, now: NOW });
    expect(decision.allowed).toBe(true);

    // 4. Execute + reconcile state from the wallet's ground truth.
    const ep = decision.effectiveProposal!;
    const fill = await wallet.executeSwap(
      { asset: ep.asset, side: ep.side, sizeUsd: ep.sizeUsd, maxSlippageBps: c.perTrade.maxSlippageBps, quoteId: ep.quoteId },
      NOW,
    );
    state = recordExecution(state, ep, fill.filledUsd, fill.executedAt);
    const pf = await wallet.getPortfolio();
    state = markHighWater({ ...state, equityUsd: pf.equityUsd, reserveUsd: pf.reserveUsd, positions: pf.positions });

    expect(state.tradesToday).toBe(1);
    expect(state.lastTradeAtGlobal).toBe(NOW);
    expect(state.positions.BNB).toBeGreaterThan(0);
    expect(state.equityUsd).toBeCloseTo(pf.equityUsd, 2);
  });

  it("a price crash trips the drawdown gate on the next tick and engages the kill switch", async () => {
    const c = constitution(); // maxDrawdownPct = 20
    const wallet = new SimulatedWallet({ reserveUsd: 10, prices: { BNB: 600 }, positionsUnits: { BNB: 0.15 } });

    let pf = await wallet.getPortfolio(); // equity ~100
    let state: RuntimeState = markHighWater({ ...initState(0, NOW), equityUsd: pf.equityUsd, highWaterMarkUsd: pf.equityUsd, reserveUsd: pf.reserveUsd, positions: pf.positions });

    // Crash.
    wallet.setPrice("BNB", 300);
    pf = await wallet.getPortfolio(); // equity ~55 -> ~45% drawdown
    state = { ...state, equityUsd: pf.equityUsd, reserveUsd: pf.reserveUsd, positions: pf.positions };

    const decision = evaluate({
      constitution: c,
      state,
      proposal: { asset: "BNB", side: "buy", sizeUsd: 3, expectedSlippageBps: 10, signalConfidence: 0.9, tokenRiskScore: 10, rationale: "x", proposedAt: NOW },
      now: NOW,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.engageKillSwitch).toBe(true);
    state = engageKillSwitch(state, decision.killSwitchReason ?? "drawdown");
    expect(state.killSwitchEngaged).toBe(true);
  });
});
