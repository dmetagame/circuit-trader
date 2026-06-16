import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  generateSignal,
  proposeTrade,
  deterministicSynthesizer,
  evaluate,
  initState,
  parseConstitution,
  indicators,
  type StrategyConfig,
  type AssetMarketData,
  type SizingConfig,
  type Synthesizer,
  type Constitution,
  type RuntimeState,
} from "../src/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(join(__dirname, "../src/example.constitution.json"), "utf8"));
const NOW = "2026-06-16T12:00:00.000Z";

// Test config: relax overbought so a clean uptrend reads as a momentum BUY rather than overbought SELL.
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

const ramp = (start: number, step: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => start + step * i);

// A realistic uptrend: rises overall but pulls back periodically, so RSI stays < overbought
// (a pure linear ramp pins RSI at 100 and reads as overbought → sell).
const noisyUp = (n: number): number[] => {
  const deltas = [3, 3, -1];
  const closes = [100];
  for (let i = 0; i < n - 1; i++) closes.push((closes[closes.length - 1] as number) + (deltas[i % 3] as number));
  return closes;
};

describe("indicators", () => {
  it("sma / roc / rsi / zscore compute as expected", () => {
    expect(indicators.sma([2, 4, 6], 3)).toBeCloseTo(4);
    expect(indicators.roc([100, 110], 1)).toBeCloseTo(10);
    expect(indicators.rsi([1, 1, 1, 1, 1], 4)).toBe(50); // no movement
    expect(indicators.rsi([1, 2, 3, 4, 5], 4)).toBe(100); // only gains
    expect(indicators.zscore([5, 5, 5, 5], 4)).toBe(0); // flat window
  });
});

describe("generateSignal", () => {
  it("returns BUY on a healthy uptrend", () => {
    const s = generateSignal(noisyUp(40), CFG, "BNB");
    expect(s.action).toBe("buy");
    expect(s.strength).toBeGreaterThan(0);
  });

  it("returns SELL on a downtrend", () => {
    const s = generateSignal(ramp(160, -2, 30), CFG, "BNB");
    expect(s.action).toBe("sell");
  });

  it("HOLDs on a flat series", () => {
    const s = generateSignal(new Array(30).fill(100), CFG, "BNB");
    expect(s.action).toBe("hold");
  });

  it("HOLDs when there is not enough data", () => {
    const s = generateSignal([100, 101, 102], CFG, "BNB");
    expect(s.action).toBe("hold");
    expect(s.indicators).toBeNull();
  });
});

const sizing: SizingConfig = { baseTradeUsd: 8, minStrengthToTrade: 0.1 };

function market(overrides: Partial<AssetMarketData> = {}): AssetMarketData {
  return { asset: "BNB", closes: noisyUp(40), tokenRiskScore: 20, ...overrides };
}

describe("proposeTrade", () => {
  it("produces a BUY proposal on an uptrend (deterministic synthesizer)", async () => {
    const out = await proposeTrade({ market: market(), strategy: CFG, sizing, now: NOW });
    expect(out.proposal).not.toBeNull();
    expect(out.proposal?.side).toBe("buy");
    expect(out.proposal?.sizeUsd).toBeGreaterThan(0);
    expect(out.verdict?.recommendedAction).toBe("buy");
  });

  it("returns no proposal when the signal is hold", async () => {
    const out = await proposeTrade({
      market: market({ closes: new Array(30).fill(100) }),
      strategy: CFG,
      sizing,
      now: NOW,
    });
    expect(out.proposal).toBeNull();
    expect(out.note).toContain("no trade");
  });

  it("lets the LLM VETO by capping confidence on disagreement", async () => {
    const vetoer: Synthesizer = {
      async synthesize() {
        return { recommendedAction: "sell", confidence: 0.9, riskLevel: "high", rationale: "macro risk-off" };
      },
    };
    const out = await proposeTrade({
      market: market(),
      strategy: CFG,
      sizing,
      synthesizer: vetoer,
      now: NOW,
      disagreementConfidenceCap: 0.25,
    });
    expect(out.proposal?.side).toBe("buy"); // signal still owns direction
    expect(out.proposal?.signalConfidence).toBeLessThanOrEqual(0.25); // but confidence is vetoed down
    expect(out.note).toContain("vetoed");
  });

  it("narrative alignment nudges deterministic confidence up", async () => {
    const aligned = await deterministicSynthesizer.synthesize({
      asset: "BNB",
      signal: { asset: "BNB", action: "buy", strength: 0.5, reason: "x", indicators: null },
      context: { tokenRiskScore: 10, narrativeScore: 0.8 },
    });
    expect(aligned.confidence).toBeGreaterThan(0.5);
    expect(aligned.riskLevel).toBe("low");
  });
});

describe("end-to-end: strategy proposal → policy engine", () => {
  function baseState(overrides: Partial<RuntimeState> = {}): RuntimeState {
    return { ...initState(100, NOW), ...overrides };
  }
  function constitution(overrides: Partial<Constitution> = {}): Constitution {
    return parseConstitution({ ...RAW, ...overrides });
  }

  it("a high-confidence proposal clears the policy gate (clamped to max)", async () => {
    const highConf: Synthesizer = {
      async synthesize() {
        return { recommendedAction: "buy", confidence: 0.85, riskLevel: "low", rationale: "aligned" };
      },
    };
    const out = await proposeTrade({
      market: market(),
      strategy: CFG,
      sizing,
      synthesizer: highConf,
      now: NOW,
      quote: { expectedSlippageBps: 30, quoteId: "q1" },
    });
    expect(out.proposal).not.toBeNull();

    const decision = evaluate({ constitution: constitution(), state: baseState(), proposal: out.proposal!, now: NOW });
    expect(decision.allowed).toBe(true);
    expect(decision.effectiveProposal!.sizeUsd).toBeLessThanOrEqual(5); // clamped to maxTradeUsd
  });

  it("a vetoed proposal is denied by the policy gate (confidence too low)", async () => {
    const vetoer: Synthesizer = {
      async synthesize() {
        return { recommendedAction: "hold", confidence: 0.2, riskLevel: "high", rationale: "veto" };
      },
    };
    const out = await proposeTrade({ market: market(), strategy: CFG, sizing, synthesizer: vetoer, now: NOW });
    const decision = evaluate({ constitution: constitution(), state: baseState(), proposal: out.proposal!, now: NOW });
    expect(decision.allowed).toBe(false);
    expect(decision.violations.map((v) => v.code)).toContain("CONFIDENCE_TOO_LOW");
  });
});
