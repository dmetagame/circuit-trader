import type { Snapshot } from "@/lib/session";

export interface LiveEnvelope {
  updatedAt: string;
  snapshot: Snapshot;
}

export function isLiveEnvelope(value: unknown): value is LiveEnvelope {
  if (!isRecord(value) || typeof value.updatedAt !== "string" || !isRecord(value.snapshot)) return false;
  const snapshot = value.snapshot;
  return (
    isRecord(snapshot.constitution) &&
    typeof snapshot.constitution.agentId === "string" &&
    typeof snapshot.constitution.walletAddress === "string" &&
    Array.isArray(snapshot.constitution.allowedAssets) &&
    isRecord(snapshot.portfolio) &&
    isFiniteNumber(snapshot.portfolio.equityUsd) &&
    isFiniteNumber(snapshot.portfolio.reserveUsd) &&
    isRecord(snapshot.portfolio.positions) &&
    isRecord(snapshot.killSwitch) &&
    typeof snapshot.killSwitch.engaged === "boolean" &&
    isFiniteNumber(snapshot.highWaterMarkUsd) &&
    isFiniteNumber(snapshot.drawdownPct) &&
    isFiniteNumber(snapshot.tickCount) &&
    Array.isArray(snapshot.timeline)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
