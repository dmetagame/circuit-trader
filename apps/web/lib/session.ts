import {
  runTick,
  SimulatedWallet,
  FixtureMarketSource,
  constitutionDigest,
  initState,
  parseConstitution,
  type AssetTickResult,
  type Constitution,
  type RuntimeState,
  type StrategyConfig,
  type Synthesizer,
  type TickResult,
} from "circuit-trader-policy";

/**
 * Server-side demo session. Drives the policy engine with a SimulatedWallet on a scripted
 * price path so the whole story is deterministic and luck-proof: run ticks to see
 * EXECUTED / CLAMPED / DENIED beats, then "crash" to trip the circuit breaker.
 *
 * Swap `SimulatedWallet` for `TrustWalletWallet` and `FixtureMarketSource` for `CmcMcpSource`
 * to go live — nothing else here changes.
 */

const DEMO_CONSTITUTION = {
  schemaVersion: "1.0.0",
  agentId: "circuit-trader-demo",
  chainId: 56,
  walletAddress: "0x1111111111111111111111111111111111111111",
  issuedAt: "2026-06-16T00:00:00.000Z",
  expiresAt: null,
  allowedAssets: ["USDT", "BNB", "ETH", "SCAM"],
  reserveAsset: "USDT",
  perTrade: { minTradeUsd: 5, maxTradeUsd: 25, maxSlippageBps: 75 },
  riskGates: { maxDrawdownPct: 20, dailyLossLimitPct: 50, minSignalConfidence: 0.6, maxTokenRiskScore: 40 },
  portfolio: { maxConcentrationPctPerAsset: 70, maxPortfolioExposurePct: 90 },
  activity: { cooldownMinutesPerAsset: 0, minTradeIntervalSeconds: 0, maxTradesPerDay: 50 },
  enforcement: { clampOversizedTrades: true, killSwitch: false },
  signature: null,
};

const DEMO_STRATEGY: StrategyConfig = {
  smaFastPeriod: 5,
  smaSlowPeriod: 10,
  rsiPeriod: 14,
  rocPeriod: 5,
  zscorePeriod: 10,
  rsiOverbought: 95, // a clean uptrend reads as momentum, not overbought
  rsiOversold: 30,
  rocBuyThresholdPct: 0.5,
  zscoreEntryMax: 3,
};

const SIZING = { baseTradeUsd: 40, minStrengthToTrade: 0.1 };
const ASSETS = ["BNB", "SCAM"];
const DELTAS = [3, 3, -1];

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

// Demo synthesizer: confirms the deterministic signal with high confidence (no API key needed).
// Production swaps this for claudeSynthesizer().
const demoSynthesizer: Synthesizer = {
  async synthesize({ signal, context }) {
    return {
      recommendedAction: signal.action,
      confidence: clamp01(0.7 + 0.3 * signal.strength),
      riskLevel: context.tokenRiskScore < 25 ? "low" : context.tokenRiskScore < 50 ? "medium" : "high",
      rationale: `Confirmed ${signal.action}: ${signal.reason}`,
    };
  },
};

export type AssetStatus = "EXECUTED" | "CLAMPED" | "DENIED" | "HOLD" | "ERROR" | "BREAKER";

export interface AssetView {
  asset: string;
  status: AssetStatus;
  headline: string;
  sizeUsd: number | null;
  txHash: string | null;
  reason: string | null;
  rationale: string | null;
  audit: string[];
}

export interface TickView {
  index: number;
  now: string;
  note: string;
  killSwitch: boolean;
  equityUsd: number;
  reserveUsd: number;
  drawdownPct: number;
  assets: AssetView[];
}

