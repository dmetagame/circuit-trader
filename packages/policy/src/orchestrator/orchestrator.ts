import type { Constitution } from "../constitution.js";
import { evaluate } from "../policy-engine.js";
import {
  engageKillSwitch as engageKill,
  markHighWater,
  recordComplianceRoundTrip,
  recordExecution,
  rollDay,
  type RuntimeState,
} from "../state.js";
import { generateSignal, signalFromIndicators, type Signal, type StrategyConfig } from "../strategy/signals.js";
import { deterministicSynthesizer, type Synthesizer, type Verdict } from "../strategy/synthesizer.js";
import { buildComplianceProposal, buildProposalFromSignal, type SizingConfig } from "../strategy/strategy.js";
import { ExecutionRejectedError, type Fill, type Portfolio, type SwapOrder, type Wallet } from "../execution/wallet.js";
import type { PolicyDecision, TradeSide } from "../types.js";
import type { MarketDataSource, MarketSignals } from "./market-source.js";

/** Use precomputed indicators when the source provides them (live CMC), else compute from closes. */
function computeSignal(signals: MarketSignals, cfg: StrategyConfig, asset: string): Signal {
  return signals.indicators ? signalFromIndicators(signals.indicators, cfg, asset) : generateSignal(signals.closes, cfg, asset);
}

export interface OrchestratorConfig {
  strategy: StrategyConfig;
  sizing: SizingConfig;
  /** Assets to scan each tick (should be a subset of the constitution's allowlist). */
  assets: string[];
  disagreementConfidenceCap?: number;
  /**
   * Mandated daily compliance round trip. When enabled, if no round trip has completed in the
   * current UTC day, the orchestrator runs one minimal net-flat round trip on `asset` so the
   * agent stays in the rankings even on days the strategy stands down. `afterUtcHour` (default 0)
   * delays it until a chosen UTC hour, giving the strategy first chance to trade naturally.
   */
  compliance?: { enabled: boolean; asset: string; afterUtcHour?: number };
}

export interface AssetTickResult {
  asset: string;
  signal: Signal;
  verdict: Verdict | null;
  /** null when the strategy proposed nothing (hold / low conviction). */
  decision: PolicyDecision | null;
  fill: Fill | null;
  error: string | null;
  audit: string[];
}

export interface TickResult {
  now: string;
  state: RuntimeState;
  portfolioBefore: Portfolio;
  portfolioAfter: Portfolio;
  results: AssetTickResult[];
  killSwitchEngaged: boolean;
  note: string;
}

export interface TickInput {
  constitution: Constitution;
  state: RuntimeState;
  wallet: Wallet;
  market: MarketDataSource;
  config: OrchestratorConfig;
  now: string;
  /** Defaults to the no-LLM deterministic synthesizer. */
  synthesizer?: Synthesizer;
  executionObserver?: ExecutionObserver;
}

export interface ExecutionIntent {
  executionId: string;
  decisionId: string;
  evaluatedAt: string;
  order: SwapOrder;
  portfolioBefore: Portfolio;
}

export interface ExecutionObserver {
  /** Must durably record intent before the wallet is allowed to submit a transaction. */
  beforeExecution(intent: ExecutionIntent): Promise<void>;
  /** Must durably checkpoint the returned fill and updated state before another order. */
  afterExecution(intent: ExecutionIntent, fill: Fill, state: RuntimeState): Promise<void>;
  /** Clear a write-ahead intent after the wallet guarantees no transaction was submitted. */
  afterRejection(intent: ExecutionIntent, error: ExecutionRejectedError): Promise<void>;
}

export class ExecutionPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutionPersistenceError";
  }
}

function drawdownPct(state: RuntimeState): number {
  const hwm = Math.max(state.highWaterMarkUsd, state.equityUsd);
  return hwm > 0 ? ((hwm - state.equityUsd) / hwm) * 100 : 0;
}

