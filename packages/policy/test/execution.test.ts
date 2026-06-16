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

describe("TrustWalletWallet (adapter over a mock MCP transport)", () => {
  const transport: TwakTransport = {
    async callTool(name, args) {
      switch (name) {
        case "get_swap_quote":
          return { quoteId: "twak-1", slippageBps: 35, price: 600 };
        case "execute_swap":
          return { txHash: "0x" + "ab".repeat(32), filledUsd: args.amountUsd, price: 601, slippageBps: 35 };
        case "get_token_risk_score":
          return { riskScore: 22 };
        case "get_portfolio":
          return { reserveUsd: 80, balancesUsd: { USDT: 0, BNB: 20 } };
        default:
          throw new Error(`unexpected tool ${name}`);
      }
    },
  };
  const w = new TrustWalletWallet({ transport, walletAddress: "0x" + "1".repeat(40) });

  it("maps quote / swap / risk / portfolio through the transport", async () => {
    const q = await w.getQuote({ asset: "BNB", side: "buy", sizeUsd: 5 });
    expect(q).toMatchObject({ quoteId: "twak-1", expectedSlippageBps: 35, price: 600 });

    const fill = await w.executeSwap({ asset: "BNB", side: "buy", sizeUsd: 5, maxSlippageBps: 75 }, NOW);
    expect(fill.filledUsd).toBe(5);
    expect(fill.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    expect(await w.getTokenRiskScore("BNB")).toBe(22);

    const pf = await w.getPortfolio();
    expect(pf.reserveUsd).toBe(80);
    expect(pf.positions.BNB).toBe(20);
    expect(pf.equityUsd).toBe(100);
  });

  it("enforces the slippage cap client-side even if the transport doesn't", async () => {
    const greedy: TwakTransport = {
      async callTool() {
        return { txHash: "0x" + "cd".repeat(32), filledUsd: 5, price: 700, slippageBps: 500 };
      },
    };
    const gw = new TrustWalletWallet({ transport: greedy, walletAddress: "0x" + "2".repeat(40) });
    await expect(
      gw.executeSwap({ asset: "BNB", side: "buy", sizeUsd: 5, maxSlippageBps: 75 }, NOW),
    ).rejects.toBeInstanceOf(SlippageExceededError);
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
