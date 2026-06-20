import type { Constitution } from "./constitution.js";
import { rollDay, totalNonReserveExposureUsd, type RuntimeState } from "./state.js";
import { TradeProposalSchema, type Adjustment, type PolicyDecision, type TradeProposal, type Violation, type ViolationCode } from "./types.js";

export interface EvaluateArgs {
  constitution: Constitution;
  state: RuntimeState;
  proposal: TradeProposal;
  /** ISO timestamp of evaluation (injected for determinism/testing). */
  now: string;
}

/**
 * The heart of Circuit Trader: a PURE, deterministic gate. Given the constitution,
 * current state and a proposed trade, it returns an ALLOW/DENY decision with a full
 * structured audit trail. It never mutates state and never touches the chain.
 *
 * Same inputs -> same decision. That property is what makes the agent safe to run
 * unattended on the competition's held-out window, and what makes every action on
 * the dashboard explainable.
 */
export function evaluate({ constitution: c, state: rawState, proposal, now }: EvaluateArgs): PolicyDecision {
  const state = rollDay(rawState, now);
  const violations: Violation[] = [];
  const adjustments: Adjustment[] = [];
  const audit: string[] = [];
  let engageKill = false;
  let killReason: string | null = null;

  const block = (v: Violation) => {
    violations.push(v);
    audit.push(`✗ ${v.code}: ${v.message} (observed ${v.observed}, limit ${v.limit})`);
  };
  const pass = (msg: string) => audit.push(`✓ ${msg}`);

  const parsedProposal = TradeProposalSchema.safeParse(proposal);
  if (!parsedProposal.success) {
    block({
      code: "INVALID_PROPOSAL",
      severity: "block",
      message: "proposal failed runtime validation",
      observed: parsedProposal.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      limit: "finite, bounded, schema-valid trade proposal",
    });
    return deny({ proposal, now, violations, adjustments, audit, engageKill, killReason });
  }
  proposal = parsedProposal.data;

  // --- 0. Hard halts that ignore everything else ---
  if (state.killSwitchEngaged) {
    block({
      code: "KILL_SWITCH",
      severity: "block",
      message: `kill switch engaged: ${state.killSwitchReason ?? "unknown"}`,
      observed: "engaged",
      limit: "disengaged",
    });
  }
  if (c.enforcement.killSwitch) {
    block({
      code: "KILL_SWITCH",
      severity: "block",
      message: "constitution master kill switch is ON",
      observed: "on",
      limit: "off",
    });
  }
  if (c.expiresAt && Date.parse(c.expiresAt) <= Date.parse(now)) {
    block({
      code: "CONSTITUTION_EXPIRED",
      severity: "block",
      message: `constitution expired at ${c.expiresAt}`,
      observed: now,
      limit: c.expiresAt,
    });
  }

  // --- 1. Risk gates ---
  const hwm = Math.max(state.highWaterMarkUsd, state.equityUsd);
  const drawdownPct = hwm > 0 ? ((hwm - state.equityUsd) / hwm) * 100 : 0;
  if (drawdownPct >= c.riskGates.maxDrawdownPct) {
    engageKill = true;
    killReason = `drawdown ${drawdownPct.toFixed(2)}% >= cap ${c.riskGates.maxDrawdownPct}%`;
    block({
      code: "DRAWDOWN_BREACH",
      severity: "terminal",
      message: `drawdown gate breached — engaging kill switch`,
      observed: round2(drawdownPct),
      limit: c.riskGates.maxDrawdownPct,
    });
  } else {
    pass(`drawdown ${round2(drawdownPct)}% within cap ${c.riskGates.maxDrawdownPct}%`);
  }

  const dayLossPct =
    state.startOfDayEquityUsd > 0
      ? ((state.startOfDayEquityUsd - state.equityUsd) / state.startOfDayEquityUsd) * 100
      : 0;
  if (dayLossPct >= c.riskGates.dailyLossLimitPct) {
    block({
      code: "DAILY_LOSS_BREACH",
      severity: "block",
      message: "daily loss limit hit — halted for the rest of the UTC day",
      observed: round2(dayLossPct),
      limit: c.riskGates.dailyLossLimitPct,
    });
  } else {
    pass(`daily loss ${round2(dayLossPct)}% within ${c.riskGates.dailyLossLimitPct}%`);
  }

  if (proposal.signalConfidence < c.riskGates.minSignalConfidence) {
    block({
      code: "CONFIDENCE_TOO_LOW",
      severity: "block",
      message: "signal confidence below floor",
      observed: proposal.signalConfidence,
      limit: c.riskGates.minSignalConfidence,
    });
  } else {
    pass(`confidence ${proposal.signalConfidence} >= floor ${c.riskGates.minSignalConfidence}`);
  }

  if (proposal.tokenRiskScore > c.riskGates.maxTokenRiskScore) {
    block({
      code: "TOKEN_RISK_TOO_HIGH",
      severity: "block",
      message: "Trust Wallet token risk score exceeds ceiling",
      observed: proposal.tokenRiskScore,
      limit: c.riskGates.maxTokenRiskScore,
    });
  } else {
    pass(`token risk ${proposal.tokenRiskScore} within ${c.riskGates.maxTokenRiskScore}`);
  }

  // --- 2. Universe ---
  if (proposal.asset === c.reserveAsset) {
    block({
      code: "ASSET_NOT_ALLOWED",
      severity: "block",
      message: "cannot take a position in the reserve asset",
      observed: proposal.asset,
      limit: `!= ${c.reserveAsset}`,
    });
  } else if (!c.allowedAssets.includes(proposal.asset)) {
    block({
      code: "ASSET_NOT_ALLOWED",
      severity: "block",
      message: "asset not in allowlist",
      observed: proposal.asset,
      limit: c.allowedAssets.join("|"),
    });
  } else {
    pass(`asset ${proposal.asset} in allowlist`);
  }

  // --- 3. Activity & cost controls ---
  const lastForAsset = state.lastTradeAtPerAsset[proposal.asset];
  if (lastForAsset) {
    const mins = (Date.parse(now) - Date.parse(lastForAsset)) / 60_000;
    if (mins < c.activity.cooldownMinutesPerAsset) {
      block({
        code: "COOLDOWN_ACTIVE",
        severity: "block",
        message: `still cooling down on ${proposal.asset}`,
        observed: round2(mins),
        limit: c.activity.cooldownMinutesPerAsset,
      });
    }
  }
  if (state.lastTradeAtGlobal) {
    const secs = (Date.parse(now) - Date.parse(state.lastTradeAtGlobal)) / 1_000;
    if (secs < c.activity.minTradeIntervalSeconds) {
      block({
        code: "MIN_INTERVAL",
        severity: "block",
        message: "global minimum trade interval not elapsed",
        observed: round2(secs),
        limit: c.activity.minTradeIntervalSeconds,
      });
    }
  }
  if (state.tradesToday >= c.activity.maxTradesPerDay) {
    block({
      code: "MAX_TRADES_REACHED",
      severity: "block",
      message: "daily trade cap reached",
      observed: state.tradesToday,
      limit: c.activity.maxTradesPerDay,
    });
  }

  // --- 4. Execution quality ---
  if (proposal.expectedSlippageBps > c.perTrade.maxSlippageBps) {
    block({
      code: "SLIPPAGE_TOO_HIGH",
      severity: "block",
      message: "quote slippage exceeds cap",
      observed: proposal.expectedSlippageBps,
      limit: c.perTrade.maxSlippageBps,
    });
  } else {
    pass(`slippage ${proposal.expectedSlippageBps}bps within ${c.perTrade.maxSlippageBps}bps`);
  }

  // If any hard gate already failed, deny now — sizing is moot.
  if (violations.length > 0) {
    return deny({ proposal, now, violations, adjustments, audit, engageKill, killReason });
  }

  // --- 5. Sizing: compute the binding cap, then clamp or deny ---
  const equity = state.equityUsd;
  const currentPos = state.positions[proposal.asset] ?? 0;
  const caps: Array<{ code: ViolationCode; cap: number }> = [];

  caps.push({ code: "ABOVE_MAX_TRADE", cap: c.perTrade.maxTradeUsd });
  if (proposal.side === "buy") {
    caps.push({ code: "INSUFFICIENT_RESERVE", cap: state.reserveUsd });
    caps.push({
      code: "CONCENTRATION_EXCEEDED",
      cap: (c.portfolio.maxConcentrationPctPerAsset / 100) * equity - currentPos,
    });
    caps.push({
      code: "EXPOSURE_EXCEEDED",
      cap: (c.portfolio.maxPortfolioExposurePct / 100) * equity - totalNonReserveExposureUsd(state),
    });
  } else {
    caps.push({ code: "INSUFFICIENT_POSITION", cap: currentPos });
    if (proposal.asset === c.nativeAsset && c.portfolio.minNativeGasReserveUsd != null) {
      caps.push({ code: "NATIVE_GAS_RESERVE", cap: currentPos - c.portfolio.minNativeGasReserveUsd });
    }
  }

  const binding = caps.reduce((min, cur) => (cur.cap < min.cap ? cur : min));
  const bindingCap = Math.max(0, binding.cap);

  if (proposal.sizeUsd < c.perTrade.minTradeUsd) {
    block({
      code: "BELOW_MIN_TRADE",
      severity: "block",
      message: "trade smaller than minimum (dust)",
      observed: proposal.sizeUsd,
      limit: c.perTrade.minTradeUsd,
    });
    return deny({ proposal, now, violations, adjustments, audit, engageKill, killReason });
  }

  let effectiveSize = proposal.sizeUsd;

  if (proposal.sizeUsd > bindingCap) {
    if (!c.enforcement.clampOversizedTrades) {
      block({
        code: binding.code,
        severity: "block",
        message: "trade exceeds binding limit and clamping is disabled",
        observed: proposal.sizeUsd,
        limit: round2(bindingCap),
      });
      return deny({ proposal, now, violations, adjustments, audit, engageKill, killReason });
    }
    if (bindingCap < c.perTrade.minTradeUsd) {
      // Can't shrink enough to be worth doing.
      block({
        code: "UNCLAMPABLE",
        severity: "block",
        message: `binding limit (${binding.code}) leaves room below minTradeUsd`,
        observed: round2(bindingCap),
        limit: c.perTrade.minTradeUsd,
      });
      return deny({ proposal, now, violations, adjustments, audit, engageKill, killReason });
    }
    effectiveSize = floor2(bindingCap);
    adjustments.push({ reason: binding.code, field: "sizeUsd", from: proposal.sizeUsd, to: effectiveSize });
    audit.push(`~ CLAMP sizeUsd ${proposal.sizeUsd} -> ${effectiveSize} (${binding.code})`);
  } else {
    pass(`size ${proposal.sizeUsd} within binding cap ${round2(bindingCap)} (${binding.code})`);
  }

  const effectiveProposal: TradeProposal = { ...proposal, sizeUsd: effectiveSize };
  audit.push(`ALLOW ${proposal.side} ${effectiveSize} USD of ${proposal.asset}`);

  return {
    allowed: true,
    decisionId: decisionId(proposal, now),
    evaluatedAt: now,
    proposal,
    effectiveProposal,
    violations,
    adjustments,
    engageKillSwitch: false,
    killSwitchReason: null,
    audit,
  };
}

function deny(args: {
  proposal: TradeProposal;
  now: string;
  violations: Violation[];
  adjustments: Adjustment[];
  audit: string[];
  engageKill: boolean;
  killReason: string | null;
}): PolicyDecision {
  args.audit.push(`DENY ${args.proposal.side} ${args.proposal.sizeUsd} USD of ${args.proposal.asset}`);
  return {
    allowed: false,
    decisionId: decisionId(args.proposal, args.now),
    evaluatedAt: args.now,
    proposal: args.proposal,
    effectiveProposal: null,
    violations: args.violations,
    adjustments: args.adjustments,
    engageKillSwitch: args.engageKill,
    killSwitchReason: args.killReason,
    audit: args.audit,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function floor2(n: number): number {
  return Math.floor((n + Number.EPSILON) * 100) / 100;
}

/** Stable, dependency-free id for a decision (FNV-1a over proposal + timestamp). */
function decisionId(proposal: TradeProposal, now: string): string {
  const input = `${now}|${proposal.asset}|${proposal.side}|${proposal.sizeUsd}|${proposal.proposedAt}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `dec_${(h >>> 0).toString(16).padStart(8, "0")}`;
}
