# Circuit Trader

> An autonomous BNB-chain trading agent that **cannot trade unless its own signed risk constitution allows it.**

Built for **BNB HACK: AI Trading Agent Edition** (BNB Chain × CoinMarketCap × Trust Wallet).

A deterministic strategy proposes trades from CoinMarketCap signals; a free deterministic reviewer (or optional Claude reviewer) can only confirm or veto; a signed, machine-readable **risk constitution** gates every order; and Trust Wallet's Agent Kit settles the cleared trade on BNB Chain. The agent enforces its own terminal drawdown cap — **survival is the edge**.

## Monorepo layout

```
packages/policy/   The brain — risk constitution + policy engine + strategy + execution + orchestrator.
                   Pure deterministic policy core with offline unit and integration tests.
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
```

2. Create `.env.worker.local` from `.env.example` and fill it with:

- `CMC_MCP_API_KEY`
- `SYNTHESIZER_MODE=deterministic` for the free local reviewer, or `SYNTHESIZER_MODE=claude` plus `ANTHROPIC_API_KEY`
- `TWAK_ACCESS_ID` / `TWAK_HMAC_SECRET` or a completed `twak setup`
- `TWAK_WALLET_PASSWORD` or a saved keychain password via `twak wallet keychain save`
- `AGENT_WALLET_ADDRESS`
- `AGENT_ASSETS`, `AGENT_BASE_TRADE_USD`, and risk sizing values
- `LIVE_DASHBOARD_URL` and `LIVE_INGEST_SECRET` when publishing public snapshots

Keep worker credentials out of `.env.local`: Vercel CLI owns that file and may replace it
when project environment variables or storage integrations are pulled.

3. Create a real constitution JSON with the funded agent wallet address, then sign it:

```bash
npm run constitution:sign -- \
  --env-file .env.worker.local \
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
token-risk lookup, and an executable quote for every configured asset. All live commands load
`.env.worker.local` by default. `live:once` is not a dry run: it can execute one trade for each
configured asset.

The runner holds a single-process lock and writes an atomic execution intent before every wallet
call. A known fill is checkpointed immediately and recovered idempotently after a crash. If the
process loses the wallet response, the next run engages the kill switch because settlement is
ambiguous. After verifying the execution ID and transaction outcome with TWAK/BscScan, reconcile it:

```bash
npm run live:reconcile -- --outcome rejected --execution-id dec_12345678
npm run live:reconcile -- --outcome filled --execution-id dec_12345678 \
  --filled-usd 0.20 --price 600 --slippage-bps 20 \
  --tx-hash 0x... --executed-at 2026-06-22T00:15:00.000Z
```

Stop the runner before reconciliation. Never mark an ambiguous intent rejected until its absence
has been confirmed on-chain. State, journal, lock, and timeline paths live under `.circuit-trader/`
by default. Balances are refreshed from Trust Wallet each tick.

When `LIVE_DASHBOARD_URL` and `LIVE_INGEST_SECRET` are set, each completed tick publishes a
credential-free snapshot to the authenticated `/api/live` endpoint. The endpoint stores only
the latest public snapshot in private Vercel Blob storage; browsers receive it through a
read-only GET request.

For an unattended Linux VM, adapt the units under `scripts/` and install them in
`~/.config/systemd/user/`. The start/stop timer examples bound execution to the Track 1 week.
Enable lingering so the service survives logout, then inspect it with:

```bash
systemctl --user list-timers 'circuit-trader-*'
journalctl --user -u circuit-trader.service -f
```

Do not use WSL, a laptop, or a host that sleeps for the competition worker. A systemd timer cannot
run while that host is suspended or terminated. Confirm the organizer's exact UTC start/end times
before installing the example timers; the public rules currently publish dates, not precise times.

5. Before the Track 1 trading window opens on June 22, 2026, register the same agent wallet:

```bash
twak compete register
```

Include the registration tx, agent address, repo, and dashboard URL in the DoraHacks
submission.

## Status

Core engine and crash-safe worker path are implemented and tested across policy, strategy,
execution, orchestration, and journal recovery. Dashboard demo runs on a simulated wallet. The
Track 1 worker uses CMC MCP, a free deterministic or optional Claude reviewer, and Trust Wallet
Agent Kit. Production operation still requires an always-on Linux VM, configured credentials, a
signed constitution, successful full preflight, registered wallet, and verified UTC timers.
