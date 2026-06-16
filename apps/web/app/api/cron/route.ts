import { NextResponse } from "next/server";
import {
  runTick,
  initState,
  parseConstitution,
  claudeSynthesizer,
  DEFAULT_STRATEGY,
  type Constitution,
} from "circuit-trader-policy";
import { createCmcMarketSource, createTrustWalletWallet } from "@circuit-trader/connectors";
import { loadState, saveState } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ASSETS = (process.env.AGENT_ASSETS ?? "BNB,ETH,CAKE").split(",").map((s) => s.trim());

/**
 * Live orchestration tick. Wired for Vercel Cron (see apps/web/vercel.json).
 * Pulls signals from CoinMarketCap (MCP), runs the policy engine with Claude as the bounded
 * risk reviewer, and settles cleared trades through Trust Wallet on BNB Chain.
 *
 * Env required (see .env.example): CMC_MCP_API_KEY, TWAK_MCP_URL, TWAK_API_KEY,
 * AGENT_WALLET_ADDRESS, ANTHROPIC_API_KEY, CONSTITUTION_JSON, CRON_SECRET.
 */
export async function GET(req: Request): Promise<Response> {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Reject anything else.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let constitution: Constitution;
  try {
    if (!process.env.CONSTITUTION_JSON) throw new Error("CONSTITUTION_JSON is not set");
    constitution = parseConstitution(JSON.parse(process.env.CONSTITUTION_JSON));
  } catch (e) {
    return NextResponse.json({ error: `bad constitution: ${msg(e)}` }, { status: 500 });
  }

  let cmc: { close(): Promise<void> } | null = null;
  let twak: { close(): Promise<void> } | null = null;
  try {
    const cmcConn = createCmcMarketSource();
    const twakConn = createTrustWalletWallet();
    cmc = cmcConn.transport;
    twak = twakConn.transport;

    const now = new Date().toISOString();
    const state = (await loadState()) ?? initState(0, now);

    const tick = await runTick({
      constitution,
      state,
      wallet: twakConn.wallet,
      market: cmcConn.source,
      synthesizer: claudeSynthesizer(),
      config: {
        strategy: DEFAULT_STRATEGY,
        sizing: {
          baseTradeUsd: Number(process.env.AGENT_BASE_TRADE_USD ?? 4),
          minStrengthToTrade: Number(process.env.AGENT_MIN_STRENGTH ?? 0.3),
        },
        assets: ASSETS,
      },
      now,
    });

    await saveState(tick.state);

    return NextResponse.json({
      now: tick.now,
      note: tick.note,
      killSwitch: tick.killSwitchEngaged,
      equityUsd: tick.portfolioAfter.equityUsd,
      results: tick.results.map((r) => ({
        asset: r.asset,
        action: r.signal.action,
        allowed: r.decision?.allowed ?? false,
        clamped: (r.decision?.adjustments.length ?? 0) > 0,
        txHash: r.fill?.txHash ?? null,
        denial: r.decision && !r.decision.allowed ? r.decision.violations[0]?.code ?? null : null,
        error: r.error,
      })),
    });
  } catch (e) {
    // Transient transport/credential errors: skip this tick and retry next cron. Do NOT
    // engage the kill switch — it's terminal, and a blip must not end the run. State is
    // left untouched; drawdown protection still lives inside runTick.
    return NextResponse.json({ error: msg(e), skipped: true }, { status: 503 });
  } finally {
    await cmc?.close().catch(() => {});
    await twak?.close().catch(() => {});
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
