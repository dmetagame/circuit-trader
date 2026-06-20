# Circuit Trader — Risk Constitution & Policy Engine

> An autonomous BNB-chain trading agent that **cannot trade unless its own signed risk constitution allows it.**

This package is the core differentiator: a **machine-readable, signed policy contract** (the *Risk Constitution*) plus a **pure, deterministic policy engine** that gates every proposed trade. It is framework-agnostic and sits between the strategy/reviewer and Trust Wallet execution.

## Why this exists (and why it wins)

BNB HACK Track 1 evaluates live performance, including return, drawdown, risk-adjusted results,
rule adherence, and replayability. The constitution maps those concerns into explicit controls:

| Competition rule | Constitution lever |
|---|---|
| Drawdown control | `riskGates.maxDrawdownPct` — breaching the signed cap is terminal and engages the kill switch |
| Meaningful execution | `perTrade.minTradeUsd` rejects dust trades |
| Transaction-cost control | `activity.cooldownMinutesPerAsset`, `minTradeIntervalSeconds`, `maxTradesPerDay` |
| Unattended held-out window | engine is **pure & deterministic** — reproducible, auditable, safe to run without a human watching |

The constitution is the survival mechanism; the audit trail makes every decision replayable.

## Architecture

```
CMC signals ─▶ reviewer verdict ─▶ TradeProposal ─▶ [ POLICY ENGINE ] ─▶ allowed?
 (data)         (synthesis)     (intent)          (this package)        │
                                                                        ├─ ALLOW (+maybe clamp) ─▶ Trust Wallet swap on BNB
                                                                        └─ DENY (structured reasons) ─▶ dashboard timeline
```

The reviewer **synthesizes and explains**; it never executes. The default reviewer is deterministic and free; an optional LLM can only confirm or veto. The policy engine and wallet adapter control execution.

## Usage

```ts
import {
  parseConstitution, evaluate, initState, recordExecution, engageKillSwitch,
} from "circuit-trader-policy";

const constitution = parseConstitution(rawJsonFromDiskOrEnv);
let state = initState(100 /* USDT reserve */, new Date().toISOString());

// each cron tick, after building a proposal from CMC + TW data:
const decision = evaluate({ constitution, state, proposal, now: new Date().toISOString() });

if (decision.engageKillSwitch) {
  state = engageKillSwitch(state, decision.killSwitchReason ?? "terminal gate");
}

if (decision.allowed && decision.effectiveProposal) {
  const fill = await trustWallet.swap(decision.effectiveProposal); // Trust Wallet Agent Kit
  state = recordExecution(state, decision.effectiveProposal, fill.filledUsd, fill.executedAt);
}

// always log decision.audit -> dashboard timeline (shows ALLOW / DENY / CLAMP reasons)
```

## The constitution

A signed JSON document (see `src/example.constitution.json`). Validated by a Zod schema (`src/constitution.ts`). Sections: identity, trading universe, per-trade limits, risk gates, portfolio limits, activity/cost controls, enforcement, and an EIP-191 signature over the canonical (key-sorted, signature-stripped) digest — so any post-signing tamper invalidates it. Sign with the agent owner's key via `signConstitution()`; verify with `verifyConstitution()`.

## Decision model

- **Hard gates** (kill switch, expiry, drawdown, daily loss, confidence, token risk, allowlist, cooldown, interval, max-trades, slippage) → `DENY`.
- **Drawdown breach** → `DENY` **+ terminal** → caller engages the kill switch.
- **Sizing** → computes the binding cap from `maxTradeUsd`, reserve, per-asset concentration, and portfolio exposure (buys) or holdings (sells). Oversized trades are **clamped** to the cap when `enforcement.clampOversizedTrades` is true, or denied otherwise. If the cap is below `minTradeUsd`, the trade is `UNCLAMPABLE` → denied.

Every decision carries a structured `violations[]`, `adjustments[]`, and a human-readable `audit[]` — that's what renders on the dashboard and proves *why* each action was or wasn't allowed.

## Strategy module (`src/strategy/`)

Produces the `TradeProposal`s the engine evaluates. Same discipline: deterministic core, pluggable LLM, runs without an API key.

- `indicators.ts` — pure SMA / ROC / RSI / z-score.
- `signals.ts` — `generateSignal()`: momentum + mean-reversion. **The signal owns the direction** (buy / sell / hold) and a 0..1 conviction `strength`.
- `synthesizer.ts` — `Synthesizer` interface + `deterministicSynthesizer` (no LLM; default + fallback). Produces a `Verdict { recommendedAction, confidence, riskLevel, rationale }` from the signal + soft CMC context (narrative sentiment, funding, volume, Trust Wallet token risk).
- `claude-synthesizer.ts` — Opus 4.8 as a **risk reviewer**: structured-output verdict, adaptive thinking, refusal-safe. It may only **confirm or veto** — never originate a trade.
- `strategy.ts` — `proposeTrade()`: signal → verdict → sized proposal. If the synthesizer disagrees with the signal's direction, confidence is **capped low** so the policy engine's `minSignalConfidence` denies it. The LLM can veto, never override.

```ts
import { proposeTrade, DEFAULT_STRATEGY, deterministicSynthesizer, claudeSynthesizer } from "circuit-trader-policy";

const out = await proposeTrade({
  market: { asset: "BNB", closes, tokenRiskScore, narrativeScore, fundingRatePct },
  strategy: DEFAULT_STRATEGY,
  sizing: { baseTradeUsd: 4, minStrengthToTrade: 0.2 },
  synthesizer: claudeSynthesizer(), // or deterministicSynthesizer (no API key)
  now: new Date().toISOString(),
  quote: { expectedSlippageBps, quoteId }, // from Trust Wallet Agent Kit
});
// out.signal, out.verdict, out.proposal (null on hold), out.note  → all renderable on the timeline
// then: evaluate({ constitution, state, proposal: out.proposal, now })
```

## Orchestrator (`src/orchestrator/`)

`runTick()` is the loop: reconcile balances → circuit-breaker pre-check → per asset `{ signal → verdict → policy → execute }`. Execution observers let a persistent worker durably journal intent and checkpoint each fill before another order.

- `market-source.ts` — `MarketDataSource` **port** (price closes + soft CMC context; token risk comes from the Wallet, not here). `FixtureMarketSource` for tests/paper-trading; `CmcMcpSource` adapter over an injected `McpTransport`, with the CMC Agent Hub tool names isolated + flagged (verify against `https://mcp.coinmarketcap.com/mcp`). Soft signals are best-effort — a missing narrative/funding tool never breaks the price path.
- `orchestrator.ts` — `runTick()`. Reconciles `RuntimeState` from `wallet.getPortfolio()` each tick (balances are ground truth; counters/kill-switch persist). The **circuit breaker is a pre-check** — it trips even on a no-trade tick, so an unattended agent halts on a crash regardless of signals.

The live worker is `scripts/live-runner.mjs`. It supplies an `ExecutionObserver` backed by an
fsynced write-ahead journal. Do not call `runTick()` with a real wallet from a stateless cron or
without equivalent intent/fill persistence.

## Develop

```bash
npm install
npm test        # policy, strategy, execution, orchestration, connector, and recovery tests
npm run build   # tsc -> dist/
```
