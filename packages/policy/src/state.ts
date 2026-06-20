import { z } from "zod";
import type { TradeProposal } from "./types.js";

/**
 * Mutable runtime state the engine reads (but never mutates). The host persists this
 * across cron ticks. All monetary values are in USD.
 */
export interface RuntimeState {
  /** Current total equity = reserve + sum(positions). */
  equityUsd: number;
  /** Peak equity ever seen — denominator for drawdown. */
  highWaterMarkUsd: number;
  /** Equity observed when this state ledger was initialized. */
  initialEquityUsd: number;
  /** Equity captured at the start of the current UTC day — denominator for daily loss. */
  startOfDayEquityUsd: number;
  /** UTC date (YYYY-MM-DD) the day-scoped counters belong to. */
  currentDayUtc: string;
  /** Value held in the reserve asset (e.g. USDT). */
  reserveUsd: number;
  /** asset -> current position value in USD (non-reserve only). */
  positions: Record<string, number>;
  /** asset -> ISO timestamp of last trade in that asset. */
  lastTradeAtPerAsset: Record<string, string>;
  /** ISO timestamp of the most recent trade in any asset. */
  lastTradeAtGlobal: string | null;
  /** Trades executed so far today. */
  tradesToday: number;
  /** Bounded execution-id ledger used to make crash recovery idempotent. */
  recordedExecutionIds: string[];
  killSwitchEngaged: boolean;
  killSwitchReason: string | null;
}

/** A fresh state for an agent funded with `reserveUsd` in the reserve asset. */
export function initState(reserveUsd: number, nowIso: string): RuntimeState {
  return {
    equityUsd: reserveUsd,
    highWaterMarkUsd: reserveUsd,
    initialEquityUsd: reserveUsd,
    startOfDayEquityUsd: reserveUsd,
    currentDayUtc: nowIso.slice(0, 10),
    reserveUsd,
    positions: {},
    lastTradeAtPerAsset: {},
    lastTradeAtGlobal: null,
    tradesToday: 0,
    recordedExecutionIds: [],
    killSwitchEngaged: false,
    killSwitchReason: null,
  };
}

export function totalNonReserveExposureUsd(state: RuntimeState): number {
  return Object.values(state.positions).reduce((sum, v) => sum + v, 0);
}

/**
 * Roll day-scoped counters when the UTC day changes. Returns a new state; pure.
 * Call this before evaluating so daily-loss and trade-count windows are correct.
 */
export function rollDay(state: RuntimeState, nowIso: string): RuntimeState {
  const today = nowIso.slice(0, 10);
  if (state.currentDayUtc === today) return state;
  return {
    ...state,
    currentDayUtc: today,
    startOfDayEquityUsd: state.equityUsd,
    tradesToday: 0,
  };
}

/** Recompute high-water mark from current equity. Returns a new state; pure. */
export function markHighWater(state: RuntimeState): RuntimeState {
  if (state.equityUsd <= state.highWaterMarkUsd) return state;
  return { ...state, highWaterMarkUsd: state.equityUsd };
}

/**
 * Apply an executed trade to state (counters + timestamps + position bookkeeping).
 * `filledUsd` is the realized notional from the chain (may differ from the proposal).
 * Returns a new state; pure.
 */
export function recordExecution(
  state: RuntimeState,
  proposal: Pick<TradeProposal, "asset" | "side">,
  filledUsd: number,
  executedAtIso: string,
  executionId?: string,
): RuntimeState {
  const positions = { ...state.positions };
  const current = positions[proposal.asset] ?? 0;
  let reserveUsd = state.reserveUsd;

  if (proposal.side === "buy") {
    positions[proposal.asset] = current + filledUsd;
    reserveUsd -= filledUsd;
  } else {
    positions[proposal.asset] = Math.max(0, current - filledUsd);
    reserveUsd += filledUsd;
  }

  return {
    ...state,
    positions,
    reserveUsd,
    lastTradeAtPerAsset: { ...state.lastTradeAtPerAsset, [proposal.asset]: executedAtIso },
    lastTradeAtGlobal: executedAtIso,
    tradesToday: state.tradesToday + 1,
    recordedExecutionIds: executionId
      ? [...state.recordedExecutionIds.filter((id) => id !== executionId), executionId].slice(-500)
      : state.recordedExecutionIds,
  };
}

/** Engage the kill switch (e.g. after a terminal drawdown decision). Returns a new state; pure. */
export function engageKillSwitch(state: RuntimeState, reason: string): RuntimeState {
  return { ...state, killSwitchEngaged: true, killSwitchReason: reason };
}

const RuntimeStateSchema = z.object({
  equityUsd: z.number().finite().nonnegative(),
  highWaterMarkUsd: z.number().finite().nonnegative(),
  initialEquityUsd: z.number().finite().nonnegative().default(0),
  startOfDayEquityUsd: z.number().finite().nonnegative(),
  currentDayUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reserveUsd: z.number().finite().nonnegative(),
  positions: z.record(z.string(), z.number().finite().nonnegative()),
  lastTradeAtPerAsset: z.record(z.string(), z.string().datetime()),
  lastTradeAtGlobal: z.string().datetime().nullable(),
  tradesToday: z.number().int().nonnegative(),
  recordedExecutionIds: z.array(z.string().min(1)).max(500).default([]),
  killSwitchEngaged: z.boolean(),
  killSwitchReason: z.string().nullable(),
});

/** Validate persisted state and migrate records created before the tx-hash ledger existed. */
export function parseRuntimeState(raw: unknown): RuntimeState {
  return RuntimeStateSchema.parse(raw);
}
