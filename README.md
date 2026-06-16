# Circuit Trader

> An autonomous BNB-chain trading agent that **cannot trade unless its own signed risk constitution allows it.**

Built for **BNB HACK: AI Trading Agent Edition** (BNB Chain × CoinMarketCap × Trust Wallet).

A deterministic strategy proposes trades from CoinMarketCap signals; Claude (Opus 4.8) acts as a bounded risk reviewer that can only confirm or veto; a signed, machine-readable **risk constitution** gates every order; and Trust Wallet's Agent Kit settles the cleared trade on BNB Chain. The agent's hard drawdown cap mirrors the competition's disqualification gate — **survival is the edge**.

## Monorepo layout

```
packages/policy/   The brain — risk constitution + policy engine + strategy + execution + orchestrator.
                   Pure, deterministic, fully tested (no API key needed to run).
apps/web/          Next.js dashboard — live timeline of signal → verdict → ALLOW/DENY/CLAMP → tx,
                   portfolio, kill-switch, and a scripted demo (incl. a "trigger crash" circuit-breaker beat).
```

## Architecture

```
CMC MCP ─▶ strategy ─▶ Claude verdict ─▶ TradeProposal ─▶ [ RISK CONSTITUTION / POLICY ENGINE ] ─▶ allowed?
(signals)  (signal)    (confirm/veto)      (intent)            (packages/policy)                       │
                                                                                ├─ ALLOW (±clamp) ─▶ Trust Wallet swap on BNB
                                                                                └─ DENY (reasons) ─▶ dashboard timeline
```

Every external dependency (CoinMarketCap, Trust Wallet, the LLM) sits behind a swappable **port**, so the whole system runs deterministically offline for tests and the demo.

## Quick start

```bash
npm install              # workspace install (links packages/policy into apps/web)
npm test                 # policy engine + strategy + execution + orchestrator (vitest)
npm run build:policy     # compile the library
npm run dev              # run the dashboard at http://localhost:3000
```

See `packages/policy/README.md` for the engine internals and the BNB HACK rule mapping.

## Status

Core engine complete and tested end-to-end (policy / strategy / execution / orchestrator). Dashboard demo runs on a simulated wallet. Remaining for go-live: real CMC + Trust Wallet MCP transports, Vercel cron + state persistence, and signing + funding the dedicated agent wallet on BNB mainnet (tiny size). The two external MCP seams (CMC + Trust Wallet tool names) are isolated and flagged — verify against live docs before mainnet.