/** Pull balance truth from the wallet into state, roll the day, raise the high-water mark. */
function reconcile(state: RuntimeState, pf: Portfolio, now: string): RuntimeState {
  return markHighWater(
    rollDay({
      ...state,
      equityUsd: pf.equityUsd,
      initialEquityUsd: state.initialEquityUsd > 0 ? state.initialEquityUsd : pf.equityUsd,
      reserveUsd: pf.reserveUsd,
      positions: pf.positions,
    }, now),
  );
}

/**
 * One orchestration tick: reconcile balances → check the circuit breaker → for each asset
 * { signal → verdict → policy → execute }. Pure w.r.t. persistence — give it the prior state,
 * get back the new state and a full per-asset audit. Real execution requires a persistent host
 * with an execution observer; simulations can call it directly.
 */
export async function runTick(input: TickInput): Promise<TickResult> {
  const { constitution: c, wallet, market, config, now } = input;
  const synthesizer = input.synthesizer ?? deterministicSynthesizer;
  const results: AssetTickResult[] = [];

  const portfolioBefore = await wallet.getPortfolio();
  let state = reconcile(input.state, portfolioBefore, now);

  // Already halted — do nothing this tick.
  if (state.killSwitchEngaged) {
    return {
      now,
      state,
      portfolioBefore,
      portfolioAfter: portfolioBefore,
      results,
      killSwitchEngaged: true,
      note: `kill switch engaged: ${state.killSwitchReason ?? "unknown"} — no trading`,
    };
  }

  // Circuit breaker pre-check — trips even on a no-trade tick (protects the unattended window).
  const dd = drawdownPct(state);
  if (dd >= c.riskGates.maxDrawdownPct) {
    const reason = `drawdown ${dd.toFixed(2)}% >= cap ${c.riskGates.maxDrawdownPct}%`;
    state = engageKill(state, reason);
    return {
      now,
      state,
      portfolioBefore,
      portfolioAfter: portfolioBefore,
      results,
      killSwitchEngaged: true,
      note: `circuit breaker tripped — ${reason}`,
    };
  }

  for (const asset of config.assets) {
    const r: AssetTickResult = { asset, signal: emptySignal(asset), verdict: null, decision: null, fill: null, error: null, audit: [] };
    try {
      const signals = await market.getMarketData(asset);
      const tokenRiskScore = await wallet.getTokenRiskScore(asset);

      // Decide the signal (precomputed indicators from CMC, or computed from closes), so we
      // can fetch a side-correct quote before building the proposal.
      const signal = computeSignal(signals, config.strategy, asset);
      r.signal = signal;
      if (signal.action === "hold" || signal.strength < config.sizing.minStrengthToTrade) {
        r.audit.push(`HOLD ${asset}: ${signal.reason}`);
        results.push(r);
        continue;
      }

      const quote = await wallet.getQuote({ asset, side: signal.action, sizeUsd: config.sizing.baseTradeUsd * signal.strength });
      const out = await buildProposalFromSignal({
        signal,
        asset,
        tokenRiskScore,
        soft: { fundingRatePct: signals.fundingRatePct, narrativeScore: signals.narrativeScore, volumeChangePct: signals.volumeChangePct },
        sizing: config.sizing,
        synthesizer,
        now,
        quote: { expectedSlippageBps: quote.expectedSlippageBps, quoteId: quote.quoteId },
        ...(config.disagreementConfidenceCap != null ? { disagreementConfidenceCap: config.disagreementConfidenceCap } : {}),
      });
      r.verdict = out.verdict;

      if (!out.proposal) {
        r.audit.push(out.note);
        results.push(r);
        continue;
      }

      const decision = evaluate({ constitution: c, state, proposal: out.proposal, now });
      r.decision = decision;
      r.audit.push(...decision.audit);

      if (decision.engageKillSwitch) {
        state = engageKill(state, decision.killSwitchReason ?? "terminal gate");
        results.push(r);
        break; // stop trading for the rest of the tick
      }

      if (decision.allowed && decision.effectiveProposal) {
        state = await executeAllowedDecision({ decision, constitution: c, wallet, observer: input.executionObserver, state, now, result: r });
      }
    } catch (e) {
      if (e instanceof ExecutionPersistenceError) throw e;
      r.error = e instanceof Error ? e.message : String(e);
      r.audit.push(`ERROR: ${r.error}`);
    }
    results.push(r);
  }

  // --- Mandated daily compliance round trip ---
  // Run one minimal, net-flat round trip if enabled and none has completed this UTC day, so the
  // agent stays ranked even when the strategy stood down. Each leg passes the full constitution.
  const comp = config.compliance;
  const today = now.slice(0, 10);
  if (
    comp?.enabled &&
    !state.killSwitchEngaged &&
    state.lastComplianceDayUtc !== today &&
    new Date(now).getUTCHours() >= (comp.afterUtcHour ?? 0)
  ) {
    state = await complianceRoundTrip({
      asset: comp.asset,
      constitution: c,
      wallet,
      observer: input.executionObserver,
      state,
      now,
      results,
    });
  }

  const portfolioAfter = await wallet.getPortfolio();
  state = reconcile(state, portfolioAfter, now);

  return {
    now,
    state,
    portfolioBefore,
    portfolioAfter,
    results,
    killSwitchEngaged: state.killSwitchEngaged,
    note: state.killSwitchEngaged ? `kill switch engaged: ${state.killSwitchReason ?? "unknown"}` : `tick complete (${results.length} assets)`,
  };
}

