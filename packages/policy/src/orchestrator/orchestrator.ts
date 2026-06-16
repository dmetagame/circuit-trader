import type { Constitution } from "../constitution.js";
import { evaluate } from "../policy-engine.js";
import {
  engageKillSwitch as engageKill,
  markHighWater,
  recordExecution,
  rollDay,
  type RuntimeState,
} from "../state.js";
import { generateSignal, signalFromIndicators, type Signal, type StrategyConfig } from "../strategy/signals.js";
import { deterministicSynthesizer, type Synthesizer, type Verdict } from "../strategy/synthesizer.js";
import { buildProposalFromSignal, type SizingConfig } from "../strategy/strategy.js";
import { SlippageExceededError, type Fill, type Portfolio, type Wallet } from "../execution/wallet.js";
import type { PolicyDecision } from "../types.js";
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
}

function drawdownPct(state: RuntimeState): number {
  const hwm = Math.max(state.highWaterMarkUsd, state.equityUsd);
  return hwm > 0 ? ((hwm - state.equityUsd) / hwm) * 100 : 0;
}

/** Pull balance truth from the wallet into state, roll the day, raise the high-water mark. */
function reconcile(state: RuntimeState, pf: Portfolio, now: string): RuntimeState {
  return markHighWater(
    rollDay({ ...state, equityUsd: pf.equityUsd, reserveUsd: pf.reserveUsd, positions: pf.positions }, now),
  );
}

/**
 * One orchestration tick: reconcile balances → check the circuit breaker → for each asset
 * { signal → verdict → policy → execute }. Pure w.r.t. persistence — give it the prior state,
 * get back the new state and a full per-asset audit. Run it from a Vercel Cron route, a worker,
 * or a test; behaviour is identical.
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
        const ep = decision.effectiveProposal;
        try {
          const fill = await wallet.executeSwap(
            { asset: ep.asset, side: ep.side, sizeUsd: ep.sizeUsd, maxSlippageBps: c.perTrade.maxSlippageBps, ...(ep.quoteId ? { quoteId: ep.quoteId } : {}) },
            now,
          );
          r.fill = fill;
          state = recordExecution(state, ep, fill.filledUsd, fill.executedAt);
          // Refresh balances so later assets in this tick see accurate reserve/exposure.
          state = reconcile(state, await wallet.getPortfolio(), now);
          r.audit.push(`EXECUTED ${ep.side} ${fill.filledUsd} USD ${asset} @ ${fill.price} → ${fill.txHash}`);
        } catch (e) {
          r.error = e instanceof SlippageExceededError ? e.message : e instanceof Error ? e.message : String(e);
          r.audit.push(`EXECUTION FAILED: ${r.error}`);
        }
      }
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      r.audit.push(`ERROR: ${r.error}`);
    }
    results.push(r);
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
