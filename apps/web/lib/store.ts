import type { RuntimeState } from "circuit-trader-policy";

/**
 * Minimal state store for the live agent. The orchestrator is stateless across ticks, so
 * RuntimeState (counters, kill-switch, high-water mark) must persist between cron runs.
 *
 * In-memory by default (fine for a single long-lived process / local dev). For Vercel's
 * serverless cron, swap in a durable backend — Vercel KV / Upstash Redis — by implementing
 * the same two functions. Balances are NOT stored here (the wallet is ground truth); only
 * the agent's bookkeeping is.
 */

const g = globalThis as unknown as { __ctState?: RuntimeState };

export async function loadState(): Promise<RuntimeState | null> {
  // TODO(vercel-kv): const raw = await kv.get<RuntimeState>("ct:state"); return raw ?? null;
  return g.__ctState ?? null;
}

export async function saveState(state: RuntimeState): Promise<void> {
  // TODO(vercel-kv): await kv.set("ct:state", state);
  g.__ctState = state;
}