function emptySignal(asset: string): Signal {
  return { asset, action: "hold", strength: 0, reason: "not evaluated", indicators: null };
}

/**
 * Settle one ALLOWED decision through the wallet with write-ahead journaling. Shared by the
 * per-asset loop and the compliance round trip so both get identical crash-safety semantics.
 * Mutates `result` (fill/error/audit) and returns the new state. Rethrows ExecutionPersistenceError.
 */
async function executeAllowedDecision(args: {
  decision: PolicyDecision;
  constitution: Constitution;
  wallet: Wallet;
  observer?: ExecutionObserver;
  state: RuntimeState;
  now: string;
  result: AssetTickResult;
}): Promise<RuntimeState> {
  const { decision, constitution: c, wallet, observer, now, result: r } = args;
  let state = args.state;
  const ep = decision.effectiveProposal!;
  const order: SwapOrder = {
    asset: ep.asset,
    side: ep.side,
    sizeUsd: ep.sizeUsd,
    maxSlippageBps: c.perTrade.maxSlippageBps,
    ...(ep.quoteId ? { quoteId: ep.quoteId } : {}),
  };
  const intent: ExecutionIntent = {
    executionId: decision.decisionId,
    decisionId: decision.decisionId,
    evaluatedAt: decision.evaluatedAt,
    order,
    portfolioBefore: { reserveUsd: state.reserveUsd, positions: { ...state.positions }, equityUsd: state.equityUsd },
  };
  try {
    if (observer) {
      try {
        await observer.beforeExecution(intent);
      } catch (error) {
        throw new ExecutionPersistenceError("could not persist execution intent", { cause: error });
      }
    }
    const fill = await wallet.executeSwap(order, now);
    r.fill = fill;
    state = recordExecution(state, ep, fill.filledUsd, fill.executedAt, intent.executionId);
    // Refresh balances so later orders this tick see accurate reserve/exposure.
    state = reconcile(state, await wallet.getPortfolio(), now);
    if (observer) {
      try {
        await observer.afterExecution(intent, fill, state);
      } catch (error) {
        throw new ExecutionPersistenceError("could not checkpoint settled execution", { cause: error });
      }
    }
    if (fill.slippageBps > c.perTrade.maxSlippageBps) {
      r.audit.push(`SETTLED WARNING: realized slippage ${fill.slippageBps}bps exceeded requested cap ${c.perTrade.maxSlippageBps}bps`);
    }
    r.audit.push(`EXECUTED ${ep.side} ${fill.filledUsd} USD ${ep.asset} @ ${fill.price} → ${fill.txHash}`);
  } catch (e) {
    if (e instanceof ExecutionPersistenceError) throw e;
    if (observer) {
      if (!(e instanceof ExecutionRejectedError)) {
        throw new ExecutionPersistenceError("wallet outcome is ambiguous; execution journal retained", { cause: e });
      }
      try {
        await observer.afterRejection(intent, e);
      } catch (error) {
        throw new ExecutionPersistenceError("could not clear rejected execution intent", { cause: error });
      }
    }
    r.error = e instanceof Error ? e.message : String(e);
    r.audit.push(`EXECUTION FAILED: ${r.error}`);
  }
  return state;
}