export interface Snapshot {
  constitution: {
    agentId: string;
    chainId: number;
    walletAddress: string;
    allowedAssets: string[];
    reserveAsset: string;
    nativeAsset?: string;
    minNativeGasReserveUsd?: number;
    maxTradeUsd: number;
    maxDrawdownPct: number;
    minSignalConfidence: number;
    maxTokenRiskScore: number;
    digest?: string;
    signer?: string | null;
  };
  portfolio: { equityUsd: number; reserveUsd: number; positions: Record<string, number> };
  killSwitch: { engaged: boolean; reason: string | null };
  highWaterMarkUsd: number;
  drawdownPct: number;
  initialEquityUsd: number;
  pnlUsd: number;
  returnPct: number;
  tickCount: number;
  timeline: TickView[];
}

class Session {
  private constitution: Constitution = parseConstitution(DEMO_CONSTITUTION);
  private wallet!: SimulatedWallet;
  private state!: RuntimeState;
  private closes!: Record<string, number[]>;
  private counters!: Record<string, number>;
  private tickIndex = 0;
  private timeline: TickView[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    const now = new Date().toISOString();
    this.closes = {
      BNB: this.seed(600, 40),
      SCAM: this.seed(30, 40),
    };
    this.counters = { BNB: 40, SCAM: 40 };
    this.wallet = new SimulatedWallet({
      chainId: 56,
      reserveAsset: "USDT",
      reserveUsd: 100,
      prices: { BNB: this.last("BNB"), SCAM: this.last("SCAM") },
      riskScores: { BNB: 15, SCAM: 90 },
      slippageBps: 25,
    });
    this.state = initState(100, now);
    this.tickIndex = 0;
    this.timeline = [];
  }

  async tick(): Promise<Snapshot> {
    await this.advanceAndRun();
    return this.snapshot();
  }

  async crash(): Promise<Snapshot> {
    // Halve BNB — the demo's circuit-breaker trigger. Next tick's pre-check trips the breaker.
    const crashed = this.last("BNB") * 0.5;
    this.closes.BNB.push(crashed);
    this.wallet.setPrice("BNB", crashed);
    await this.runOnce(); // do NOT advance prices further — just evaluate the crash
    return this.snapshot();
  }

  async snapshot(): Promise<Snapshot> {
    const pf = await this.wallet.getPortfolio();
    const hwm = Math.max(this.state.highWaterMarkUsd, pf.equityUsd);
    return {
      constitution: {
        agentId: this.constitution.agentId,
        chainId: this.constitution.chainId,
        walletAddress: this.constitution.walletAddress,
        allowedAssets: this.constitution.allowedAssets,
        reserveAsset: this.constitution.reserveAsset,
        nativeAsset: this.constitution.nativeAsset,
        minNativeGasReserveUsd: this.constitution.portfolio.minNativeGasReserveUsd,
        maxTradeUsd: this.constitution.perTrade.maxTradeUsd,
        maxDrawdownPct: this.constitution.riskGates.maxDrawdownPct,
        minSignalConfidence: this.constitution.riskGates.minSignalConfidence,
        maxTokenRiskScore: this.constitution.riskGates.maxTokenRiskScore,
        digest: constitutionDigest(this.constitution),
        signer: this.constitution.signature?.signer ?? null,
      },
      portfolio: pf,
      killSwitch: { engaged: this.state.killSwitchEngaged, reason: this.state.killSwitchReason },
      highWaterMarkUsd: hwm,
      drawdownPct: hwm > 0 ? ((hwm - pf.equityUsd) / hwm) * 100 : 0,
      initialEquityUsd: this.state.initialEquityUsd,
      pnlUsd: pf.equityUsd - this.state.initialEquityUsd,
      returnPct: this.state.initialEquityUsd > 0 ? ((pf.equityUsd - this.state.initialEquityUsd) / this.state.initialEquityUsd) * 100 : 0,
      tickCount: this.tickIndex,
      timeline: this.timeline,
    };
  }

  // --- internals ---

  private seed(start: number, n: number): number[] {
    const a = [start];
    for (let i = 0; i < n - 1; i++) a.push((a[a.length - 1] as number) + (DELTAS[i % 3] as number));
    return a;
  }

