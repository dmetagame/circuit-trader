import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  runTick,
  FixtureMarketSource,
  CmcMcpSource,
  SimulatedWallet,
  initState,
  markHighWater,
  parseConstitution,
  type Constitution,
  type McpTransport,
  type OrchestratorConfig,
  type RuntimeState,
  type StrategyConfig,
  type Synthesizer,
} from "../src/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(join(__dirname, "../src/example.constitution.json"), "utf8"));
const NOW = "2026-06-16T12:00:00.000Z";

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

const config = (o: Partial<OrchestratorConfig> = {}): OrchestratorConfig => ({
  strategy: CFG,
  sizing: { baseTradeUsd: 8, minStrengthToTrade: 0.1 },
  assets: ["BNB"],
  ...o,
});

const confirm: Synthesizer = {
  async synthesize() {
    return { recommendedAction: "buy", confidence: 0.9, riskLevel: "low", rationale: "confirmed" };
  },
};

describe("runTick", () => {
  it("runs the full loop and executes a cleared buy", async () => {
    const wallet = new SimulatedWallet({ reserveUsd: 100, prices: { BNB: 600 }, riskScores: { BNB: 15 }, slippageBps: 20 });
    const market = new FixtureMarketSource({ BNB: { asset: "BNB", closes: noisyUp(40), narrativeScore: 0.5 } });

    const tick = await runTick({
      constitution: constitution(),
      state: initState(100, NOW),
      wallet,
      market,
      synthesizer: confirm,
      config: config(),
      now: NOW,
    });

    const bnb = tick.results.find((r) => r.asset === "BNB")!;
    expect(bnb.decision?.allowed).toBe(true);
    expect(bnb.fill).not.toBeNull();
    expect(bnb.audit.join(" ")).toContain("EXECUTED");
    expect(tick.state.tradesToday).toBe(1);
    expect(tick.portfolioAfter.positions.BNB).toBeGreaterThan(0);
    expect(tick.state.equityUsd).toBeCloseTo(tick.portfolioAfter.equityUsd, 2);
  });

  it("holds (no fill) when the signal is hold", async () => {
    const wallet = new SimulatedWallet({ reserveUsd: 100, prices: { BNB: 600 } });
    const market = new FixtureMarketSource({ BNB: { asset: "BNB", closes: new Array(40).fill(100) } });

    const tick = await runTick({
      constitution: constitution(),
      state: initState(100, NOW),
      wallet,
      market,
      synthesizer: confirm,
      config: config(),
      now: NOW,
    });

    const bnb = tick.results.find((r) => r.asset === "BNB")!;
    expect(bnb.signal.action).toBe("hold");
    expect(bnb.decision).toBeNull();
    expect(bnb.fill).toBeNull();
    expect(tick.state.tradesToday).toBe(0);
  });

  it("trips the circuit breaker on a crash and engages the kill switch (no trades)", async () => {
    const wallet = new SimulatedWallet({ reserveUsd: 10, prices: { BNB: 600 }, positionsUnits: { BNB: 0.15 } });
    const market = new FixtureMarketSource({ BNB: { asset: "BNB", closes: noisyUp(40) } });

    // Establish a high-water mark of ~100 at the pre-crash price.
    const seeded: RuntimeState = markHighWater({ ...initState(0, NOW), equityUsd: 100, highWaterMarkUsd: 100 });

    wallet.setPrice("BNB", 300); // crash -> equity ~55 -> ~45% drawdown vs HWM 100

    const tick = await runTick({
      constitution: constitution(), // maxDrawdownPct = 20
      state: seeded,
      wallet,
      market,
      synthesizer: confirm,
      config: config(),
      now: NOW,
    });

    expect(tick.killSwitchEngaged).toBe(true);
    expect(tick.state.killSwitchEngaged).toBe(true);
    expect(tick.note).toContain("circuit breaker");
    expect(tick.results).toHaveLength(0); // bailed before scanning assets
  });

  it("does nothing once the kill switch is already engaged", async () => {
    const wallet = new SimulatedWallet({ reserveUsd: 100, prices: { BNB: 600 } });
    const market = new FixtureMarketSource({ BNB: { asset: "BNB", closes: noisyUp(40) } });
    const state: RuntimeState = { ...initState(100, NOW), killSwitchEngaged: true, killSwitchReason: "manual" };

    const tick = await runTick({ constitution: constitution(), state, wallet, market, synthesizer: confirm, config: config(), now: NOW });
    expect(tick.killSwitchEngaged).toBe(true);
    expect(tick.results).toHaveLength(0);
    expect(tick.note).toContain("no trading");
  });
});

describe("CmcMcpSource (adapter over a mock MCP transport)", () => {
  const transport: McpTransport = {
    async callTool(name) {
      switch (name) {
        case "cryptocurrency_quotes_historical":
          return { data: [{ close: 100 }, { close: 101 }, { close: 102 }] };
        case "cryptocurrency_trending_latest":
          return { sentimentScore: 0.42 };
        case "derivatives_funding_rate":
          return { fundingRate: 0.0005 }; // -> 0.05%
        default:
          throw new Error(`unexpected tool ${name}`);
      }
    },
  };

  it("parses closes and soft context", async () => {
    const src = new CmcMcpSource({ transport });
    const m = await src.getMarketData("BNB");
    expect(m.closes).toEqual([100, 101, 102]);
    expect(m.narrativeScore).toBeCloseTo(0.42);
    expect(m.fundingRatePct).toBeCloseTo(0.05);
  });

  it("still returns prices when a soft signal tool fails", async () => {
    const flaky: McpTransport = {
      async callTool(name) {
        if (name === "cryptocurrency_quotes_historical") return { closes: [10, 11, 12] };
        throw new Error("soft tool down");
      },
    };
    const src = new CmcMcpSource({ transport: flaky });
    const m = await src.getMarketData("BNB");
    expect(m.closes).toEqual([10, 11, 12]);
    expect(m.narrativeScore).toBeUndefined();
    expect(m.fundingRatePct).toBeUndefined();
  });
});
