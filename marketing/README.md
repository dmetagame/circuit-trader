# Circuit Trader — marketing copy

Submission and social copy for **BNB HACK: AI Trading Agent Edition** (BNB Chain ×
CoinMarketCap × Trust Wallet) and the **$2K CMC Agent Hub Special Prize**.

> This folder is copy and assets only. The competition framing below lives here on purpose —
> the product code and docs stay generic; the *pitch* leans into the contest.

- `cmc-agent-hub.png` / `.svg` — 1600×900 infographic (the live decision pipeline). 16:9, drops
  straight into an X post.
- `gen-infographic.mjs` — regenerates the infographic: `node marketing/gen-infographic.mjs`.

---

## The pitch — survival is the edge

Track 1 ranks agents by **total return on a held-out window**, with a **hard max-drawdown
disqualification gate**, a **minimum trade count**, and **simulated transaction costs**.

Most entrants will DQ by blowing the drawdown gate, or fail the min-trade-count chasing it. A
competent, **surviving**, modestly-positive agent places well *by not dying*.

Circuit Trader is that survival mechanism. It **cannot trade unless its own signed risk
constitution allows it** — the constitution's drawdown cap is set **below the competition's DQ
threshold**, so breaching it is terminal and engages the kill switch before the contest ever
disqualifies the agent. The strategy proposes; the constitution disposes. **Survival is the edge.**

| Competition rule | Constitution lever |
|---|---|
| Max-drawdown DQ gate | `riskGates.maxDrawdownPct` — set **below** the DQ threshold; terminal → kill switch |
| Minimum trade count | `perTrade.minTradeUsd` keeps trades meaningful (not dust) so they count |
| Simulated tx costs punish over-trading | cooldowns, min trade interval, max trades per day |
| Unattended held-out window | pure, deterministic, crash-safe worker — safe to run with no human watching |

---

## Day 1 — the reveal  ·  *attach `cmc-agent-hub.png`*

> I got tired of "AI trading bots" that confidently gamble your money on a vibe and call it alpha.
>
> So I built Circuit Trader: an agent that *physically cannot* place a trade unless its own signed
> risk constitution allows it. It reads the market through @CoinMarketCap's CMC Agent Hub, then
> checks every single order against rules it isn't allowed to override.
>
> Most entrants will blow the drawdown gate and DQ. Mine is built to survive the window. Survival
> is the edge.
>
> Live on BNB Chain 👇 — built for the BNB Hack: AI Trading Agent Edition.
> circuit-trader.vercel.app
> #CMCAgentHub #BNBHack

## Day 2 — how it thinks  ·  *3-tweet thread, infographic on tweet 3*

**1/**
> Day 2 — how Circuit Trader actually decides 🧵
>
> Before it even *considers* a trade, it interrogates @CoinMarketCap's CMC Agent Hub:
> › is there real momentum here, or just noise?
> › how strong is the signal, 0→1?
> › how risky is this token?
>
> No signal → no trade. Weak signal → no trade. Risky token → no trade.
> #CMCAgentHub #BNBHack

**2/**
> Only if CMC's data clears the bar does the signal reach the constitution — the signed rulebook
> that sizes the order, clamps it down, or kills it outright. Its drawdown cap sits *below* the
> contest's DQ gate, so it taps out before the competition ever disqualifies it.
>
> Most bots trade on vibes. Mine needs evidence from CMC Agent Hub *and* permission from its own rules.

**3/**
> The whole live pipeline 👇
> CMC Agent Hub (the eyes) → the constitution (the brain) → BNB Chain (the hands).
>
> Real swaps, real tx hashes, reserve always protected. Built for the BNB Hack: AI Trading Agent
> Edition — where survival is the edge.
>
> Try it: circuit-trader.vercel.app
> @CoinMarketCap #CMCAgentHub #BNBHack
> *[attach cmc-agent-hub.png]*

---

## Posting checklist

- ✅ `@CoinMarketCap` + `#CMCAgentHub` + `#BNBHack` + hackathon named — in **every** standalone tweet.
- 🔓 Open your X DMs (CMC contacts winners via Twitter DM).
- 📨 DM the tweet to the organizer on Telegram.
- These run past 280 chars → needs X Premium, or trim.
