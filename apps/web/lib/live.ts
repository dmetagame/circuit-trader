import type { Snapshot } from "@/lib/session";

export interface LiveEnvelope {
  updatedAt: string;
  snapshot: Snapshot;
}

/** Add performance fields to snapshots published by pre-migration workers. */
export function normalizeLiveEnvelope(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.snapshot) || !isRecord(value.snapshot.portfolio)) return value;
  const equity = value.snapshot.portfolio.equityUsd;
  if (!isFiniteNumber(equity)) return value;
  const initial = isFiniteNumber(value.snapshot.initialEquityUsd) ? value.snapshot.initialEquityUsd : equity;
  const pnl = isFiniteNumber(value.snapshot.pnlUsd) ? value.snapshot.pnlUsd : equity - initial;
  const returnPct = isFiniteNumber(value.snapshot.returnPct)
    ? value.snapshot.returnPct
    : initial > 0
      ? (pnl / initial) * 100
      : 0;
  return {
    ...value,
    snapshot: { ...value.snapshot, initialEquityUsd: initial, pnlUsd: pnl, returnPct },
  };
}

export function isLiveEnvelope(value: unknown): value is LiveEnvelope {
  if (!isRecord(value) || !isIsoDate(value.updatedAt) || !isRecord(value.snapshot)) return false;
  const snapshot = value.snapshot;
  return (
    isRecord(snapshot.constitution) &&
    typeof snapshot.constitution.agentId === "string" &&
    typeof snapshot.constitution.walletAddress === "string" &&
    /^0x[a-fA-F0-9]{40}$/.test(snapshot.constitution.walletAddress) &&
    isStringArray(snapshot.constitution.allowedAssets) &&
    isFiniteNumber(snapshot.constitution.chainId) &&
    typeof snapshot.constitution.reserveAsset === "string" &&
    isFiniteNumber(snapshot.constitution.maxTradeUsd) &&
    isFiniteNumber(snapshot.constitution.maxDrawdownPct) &&
    isFiniteNumber(snapshot.constitution.minSignalConfidence) &&
    isFiniteNumber(snapshot.constitution.maxTokenRiskScore) &&
    isRecord(snapshot.portfolio) &&
    isFiniteNumber(snapshot.portfolio.equityUsd) &&
    isFiniteNumber(snapshot.portfolio.reserveUsd) &&
    isRecord(snapshot.portfolio.positions) &&
    Object.values(snapshot.portfolio.positions).every(isFiniteNumber) &&
    isRecord(snapshot.killSwitch) &&
    typeof snapshot.killSwitch.engaged === "boolean" &&
    (snapshot.killSwitch.reason === null || typeof snapshot.killSwitch.reason === "string") &&
    isFiniteNumber(snapshot.highWaterMarkUsd) &&
    isFiniteNumber(snapshot.drawdownPct) &&
    isFiniteNumber(snapshot.initialEquityUsd) &&
    isFiniteNumber(snapshot.pnlUsd) &&
    isFiniteNumber(snapshot.returnPct) &&
    isFiniteNumber(snapshot.tickCount) &&
    Array.isArray(snapshot.timeline) &&
    snapshot.timeline.every(isTimelineEntry)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isTimelineEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.index) &&
    isIsoDate(value.now) &&
    typeof value.note === "string" &&
    typeof value.killSwitch === "boolean" &&
    isFiniteNumber(value.equityUsd) &&
    isFiniteNumber(value.reserveUsd) &&
    isFiniteNumber(value.drawdownPct) &&
    Array.isArray(value.assets)
  );
}
