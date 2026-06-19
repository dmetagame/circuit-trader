# Circuit Trader

> An autonomous BNB-chain trading agent that **cannot trade unless its own signed risk constitution allows it.**

Built for **BNB HACK: AI Trading Agent Edition** (BNB Chain × CoinMarketCap × Trust Wallet).

A deterministic strategy proposes trades from CoinMarketCap signals; a free deterministic reviewer (or optional Claude reviewer) can only confirm or veto; a signed, machine-readable **risk constitution** gates every order; and Trust Wallet's Agent Kit settles the cleared trade on BNB Chain. The agent's hard drawdown cap mirrors the competition's disqualification gate — **survival is the edge**.

## Monorepo layout

```
packages/policy/   The brain — risk constitution + policy engine + strategy + execution + orchestrator.
                   Pure, deterministic, fully tested (no API key needed to run).
apps/web/          Next.js dashboard — live timeline of signal → verdict → ALLOW/DENY/CLAMP → tx,
                   portfolio, kill-switch, and a scripted demo (incl. a "trigger crash" circuit-breaker beat).
```

## Architecture

```
CMC MCP ─▶ strategy ─▶ reviewer verdict ─▶ TradeProposal ─▶ [ RISK CONSTITUTION / POLICY ENGINE ] ─▶ allowed?
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

## Track 1 live runner

The Vercel app is the public dashboard/demo. The live trading loop should run on a VM or
worker because Trust Wallet Agent Kit runs as a local MCP process (`twak serve`) over stdio.

1. Install and verify the repo:

```bash
npm install
npm test
npm run build:connectors
cp .env.example .env.local
```

2. Fill `.env.local` with:

- `CMC_MCP_API_KEY`
- `SYNTHESIZER_MODE=deterministic` for the free local reviewer, or `SYNTHESIZER_MODE=claude` plus `ANTHROPIC_API_KEY`
- `TWAK_ACCESS_ID` / `TWAK_HMAC_SECRET` or a completed `twak setup`
- `TWAK_WALLET_PASSWORD` or a saved keychain password via `twak wallet keychain save`
- `AGENT_WALLET_ADDRESS`
- `AGENT_ASSETS`, `AGENT_BASE_TRADE_USD`, and risk sizing values

3. Create a real constitution JSON with the funded agent wallet address, then sign it:

```bash
npm run constitution:sign -- \
  --input path/to/constitution.unsigned.json \
  --output .circuit-trader/constitution.signed.json
```

The command uses the configured TWAK wallet for an off-chain EIP-191 signature.
`CONSTITUTION_SIGNER_PRIVATE_KEY` remains an optional fallback. The live runner requires a
valid signature by default and persists state under `.circuit-trader/`.

4. Run one guarded live tick, then start the worker:

```bash
npm run live:check
npm run live:once
npm run live:runner
```

`live:check` is read-only and validates the signed constitution, CMC feed, wallet portfolio,
and token-risk lookup. The runner writes durable state to `RUNNER_STATE_PATH` and appends one
JSON record per tick to `RUNNER_TIMELINE_PATH`. Balances are read from Trust Wallet each tick;
persisted state is only counters, high-water mark, and kill-switch bookkeeping.

For an unattended Linux user service, adapt the units under `scripts/` and install them in
`~/.config/systemd/user/`. The start/stop timer examples bound execution to the Track 1 week.
Enable lingering so the service survives logout, then inspect it with:

```bash
systemctl --user list-timers 'circuit-trader-*'
journalctl --user -u circuit-trader.service -f
```

5. Before the Track 1 trading window opens on June 22, 2026, register the same agent wallet:

```bash
twak compete register
```

Include the registration tx, agent address, repo, and dashboard URL in the DoraHacks
submission.

## Status

Core engine complete and tested end-to-end (policy / strategy / execution / orchestrator).
Dashboard demo runs on a simulated wallet. The Track 1 path now has a standalone VM/worker
runner with durable JSON state, CMC MCP, a free deterministic or optional Claude reviewer,
and Trust Wallet Agent Kit wiring. Operators must configure credentials, sign the live
constitution, validate a tiny swap, register the wallet, and schedule the runner.