function complianceResult(asset: string, side: TradeSide | "hold" = "hold"): AssetTickResult {
  return {
    asset,
    signal: { asset, action: side, strength: 0, reason: "compliance round-trip leg", indicators: null },
    verdict: null,
    decision: null,
    fill: null,
    error: null,
    audit: [],
  };
}

/**
 * Execute one minimal net-flat compliance round trip on `asset`. Ordering is chosen for safety:
 * if we already hold the asset we SELL then BUY (a failed second leg leaves us *more* in reserve,
 * never over-exposed); otherwise BUY then SELL. Marks the day done only if BOTH legs fill.
 */
async function complianceRoundTrip(args: {
  asset: string;
  constitution: Constitution;
  wallet: Wallet;
  observer?: ExecutionObserver;
  state: RuntimeState;
  now: string;
  results: AssetTickResult[];
}): Promise<RuntimeState> {
  const { asset, constitution: c, wallet, observer, now, results } = args;
  let state = args.state;
  const today = now.slice(0, 10);
  const sizeUsd = c.perTrade.minTradeUsd;
  const held = state.positions[asset] ?? 0;
  const legs: TradeSide[] = held >= sizeUsd ? ["sell", "buy"] : ["buy", "sell"];

  let tokenRiskScore: number;
  try {
    tokenRiskScore = await wallet.getTokenRiskScore(asset);
  } catch (e) {
    const r = complianceResult(asset);
    r.error = e instanceof Error ? e.message : String(e);
    r.audit.push(`COMPLIANCE ABORTED: token risk lookup failed: ${r.error}`);
    results.push(r);
    return state;
  }

  let bothFilled = true;
  for (const side of legs) {
    const r = complianceResult(asset, side);
    let quote: { expectedSlippageBps: number; quoteId: string };
    try {
      quote = await wallet.getQuote({ asset, side, sizeUsd });
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      r.audit.push(`COMPLIANCE ${side} ABORTED: quote failed: ${r.error}`);
      results.push(r);
      bothFilled = false;
      break;
    }
    const proposal = buildComplianceProposal({
      asset,
      side,
      sizeUsd,
      tokenRiskScore,
      now,
      quote: { expectedSlippageBps: quote.expectedSlippageBps, ...(quote.quoteId ? { quoteId: quote.quoteId } : {}) },
    });
    const decision = evaluate({ constitution: c, state, proposal, now });
    r.decision = decision;
    r.audit.push(...decision.audit);

    if (decision.engageKillSwitch) {
      state = engageKill(state, decision.killSwitchReason ?? "terminal gate");
      results.push(r);
      bothFilled = false;
      break;
    }
    if (!(decision.allowed && decision.effectiveProposal)) {
      r.audit.push(`COMPLIANCE ${side} DENIED — round trip incomplete this tick`);
      results.push(r);
      bothFilled = false;
      break;
    }

    state = await executeAllowedDecision({ decision, constitution: c, wallet, observer, state, now, result: r });
    results.push(r);
    if (r.error) {
      bothFilled = false;
      break;
    }
  }

  if (bothFilled) {
    state = recordComplianceRoundTrip(state, today);
  }
  return state;
}
