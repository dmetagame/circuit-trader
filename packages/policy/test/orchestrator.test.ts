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
    const checkpoints: string[] = [];

    const tick = await runTick({
      constitution: constitution(),
      state: initState(100, NOW),
      wallet,
      market,
      synthesizer: confirm,
      config: config(),
      now: NOW,
      executionObserver: {
        async beforeExecution(intent) {
          checkpoints.push(`before:${intent.executionId}`);
        },
        async afterExecution(intent, _fill, state) {
          expect(state.recordedExecutionIds).toContain(intent.executionId);
          checkpoints.push(`after:${intent.executionId}`);
        },
        async afterRejection() {},
      },
    });

    const bnb = tick.results.find((r) => r.asset === "BNB")!;
    expect(bnb.decision?.allowed).toBe(true);
    expect(bnb.fill).not.toBeNull();
    expect(bnb.audit.join(" ")).toContain("EXECUTED");
    expect(tick.state.tradesToday).toBe(1);
    expect(tick.portfolioAfter.positions.BNB).toBeGreaterThan(0);
    expect(tick.state.equityUsd).toBeCloseTo(tick.portfolioAfter.equityUsd, 2);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatch(/^before:dec_/);
    expect(checkpoints[1]).toBe(checkpoints[0]?.replace("before:", "after:"));
  });

  it("stops the tick when a settled fill cannot be durably checkpointed", async () => {
    const wallet = new SimulatedWallet({ reserveUsd: 100, prices: { BNB: 600 }, riskScores: { BNB: 15 }, slippageBps: 20 });
    const market = new FixtureMarketSource({ BNB: { asset: "BNB", closes: noisyUp(40) } });
    await expect(
      runTick({
        constitution: constitution(),
        state: initState(100, NOW),
        wallet,
        market,
        synthesizer: confirm,
        config: config(),
        now: NOW,
        executionObserver: {
          async beforeExecution() {},
          async afterExecution() {
            throw new Error("disk unavailable");
          },
          async afterRejection() {},
        },
      }),
    ).rejects.toThrow("could not checkpoint settled execution");
    expect((await wallet.getPortfolio()).reserveUsd).toBeLessThan(100);
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

describe("CmcMcpSource (adapter over a mock MCP transport — live tool surface)", () => {
  // Shapes mirror the real CoinMarketCap Agent Hub MCP (verified 2026-06-16).
  const transport: McpTransport = {
    async callTool(name, args) {
      switch (name) {
        case "get_crypto_technical_analysis":
          return {
            // Note the thousands separator on the slow SMA — CMC formats large numbers this way.
            moving_averages: { simple_moving_average_7_day: "604.37", simple_moving_average_30_day: "1,633.99" },
            rsi: { rsi7: "53.64", rsi14: "47.97", rsi21: "47.57" },
            macd: { macdLine: "-11.15" },
          };
        case "get_crypto_quotes_latest":
          return [{ id: args.id, symbol: "BNB", price: 606.4, percent_change_7d: 2.69, percent_change_24h: -3.0, volume_change_24h: 7.75 }];
        case "search_cryptos":
          return [{ id: 99999, symbol: String(args.query), name: String(args.query) }];
        default:
          throw new Error(`unexpected tool ${name}`);
      }
    },
  };

  it("maps technical analysis + latest quote into precomputed signal indicators", async () => {
    const src = new CmcMcpSource({ transport, rocWindow: "7d" });
    const m = await src.getMarketData("BNB"); // BNB id is statically known -> no search call
    expect(m.indicators).toMatchObject({ smaFast: 604.37, smaSlow: 1633.99, rsi: 47.97, roc: 2.69, turningUp: false });
    expect(m.priceUsd).toBeCloseTo(606.4);
    expect(m.volumeChangePct).toBeCloseTo(7.75);
    expect(m.closes).toEqual([]); // indicators path supplies no candle series
  });

  it("resolves an unknown symbol via search_cryptos", async () => {
    let searched = false;
    const t: McpTransport = {
      async callTool(name, args) {
        if (name === "search_cryptos") {
          searched = true;
          return [{ id: 1839, symbol: "BNB" }];
        }
        return transport.callTool(name, args);
      },
    };
    const src = new CmcMcpSource({ transport: t });
    await src.getMarketData("WIF"); // not in the static id map
    expect(searched).toBe(true);
  });

  it("throws when technical analysis is incomplete", async () => {
    const bad: McpTransport = {
      async callTool(name) {
        if (name === "get_crypto_technical_analysis") return { moving_averages: {}, rsi: {} };
        return [{ price: 1 }];
      },
    };
    const src = new CmcMcpSource({ transport: bad });
    await expect(src.getMarketData("BNB")).rejects.toThrow(/incomplete/);
  });
});