  private last(asset: string): number {
    const s = this.closes[asset] as number[];
    return s[s.length - 1] as number;
  }

  private async advanceAndRun(): Promise<void> {
    for (const asset of ASSETS) {
      const c = this.counters[asset] as number;
      const next = this.last(asset) + (DELTAS[c % 3] as number);
      this.closes[asset]!.push(next);
      this.counters[asset] = c + 1;
      this.wallet.setPrice(asset, next);
    }
    await this.runOnce();
  }

  private async runOnce(): Promise<void> {
    const now = new Date().toISOString();
    const market = new FixtureMarketSource({
      BNB: { asset: "BNB", closes: this.closes.BNB as number[], narrativeScore: 0.4 },
      SCAM: { asset: "SCAM", closes: this.closes.SCAM as number[], narrativeScore: 0.2 },
    });
    const tick = await runTick({
      constitution: this.constitution,
      state: this.state,
      wallet: this.wallet,
      market,
      synthesizer: demoSynthesizer,
      config: { strategy: DEMO_STRATEGY, sizing: SIZING, assets: ASSETS },
      now,
    });
    this.state = tick.state;
    this.timeline.unshift(this.buildView(tick));
    if (this.timeline.length > 50) this.timeline.pop();
  }

  private buildView(tick: TickResult): TickView {
    const hwm = Math.max(tick.state.highWaterMarkUsd, tick.portfolioAfter.equityUsd);
    const assets: AssetView[] =
      tick.killSwitchEngaged && tick.results.length === 0
        ? [{ asset: "—", status: "BREAKER", headline: tick.note, sizeUsd: null, txHash: null, reason: tick.state.killSwitchReason, rationale: null, audit: [tick.note] }]
        : tick.results.map((r) => this.assetView(r));

    return {
      index: ++this.tickIndex,
      now: tick.now,
      note: tick.note,
      killSwitch: tick.killSwitchEngaged,
      equityUsd: tick.portfolioAfter.equityUsd,
      reserveUsd: tick.portfolioAfter.reserveUsd,
      drawdownPct: hwm > 0 ? ((hwm - tick.portfolioAfter.equityUsd) / hwm) * 100 : 0,
      assets,
    };
  }

  private assetView(r: AssetTickResult): AssetView {
    const base = { asset: r.asset, sizeUsd: null as number | null, txHash: null as string | null, reason: null as string | null, rationale: r.verdict?.rationale ?? null, audit: r.audit };

    if (r.error) return { ...base, status: "ERROR", headline: r.error, reason: r.error };
    if (!r.decision) return { ...base, status: "HOLD", headline: r.signal.reason };
    if (r.decision.engageKillSwitch)
      return { ...base, status: "BREAKER", headline: r.decision.killSwitchReason ?? "circuit breaker", reason: r.decision.killSwitchReason };
    if (!r.decision.allowed) {
      const v = r.decision.violations[0];
      return { ...base, status: "DENIED", headline: v ? `${v.code}: ${v.message}` : "denied", reason: v?.message ?? null };
    }
    const clamped = r.decision.adjustments.length > 0;
    return {
      ...base,
      status: clamped ? "CLAMPED" : "EXECUTED",
      headline: `${r.decision.effectiveProposal?.side} ${r.fill?.filledUsd ?? r.decision.effectiveProposal?.sizeUsd} USD ${r.asset}`,
      sizeUsd: r.fill?.filledUsd ?? r.decision.effectiveProposal?.sizeUsd ?? null,
      txHash: r.fill?.txHash ?? null,
    };
  }
}

// Survive HMR / route module reloads in dev.
const g = globalThis as unknown as { __ctSession?: Session };
export function getSession(): Session {
  if (!g.__ctSession) g.__ctSession = new Session();
  return g.__ctSession;
}
